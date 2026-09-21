//! The computer-use surface: pointing, clicking, typing and looking.
//!
//! Every gesture goes through the session's input thread
//! ([`crate::input::AgentInput`]) — the same gates, the same display
//! targeting and the same release-on-revoke as the phone's own input — so Ask
//! can never do more with the Mac than the person's session allows.
//!
//! Perception is fused. One look is a screenshot (for a model that can see),
//! the accessibility elements that can be acted on, what is in front and what
//! has keyboard focus. The elements carry ids a model can point at instead of
//! guessing coordinates, and a model that cannot see works from the ids alone.
//!
//! Vendor-blind like the rest of the engine: a model's coordinate convention
//! arrives here as a [`Grid`], never as a provider.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use crate::agent::ax::{self, tree};
use crate::agent::executor::ocr;
use crate::agent::executor::vision::{self, Frame, Mark};
use crate::agent::executor::{AxExecutor, SharedDisplay};
use crate::agent::runner::{Executor, Observation, ReadElement, ScreenReading};
use crate::agent::security::{AxTarget, Hit, ScrollDirection, Target};
use crate::agent::Action;
use crate::input::agent_ops::{AgentOp, AgentReport};
use crate::input::AgentInput;

/// How a model states a point — see `llm::Grid`. Mirrored here so the engine
/// never depends on the provider layer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Grid {
    #[default]
    Pixels,
    Thousand,
}

/// What this run's model can use.
#[derive(Debug, Clone, Copy, Default)]
pub struct ComputerConfig {
    /// The model takes screenshots.
    pub vision: bool,
    pub grid: Grid,
    /// Draw numbered marks over targetable elements. Off for a model with a
    /// trained computer tool, which works from the plain screen.
    pub marks: bool,
}

/// Where the ids of words read off the screen start. Past any element id a
/// reading can hold, so a target is one or the other and never both.
const OCR_ID_BASE: usize = 100_000;

/// Most elements listed in one look. Enough for a busy window; past this the
/// list costs more than it helps, and the model can zoom or scroll.
const MAX_LISTED: usize = 120;

/// Settling bounds after an action: long enough for a page or a sheet to
/// appear, short enough that an animation does not stall the run.
const SETTLE_MIN: Duration = Duration::from_millis(150);
const SETTLE_MAX: Duration = Duration::from_millis(2500);
const SETTLE_MAX_QUICK: Duration = Duration::from_millis(900);
/// After launching an app or opening a URL.
const SETTLE_MAX_LAUNCH: Duration = Duration::from_millis(4000);
/// Poll interval while a newly focused app is publishing its AX identity.
const FOCUS_READ_RETRY: Duration = Duration::from_millis(100);

/// How far the pointer may drift between two of Ask's gestures before it
/// counts as a person moving the mouse, in points. Generous: a false takeover
/// stops a run the person wanted, and the event tap catches real movement
/// sooner anyway.
const DRIFT_POINTS: f64 = 12.0;

pub struct ComputerExecutor {
    pub(super) ax: AxExecutor,
    display: SharedDisplay,
    input: Option<AgentInput>,
    stop: Arc<AtomicBool>,
    config: ComputerConfig,
    /// Whether the next action ends with a look (see `Executor::set_observe`).
    observe: bool,
    /// The display the previous look was of, to call out a switch.
    last_looked: Option<Option<u32>>,
    /// Pixel size of the last screenshot the model was shown, for stating
    /// positions in its coordinates.
    last_image: Option<(u32, u32)>,
    /// Where Ask left the pointer, normalized — a person moving it since is a
    /// takeover.
    left_pointer: Option<(f64, f64)>,
    /// Set when a person used the Mac mid-run; the run is being stopped.
    taken_over: bool,
    /// Words read off the screen at the last look, and the display they were
    /// read on, for the runs where accessibility offered nothing to act on.
    /// They are targets like any element. The fingerprint binds them to the
    /// pixels that were read, not merely to the same display.
    words: Vec<(usize, [f64; 4])>,
    words_on: Option<u32>,
    words_screen: Option<u64>,
}

impl ComputerExecutor {
    pub fn new(
        display: SharedDisplay,
        input: Option<AgentInput>,
        stop: Arc<AtomicBool>,
        config: ComputerConfig,
    ) -> Self {
        ComputerExecutor {
            ax: AxExecutor::new(display.clone()),
            display,
            input,
            stop,
            config,
            observe: true,
            last_looked: None,
            last_image: None,
            left_pointer: None,
            taken_over: false,
            words: Vec::new(),
            words_on: None,
            words_screen: None,
        }
    }

    pub fn set_observe(&mut self, observe: bool) {
        self.observe = observe;
    }

    pub fn handles(action: &Action) -> bool {
        matches!(
            action,
            Action::ReadScreen
                | Action::Screenshot
                | Action::Zoom { .. }
                | Action::Wait { .. }
                | Action::CursorPosition
                | Action::MoveMouse { .. }
                | Action::Click { .. }
                | Action::Drag { .. }
                | Action::MouseDown { .. }
                | Action::MouseUp { .. }
                | Action::Scroll { .. }
                | Action::TypeText { .. }
                | Action::Key { .. }
                | Action::HoldKey { .. }
                | Action::SetValue { .. }
                | Action::AxPerform { .. }
        )
    }

    // ── resolution ─────────────────────────────────────────────────────

    /// The shared display's global rectangle in points.
    fn bounds(&self) -> [f64; 4] {
        #[cfg(target_os = "macos")]
        {
            let (x, y, w, h) = ax::macos::shared_display_bounds(self.display.get());
            [x, y, w, h]
        }
        #[cfg(not(target_os = "macos"))]
        {
            [0.0, 0.0, 1.0, 1.0]
        }
    }

    /// A target as a normalized point on the shared display.
    fn point_of(&self, target: &Target) -> Result<(f64, f64)> {
        match target {
            Target::Point { x, y } => Ok((*x, *y)),
            Target::Here => vision::pointer_in(self.bounds())
                .ok_or_else(|| anyhow!("the pointer is not on the shared screen")),
            // A word read off the screen. Same contract as an element: the
            // centre of what was seen, refused once the shared screen changed.
            Target::Element(id) if *id >= OCR_ID_BASE => {
                if self.words_on != self.display.get() {
                    bail!("the shared screen changed since that reading — look again");
                }
                let (_, [x, y, w, h]) = self
                    .words
                    .iter()
                    .find(|(i, _)| i == id)
                    .ok_or_else(|| anyhow!("[{id}] is not in the latest reading"))?;
                Ok((x + w / 2.0, y + h / 2.0))
            }
            Target::Element(id) => {
                let snapshot =
                    self.ax.last.as_ref().ok_or_else(|| {
                        anyhow!("no screen reading yet — look at the screen first")
                    })?;
                if self.ax.read_on != self.display.get() {
                    bail!("the shared screen changed since that reading — look again");
                }
                let node = snapshot
                    .nodes
                    .get(*id)
                    .ok_or_else(|| anyhow!("element [{id}] is not in the latest reading"))?;
                let frame = node.frame.ok_or_else(|| {
                    anyhow!(
                        "element [{id}] has no position on screen; use element_action with \
                         AXPress, or point at it by coordinate"
                    )
                })?;
                let [x, y, w, h] =
                    tree::normalized_frame(frame, snapshot.bounds).ok_or_else(|| {
                        anyhow!("element [{id}] is not on the shared screen; scroll it into view")
                    })?;
                Ok((x + w / 2.0, y + h / 2.0))
            }
        }
    }

    /// What is under a target, for the gate and the card.
    fn hit_at(&self, target: &Target) -> Option<Hit> {
        let (x, y) = self.point_of(target).ok()?;
        let [bx, by, bw, bh] = self.bounds();
        let info = ax::hit_test(bx + x * bw, by + y * bh)?;
        Some(to_hit(info, false))
    }

    /// Rectangles that words must not be taken from. What a person has typed
    /// is theirs, and a password field's contents most of all.
    fn fields(&self) -> Vec<[f64; 4]> {
        const FIELDS: &[&str] = &[
            "AXTextField",
            "AXTextArea",
            "AXSecureTextField",
            "AXSearchField",
            "AXComboBox",
        ];
        let Some(snapshot) = self.ax.last.as_ref() else {
            return Vec::new();
        };
        snapshot
            .nodes
            .iter()
            .filter(|n| FIELDS.contains(&n.role.as_str()))
            .filter_map(|n| tree::normalized_frame(n.frame?, snapshot.bounds))
            .collect()
    }

    /// What has keyboard focus, for typing and keys.
    fn focus_hit(&self) -> Option<Hit> {
        focus_of(ax::focus(), ax::secure_input_enabled())
    }

    /// Keyboard input is addressed to the focused element, not to a stable
    /// handle. Refuse to inject if that identity changed after the action was
    /// resolved; otherwise a user switch or an app transition could send the
    /// approved text/shortcut to a different surface.
    fn require_current_focus(&self, expected: Option<&Hit>) -> Result<()> {
        let current = self.focus_hit();
        if focus_is_current(expected, current.as_ref()) {
            Ok(())
        } else {
            bail!(
                "keyboard focus was not the same verified target when this action ran — look again"
            )
        }
    }

    /// What an element from the latest reading is, and whose it is.
    fn element_hit(&self, id: usize) -> (Option<AxTarget>, Option<Hit>) {
        let Some(snapshot) = self.ax.last.as_ref() else {
            return (None, None);
        };
        let target = tree::describe_by_id(&snapshot.nodes, id).map(|(r, l)| AxTarget::new(r, l));
        let hit = target.as_ref().map(|t| {
            let (protected, terminal) = ax::surface_of(&snapshot.path);
            Hit {
                element: Some(t.clone()),
                app: snapshot.app.clone(),
                own: snapshot.pid == std::process::id() as i32,
                protected: protected.map(str::to_string),
                secure: t.role == "AXSecureTextField"
                    || snapshot
                        .nodes
                        .get(id)
                        .and_then(|n| n.value.as_deref())
                        .is_some_and(|v| v == "‹password field›"),
                terminal,
            }
        });
        (target, hit)
    }

    /// Attach what an action would touch, before the gate sees it.
    pub fn resolve(&self, action: Action) -> Action {
        match action {
            Action::Click {
                target,
                button,
                count,
                modifiers,
                ..
            } => Action::Click {
                hit: self.hit_at(&target),
                target,
                button,
                count,
                modifiers,
            },
            Action::Drag {
                from,
                to,
                modifiers,
                ..
            } => Action::Drag {
                hit: self.hit_at(&from),
                hit_to: self.hit_at(&to),
                from,
                to,
                modifiers,
            },
            // Without a target they act where the pointer is, so that is what
            // is identified.
            Action::MouseDown { target, button, .. } => Action::MouseDown {
                hit: self.hit_at(target.as_ref().unwrap_or(&Target::Here)),
                target,
                button,
            },
            Action::MouseUp { target, button, .. } => Action::MouseUp {
                hit: self.hit_at(target.as_ref().unwrap_or(&Target::Here)),
                target,
                button,
            },
            Action::Scroll {
                target,
                direction,
                amount,
                modifiers,
                ..
            } => Action::Scroll {
                hit: self.hit_at(target.as_ref().unwrap_or(&Target::Here)),
                target,
                direction,
                amount,
                modifiers,
            },
            Action::TypeText { text, .. } => Action::TypeText {
                text,
                focus: self.focus_hit(),
            },
            Action::Key { chords, repeat, .. } => Action::Key {
                chords,
                repeat,
                focus: self.focus_hit(),
            },
            Action::HoldKey { chord, ms, .. } => Action::HoldKey {
                chord,
                ms,
                focus: self.focus_hit(),
            },
            Action::SetValue {
                element_id, text, ..
            } => {
                let (target, hit) = self.element_hit(element_id);
                Action::SetValue {
                    element_id,
                    text,
                    target,
                    hit,
                }
            }
            Action::AxPerform {
                element_id, action, ..
            } => {
                let (target, hit) = self.element_hit(element_id);
                Action::AxPerform {
                    element_id,
                    action,
                    target,
                    hit,
                }
            }
            other => other,
        }
    }

    // ── acting ─────────────────────────────────────────────────────────

    async fn perform(&mut self, op: AgentOp) -> Result<AgentReport> {
        let Some(input) = self.input.clone() else {
            bail!("this session cannot control the Mac's mouse and keyboard");
        };
        let report = input.perform(op, Arc::clone(&self.stop)).await?;
        // Unknown (off the shared display) is recorded as unknown, so a stale
        // position is never compared against.
        self.left_pointer = report.cursor;
        Ok(report)
    }

    /// A person moving the pointer since Ask last left it is taking over.
    /// Checked before every gesture: the event tap (when macOS allows one)
    /// catches it sooner, and this catches it when it does not.
    fn someone_moved_the_mouse(&self) -> bool {
        let (Some(left), Some(now)) = (self.left_pointer, vision::pointer_in(self.bounds())) else {
            return false;
        };
        let [_, _, w, h] = self.bounds();
        let (dx, dy) = ((now.0 - left.0) * w, (now.1 - left.1) * h);
        (dx * dx + dy * dy).sqrt() > DRIFT_POINTS
    }

    /// Carry out one gesture-type action. `Ok` is what happened in words.
    async fn act(&mut self, action: &Action) -> Result<String> {
        if self.someone_moved_the_mouse() {
            self.taken_over = true;
            self.stop.store(true, Ordering::SeqCst);
            bail!("stopped — someone moved the mouse at the Mac, so Ask handed control back");
        }
        match action {
            Action::MoveMouse { to } => {
                let at = self.point_of(to)?;
                self.perform(AgentOp::Move { to: at }).await?;
                Ok("moved the pointer".into())
            }
            Action::Click {
                target,
                button,
                count,
                modifiers,
                hit,
            } => {
                if matches!(target, Target::Element(id) if *id >= OCR_ID_BASE) {
                    let expected = self.words_screen.ok_or_else(|| {
                        anyhow!("the screen reading is no longer current — look again")
                    })?;
                    let display = self.display.get();
                    let current = tokio::task::spawn_blocking(move || {
                        vision::grab(display).map(|frame| frame.fingerprint())
                    })
                    .await??;
                    if current != expected {
                        bail!("the screen changed since those words were read — look again");
                    }
                }
                let at = self.point_of(target)?;
                // The approval named what was under the point. If something
                // else is there now — a page that moved, a dialog that
                // appeared — this is a different click (L-272's rule, for
                // points).
                if let Some(approved) = hit.as_ref().and_then(|h| h.element.as_ref()) {
                    match self.hit_at(target).and_then(|h| h.element) {
                        Some(now) if &now == approved => {}
                        Some(now) => bail!(
                            "what is under that point changed since this click was chosen \
                             (it was {:?}, now {:?}) — look again",
                            approved.label,
                            now.label
                        ),
                        None => bail!(
                            "the control approved at that point can no longer be identified — \
                             look again"
                        ),
                    }
                }
                self.perform(AgentOp::Click {
                    at,
                    button: *button,
                    count: *count,
                    modifiers: modifiers.clone(),
                })
                .await?;
                Ok("clicked".into())
            }
            Action::Drag {
                from,
                to,
                modifiers,
                ..
            } => {
                let (from, to) = (self.point_of(from)?, self.point_of(to)?);
                self.perform(AgentOp::Drag {
                    from,
                    to,
                    modifiers: modifiers.clone(),
                })
                .await?;
                Ok("dragged".into())
            }
            Action::MouseDown { target, button, .. } => {
                let at = target.as_ref().map(|t| self.point_of(t)).transpose()?;
                self.perform(AgentOp::MouseDown {
                    at,
                    button: *button,
                })
                .await?;
                Ok("pressed and holding the mouse button".into())
            }
            Action::MouseUp { target, button, .. } => {
                let at = target.as_ref().map(|t| self.point_of(t)).transpose()?;
                self.perform(AgentOp::MouseUp {
                    at,
                    button: *button,
                })
                .await?;
                Ok("released the mouse button".into())
            }
            Action::Scroll {
                target,
                direction,
                amount,
                modifiers,
                ..
            } => {
                let at = target.as_ref().map(|t| self.point_of(t)).transpose()?;
                let n = *amount as i32;
                let (dx, dy) = match direction {
                    ScrollDirection::Up => (0, -n),
                    ScrollDirection::Down => (0, n),
                    ScrollDirection::Left => (-n, 0),
                    ScrollDirection::Right => (n, 0),
                };
                self.perform(AgentOp::Scroll {
                    at,
                    dx,
                    dy,
                    modifiers: modifiers.clone(),
                })
                .await?;
                Ok("scrolled".into())
            }
            Action::TypeText { text, focus } => {
                // Keep the old direct-executor error for perception-only
                // instances used in tests and in non-control sessions.
                if self.input.is_some() {
                    self.require_current_focus(focus.as_ref())?;
                }
                self.perform(AgentOp::Type { text: text.clone() }).await?;
                Ok(format!("typed {} characters", text.chars().count()))
            }
            Action::Key {
                chords,
                repeat,
                focus,
            } => {
                if self.input.is_some() {
                    self.require_current_focus(focus.as_ref())?;
                }
                self.perform(AgentOp::Keys {
                    chords: chords.clone(),
                    repeat: *repeat,
                })
                .await?;
                Ok("pressed".into())
            }
            Action::HoldKey { chord, ms, focus } => {
                if self.input.is_some() {
                    self.require_current_focus(focus.as_ref())?;
                }
                self.perform(AgentOp::HoldKeys {
                    chord: chord.clone(),
                    ms: *ms,
                })
                .await?;
                Ok("held and released".into())
            }
            Action::SetValue {
                element_id, text, ..
            } => {
                self.element_effect(*element_id, |handle| ax::set_value(handle, text))?;
                Ok("set the value".into())
            }
            Action::AxPerform {
                element_id, action, ..
            } => {
                self.element_effect(*element_id, |handle| ax::perform(handle, action))?;
                Ok(format!("performed {action}"))
            }
            other => bail!("not a computer action: {other:?}"),
        }
    }

    /// Run an accessibility effect on an element from the latest reading.
    fn element_effect(
        &self,
        id: usize,
        effect: impl FnOnce(&ax::AxHandle) -> Result<()>,
    ) -> Result<()> {
        let snapshot = self
            .ax
            .last
            .as_ref()
            .ok_or_else(|| anyhow!("no screen reading yet — look at the screen first"))?;
        if self.ax.read_on != self.display.get() {
            bail!("the shared screen changed since that reading — look again");
        }
        let handle = snapshot
            .handle(id)
            .ok_or_else(|| anyhow!("element [{id}] is not in the latest reading"))?;
        effect(handle)
    }

    // ── looking ────────────────────────────────────────────────────────

    /// Take a fused look: settle, screenshot, read the elements.
    async fn look(&mut self, settle_max: Duration) -> Observation {
        let target = self.display.get();
        let settle_started = std::time::Instant::now();
        let changed = matches!(self.last_looked, Some(prev) if prev != target);
        self.last_looked = Some(target);

        let min = if settle_max.is_zero() {
            Duration::ZERO
        } else {
            SETTLE_MIN
        };
        // A model that cannot see is never sent a picture, so none is taken:
        // it needs neither the Screen Recording grant nor the capture time.
        let frame = if self.config.vision {
            match tokio::task::spawn_blocking(move || vision::settle(target, min, settle_max)).await
            {
                Ok(Ok(frame)) => Some(frame),
                Ok(Err(e)) => {
                    return Observation::fail(format!(
                        "Could not see {}: {e}",
                        vision::display_name(target)
                    ))
                }
                Err(e) => return Observation::fail(format!("the screen capture stopped: {e}")),
            }
        } else {
            tokio::time::sleep(min * 2).await;
            None
        };

        // The element reading. A failure here is not a failure to see — the
        // screenshot still stands — so it is reported, not returned.
        let reading_budget = settle_max.saturating_sub(settle_started.elapsed());
        let reading = self.read_with_settle(reading_budget).await;

        let bounds = frame
            .as_ref()
            .map(|f| f.bounds)
            .unwrap_or_else(|| self.bounds());
        let pointer = vision::pointer_in(bounds);
        let listed: Vec<(usize, [f64; 4])> = match (&reading, self.ax.last.as_ref()) {
            (Ok(()), Some(snapshot)) => tree::on_screen_actionable(&snapshot.nodes, bounds)
                .into_iter()
                .take(MAX_LISTED)
                .map(|(n, rect)| (n.id, rect))
                .collect(),
            _ => Vec::new(),
        };

        let image = match (&frame, self.config.vision) {
            (Some(frame), true) => {
                let marks: Vec<Mark> = if self.config.marks {
                    listed
                        .iter()
                        .map(|(id, rect)| Mark {
                            id: *id,
                            rect: *rect,
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                match vision::render(frame, pointer, &marks) {
                    Ok(image) => Some(image),
                    Err(e) => {
                        return Observation::fail(format!(
                            "the screenshot could not be encoded: {e}"
                        ))
                    }
                }
            }
            _ => None,
        };
        if let Some(image) = &image {
            self.last_image = Some((image.width, image.height));
        }

        let mut structured = match (&reading, self.ax.last.as_ref()) {
            (Ok(()), Some(snapshot)) => Some(screen_reading(snapshot, &listed)),
            _ => None,
        };
        // Accessibility offered nothing to act on — an Electron window, a
        // canvas, a game, a screen shared from another machine, or a reading
        // that failed outright. A model that is never sent a picture has no
        // other input, so the task used to end here (L-369). Read the words
        // on the screen instead, on this Mac (ADR-0021).
        //
        // Only for that model: one that can see already has the picture, and
        // this costs a capture and a second of recognition.
        self.words.clear();
        self.words_on = target;
        self.words_screen = None;
        if !self.config.vision && reading.is_ok() && listed.is_empty() {
            let found = tokio::task::spawn_blocking(move || {
                let frame = vision::grab(target)?;
                let fingerprint = frame.fingerprint();
                ocr::read(&frame).map(|words| (words, fingerprint))
            })
            .await;
            match found {
                Ok(Ok((words, fingerprint))) => {
                    let named = ocr::labels(words, &self.fields());
                    if !named.is_empty() {
                        log::info!(
                            target: "lilypad::agent",
                            "accessibility listed nothing; read {} names off the screen",
                            named.len(),
                        );
                        self.words = named
                            .iter()
                            .enumerate()
                            .map(|(i, w)| (OCR_ID_BASE + i, w.rect))
                            .collect();
                        self.words_screen = Some(fingerprint);
                        let base = structured
                            .as_ref()
                            .expect("a successful accessibility read has a screen reading");
                        structured = Some(words_reading(base, &named, &self.words));
                    }
                }
                Ok(Err(e)) => {
                    log::warn!(target: "lilypad::agent", "could not read the screen's words: {e}")
                }
                Err(e) => {
                    log::warn!(target: "lilypad::agent", "reading the screen's words stopped: {e}")
                }
            }
        }
        // Said once, out loud. A run that cannot read the screen is the one
        // failure a customer's log has to explain, and until this line it
        // recorded nothing at all.
        let reading_error = match (&reading, structured.is_some()) {
            (Err(e), _) => Some(e.clone()),
            (Ok(()), false) => Some("the reading arrived empty".to_string()),
            _ => None,
        };
        if let Some(e) = &reading_error {
            log::warn!(target: "lilypad::agent", "screen reading failed: {e}");
        }
        let text = self.describe_screen(
            target,
            changed,
            image.as_ref().map(|i| (i.width, i.height)),
            pointer,
            &listed,
            reading.err(),
        );
        Observation {
            summary: text,
            ok: true,
            screen: frame.as_ref().map(Frame::fingerprint),
            image,
            reading: structured,
            reading_error,
        }
    }

    /// A launch can briefly leave the system with no focused AX application
    /// (or with the app's window not yet on the shared display). Retry only
    /// those transient focus states, and only inside the caller's bounded
    /// settle budget. Permission and tree failures remain immediate.
    async fn read_with_settle(&mut self, budget: Duration) -> std::result::Result<(), String> {
        let mut error = match self.ax.read().await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if budget.is_zero() || !retryable_focus_read_error(&error) {
            return Err(error);
        }
        let deadline = std::time::Instant::now() + budget;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(error);
            }
            tokio::time::sleep(FOCUS_READ_RETRY.min(remaining)).await;
            error = match self.ax.read().await {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };
            if !retryable_focus_read_error(&error) {
                return Err(error);
            }
        }
    }

    /// A normalized point in the model's coordinates.
    fn in_model_space(&self, (x, y): (f64, f64)) -> Option<[i64; 2]> {
        match self.config.grid {
            Grid::Thousand => Some([(x * 1000.0).round() as i64, (y * 1000.0).round() as i64]),
            Grid::Pixels => {
                let (w, h) = self.last_image?;
                Some([
                    (x * f64::from(w)).round() as i64,
                    (y * f64::from(h)).round() as i64,
                ])
            }
        }
    }

    fn describe_screen(
        &self,
        target: Option<u32>,
        changed: bool,
        image: Option<(u32, u32)>,
        pointer: Option<(f64, f64)>,
        listed: &[(usize, [f64; 4])],
        reading_error: Option<String>,
    ) -> String {
        let mut out = String::new();
        out.push_str(vision::staleness_note(changed));
        match image {
            Some((w, h)) => {
                let space = match self.config.grid {
                    Grid::Pixels => format!("coordinates are pixels of this {w}×{h} image"),
                    Grid::Thousand => "coordinates are on the 0–1000 grid".to_string(),
                };
                out.push_str(&format!(
                    "Screenshot of {} ({space}).",
                    vision::display_name(target)
                ));
            }
            None => out.push_str(&format!(
                "Reading of {} (no screenshot for this model; act on elements by id).",
                vision::display_name(target)
            )),
        }
        if let Some(p) = pointer.and_then(|p| self.in_model_space(p)) {
            if image.is_some() {
                out.push_str(&format!(" The pointer is at [{}, {}].", p[0], p[1]));
            }
        }
        out.push('\n');
        if let Some(snapshot) = self.ax.last.as_ref().filter(|_| reading_error.is_none()) {
            let window = snapshot
                .window
                .as_deref()
                .map(|w| format!(" — \u{201c}{}\u{201d}", tree::clip(w)))
                .unwrap_or_default();
            out.push_str(&format!("In front: {}{window}.", snapshot.app));
            if let Some(f) = snapshot.nodes.iter().find(|n| n.focused) {
                out.push_str(&format!(
                    " Keyboard focus: [{}] {}{}.",
                    f.id,
                    f.role.trim_start_matches("AX"),
                    f.label
                        .as_deref()
                        .map(|l| format!(" \u{201c}{}\u{201d}", tree::clip(l)))
                        .unwrap_or_default()
                ));
            }
            out.push('\n');
            out.push_str(tree::ELEMENTS_HEADING);
            out.push_str(" (id, role, label = value");
            if image.is_some() {
                out.push_str(", centre");
            }
            out.push_str("):\n");
            if listed.is_empty() {
                out.push_str("(none found in the focused app on this screen)\n");
            }
            for (id, rect) in listed {
                let Some(node) = snapshot.nodes.get(*id) else {
                    continue;
                };
                out.push_str(&format!("[{id}] {}", node.role.trim_start_matches("AX")));
                if let Some(l) = node.label.as_deref().filter(|l| !l.is_empty()) {
                    out.push_str(&format!(" \u{201c}{}\u{201d}", tree::clip(l)));
                }
                if let Some(v) = node.value.as_deref().filter(|v| !v.is_empty()) {
                    out.push_str(&format!(" = {}", tree::clip(v)));
                }
                if image.is_some() {
                    if let Some([x, y]) =
                        self.in_model_space((rect[0] + rect[2] / 2.0, rect[1] + rect[3] / 2.0))
                    {
                        out.push_str(&format!(" at [{x}, {y}]"));
                    }
                }
                if node.focused {
                    out.push_str(" (focused)");
                }
                out.push('\n');
            }
            // A model that cannot see needs the words on the screen too, not
            // just the controls.
            if image.is_none() {
                out.push_str("\nEverything in the window:\n");
                out.push_str(&tree::serialize(&snapshot.nodes));
            }
        } else if let Some(e) = reading_error {
            out.push_str(&format!(
                "The accessibility elements could not be read ({e}); point by coordinate.\n"
            ));
        }
        out
    }

    async fn after(&mut self, head: Result<String>, settle: Duration) -> Observation {
        match head {
            Ok(done) => {
                if !self.observe {
                    // More of the same reply follows. Still let the screen
                    // catch up before the next gesture lands on it.
                    tokio::time::sleep(SETTLE_MIN).await;
                    return Observation::ok(format!("{done}."));
                }
                let mut look = self.look(settle).await;
                look.summary = format!("{done}. {}", look.summary);
                look
            }
            Err(e) => {
                let mut fail = Observation::fail(format!("{e}"));
                if self.taken_over {
                    return fail;
                }
                // A failure is always shown with the screen, whatever the
                // batch — the model has to see why.
                let look = self.look(SETTLE_MAX_QUICK).await;
                if look.ok {
                    fail.summary = format!("{}\n{}", fail.summary, look.summary);
                    fail.image = look.image;
                    fail.screen = look.screen;
                    fail.reading = look.reading;
                }
                fail
            }
        }
    }

    /// Add a look to an observation from another tier (an app launch, a
    /// URL), so the model sees what it did.
    pub async fn observe_after(&mut self, obs: Observation) -> Observation {
        if !self.observe && obs.ok {
            return obs;
        }
        let look = self.look(SETTLE_MAX_LAUNCH).await;
        if !look.ok {
            return obs;
        }
        Observation {
            summary: format!("{}\n{}", obs.summary, look.summary),
            image: look.image,
            screen: look.screen,
            ..obs
        }
    }

    /// Let go of anything a `left_mouse_down` left held.
    pub async fn release(&mut self) {
        if let Some(input) = self.input.clone() {
            let _ = input
                .perform(AgentOp::ReleaseHeld, Arc::new(AtomicBool::new(false)))
                .await;
        }
    }
}

/// The listed elements as structure: what a step that chooses among them
/// needs, and nothing it does not — no values, no positions. An element with
/// no label cannot be asked for by name, so it is left out.
fn screen_reading(snapshot: &ax::AxSnapshot, listed: &[(usize, [f64; 4])]) -> ScreenReading {
    let elements = listed
        .iter()
        .filter_map(|(id, rect)| {
            let node = snapshot.nodes.get(*id)?;
            let label = node
                .label
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())?;
            Some(ReadElement {
                id: *id,
                role: role_in_words(&node.role),
                label: tree::clip(label),
                at: Some(coarse(*rect)),
            })
        })
        .collect();
    ScreenReading {
        app: snapshot.app.clone(),
        // What has the keyboard, named the way a listed control is.
        focused: snapshot.nodes.iter().find(|n| n.focused).map(|n| {
            match n.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
                Some(label) => format!(
                    "{} \u{201c}{}\u{201d}",
                    role_in_words(&n.role),
                    tree::clip(label)
                ),
                None => role_in_words(&n.role),
            }
        }),
        // The first root is the front window on the shared screen.
        window: snapshot
            .nodes
            .first()
            .filter(|n| n.depth == 0 && n.frame.is_some())
            .map(|n| n.id),
        elements,
    }
}

/// A screen made of the words on it: what a model with no picture gets when
/// the app in front exposes no controls at all. Every word is a target, by an
/// id that continues past the element ids.
fn words_reading(
    base: &ScreenReading,
    named: &[ocr::Word],
    ids: &[(usize, [f64; 4])],
) -> ScreenReading {
    ScreenReading {
        app: base.app.clone(),
        focused: base.focused.clone(),
        window: base.window,
        elements: named
            .iter()
            .zip(ids)
            .map(|(w, (id, rect))| ReadElement {
                id: *id,
                // This source marker is also the privacy boundary in the
                // hosted brain: raw screen text is never placed in a request.
                role: "screen text".into(),
                label: tree::clip(w.text.trim()),
                at: Some(coarse(*rect)),
            })
            .collect(),
    }
}

/// Roughly where a control sits on the shared screen, from its normalized
/// rectangle. Thirds, in the words a person would use: enough to separate two
/// controls with the same name, not enough to aim at.
fn coarse(rect: [f64; 4]) -> String {
    fn third(v: f64, names: [&str; 3]) -> &str {
        names[((v * 3.0).floor().max(0.0) as usize).min(2)]
    }
    let [x, y, w, h] = rect;
    format!(
        "{} {}",
        third(y + h / 2.0, ["top", "middle", "bottom"]),
        third(x + w / 2.0, ["left", "centre", "right"]),
    )
}

/// "AXPopUpButton" → "pop up button".
fn role_in_words(role: &str) -> String {
    let mut out = String::new();
    for ch in role.trim_start_matches("AX").chars() {
        if ch.is_uppercase() && !out.is_empty() {
            out.push(' ');
        }
        out.extend(ch.to_lowercase());
    }
    out
}

/// What has the keyboard. When the focused element cannot be read, macOS
/// secure keyboard input is still a fact about the whole session — a password
/// field has the keyboard somewhere — so typing is refused on that alone.
fn focus_of(info: Option<ax::HitInfo>, secure_input: bool) -> Option<Hit> {
    match info {
        Some(info) => Some(to_hit(info, secure_input)),
        None if secure_input => Some(Hit {
            secure: true,
            ..Hit::default()
        }),
        None => None,
    }
}

fn focus_is_current(expected: Option<&Hit>, current: Option<&Hit>) -> bool {
    expected.is_some() && expected == current
}

fn retryable_focus_read_error(error: &str) -> bool {
    error.starts_with("no focused application")
        || error.starts_with("the focused app has no window on the shared display")
}

fn to_hit(info: ax::HitInfo, secure_input: bool) -> Hit {
    let (protected, terminal) = ax::surface_of(&info.path);
    Hit {
        element: Some(AxTarget::new(info.role.clone(), info.label.clone())),
        app: info.app,
        own: info.pid == std::process::id() as i32,
        protected: protected.map(str::to_string),
        secure: info.secure || secure_input,
        terminal,
    }
}

impl Executor for ComputerExecutor {
    async fn execute(&mut self, action: &Action) -> Result<Observation> {
        match action {
            Action::ReadScreen | Action::Screenshot => Ok(self.look(Duration::ZERO).await),
            Action::Zoom { region } => {
                let target = self.display.get();
                let region = *region;
                let frame = tokio::task::spawn_blocking(move || vision::grab(target)).await?;
                Ok(match frame.and_then(|f| vision::zoom(&f, region)) {
                    Ok(image) => Observation {
                        summary: "A closer look at that region (coordinates still refer to the \
                                  full screenshot)."
                            .into(),
                        ok: true,
                        image: Some(image),
                        screen: None,
                        reading: None,
                        reading_error: None,
                    },
                    Err(e) => Observation::fail(format!("Could not zoom: {e}")),
                })
            }
            Action::Wait { ms } => {
                tokio::time::sleep(Duration::from_millis(*ms)).await;
                Ok(self.after(Ok("waited".into()), SETTLE_MAX_QUICK).await)
            }
            Action::CursorPosition => {
                let at = vision::pointer_in(self.bounds());
                Ok(match at.and_then(|p| self.in_model_space(p)) {
                    Some([x, y]) => Observation::ok(format!("The pointer is at [{x}, {y}].")),
                    None if at.is_some() => Observation::ok(
                        "The pointer is on the shared screen; take a screenshot to see where.",
                    ),
                    None => Observation::ok("The pointer is not on the shared screen."),
                })
            }
            other => {
                let head = self.act(other).await;
                let settle = match other {
                    Action::MoveMouse { .. } | Action::HoldKey { .. } => SETTLE_MAX_QUICK,
                    _ => SETTLE_MAX,
                };
                Ok(self.after(head, settle).await)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executor(grid: Grid) -> ComputerExecutor {
        ComputerExecutor::new(
            SharedDisplay::default(),
            None,
            Arc::new(AtomicBool::new(false)),
            ComputerConfig {
                vision: true,
                grid,
                marks: true,
            },
        )
    }

    /// The screen an agent is blind to. Every word is a target with an id of
    /// its own, and nothing about the rest of the pipeline changes.
    #[test]
    fn words_read_off_the_screen_are_targets_like_any_element() {
        let named = vec![
            ocr::Word {
                text: "  Continue  ".into(),
                rect: [0.4, 0.8, 0.2, 0.05],
            },
            ocr::Word {
                text: "Cancel".into(),
                rect: [0.1, 0.8, 0.1, 0.05],
            },
        ];
        let ids: Vec<(usize, [f64; 4])> = named
            .iter()
            .enumerate()
            .map(|(i, w)| (OCR_ID_BASE + i, w.rect))
            .collect();
        let base = ScreenReading {
            app: "Figma".into(),
            focused: Some("group \u{201c}Canvas\u{201d}".into()),
            window: Some(4),
            elements: Vec::new(),
        };
        let reading = words_reading(&base, &named, &ids);
        assert_eq!(reading.app, "Figma");
        assert_eq!(
            reading.focused.as_deref(),
            Some("group \u{201c}Canvas\u{201d}")
        );
        assert_eq!(reading.window, Some(4));
        assert_eq!(reading.elements[0].id, OCR_ID_BASE);
        assert_eq!(reading.elements[0].role, "screen text");
        assert_eq!(reading.elements[0].label, "Continue");
        assert_eq!(reading.elements[0].at.as_deref(), Some("bottom centre"));

        // And the id resolves to the middle of what was read. The synchronous
        // part rejects display changes; `act` additionally binds a click to
        // the captured pixels before input reaches the Mac.
        let mut ex = executor(Grid::Pixels);
        ex.words = ids;
        ex.words_on = ex.display.get();
        let (x, y) = ex.point_of(&Target::Element(OCR_ID_BASE)).unwrap();
        assert!(
            (x - 0.5).abs() < 1e-9 && (y - 0.825).abs() < 1e-9,
            "{x}, {y}"
        );
        ex.display.set(Some(7));
        let err = ex
            .point_of(&Target::Element(OCR_ID_BASE))
            .unwrap_err()
            .to_string();
        assert!(err.contains("changed"), "{err}");
    }

    /// OCR enriches a successful accessibility read; it must not replace the
    /// app identity that keeps Ask out of Lilypad itself.
    #[test]
    fn screen_words_preserve_the_accessibility_identity() {
        let base = ScreenReading {
            app: "Lilypad".into(),
            focused: None,
            window: Some(2),
            elements: Vec::new(),
        };
        let reading = words_reading(&base, &[], &[]);
        assert_eq!(reading, base);
    }

    /// What a person typed is theirs, so the rectangles words may not be read
    /// from are every kind of field — a password field above all.
    #[test]
    fn every_kind_of_field_is_off_limits_to_the_reader() {
        let mut ex = executor(Grid::Pixels);
        let nodes = vec![
            tree::AxNode {
                id: 0,
                role: "AXWindow".into(),
                frame: Some([0.0, 0.0, 1000.0, 500.0]),
                ..Default::default()
            },
            tree::AxNode {
                id: 1,
                depth: 1,
                role: "AXSecureTextField".into(),
                frame: Some([100.0, 50.0, 200.0, 20.0]),
                ..Default::default()
            },
            tree::AxNode {
                id: 2,
                depth: 1,
                role: "AXButton".into(),
                label: Some("Sign in".into()),
                frame: Some([100.0, 100.0, 80.0, 20.0]),
                ..Default::default()
            },
        ];
        let mut snapshot = ax::AxSnapshot::for_test(nodes);
        snapshot.bounds = [0.0, 0.0, 1000.0, 500.0];
        ex.ax.last = Some(snapshot);
        let fields = ex.fields();
        assert_eq!(fields.len(), 1, "the field, not the button");
        let close = fields[0]
            .iter()
            .zip([0.1, 0.1, 0.2, 0.04])
            .all(|(got, want)| (got - want).abs() < 1e-9);
        assert!(close, "{:?}", fields[0]);
        // With nothing read yet there is nothing to protect, and nothing is
        // claimed to be safe either.
        ex.ax.last = None;
        assert!(ex.fields().is_empty());
    }

    #[test]
    fn positions_are_stated_in_the_models_own_coordinates() {
        let mut ex = executor(Grid::Pixels);
        assert_eq!(ex.in_model_space((0.5, 0.5)), None, "no screenshot yet");
        ex.last_image = Some((1331, 864));
        assert_eq!(ex.in_model_space((0.5, 0.25)), Some([666, 216]));
        let ex = executor(Grid::Thousand);
        assert_eq!(ex.in_model_space((0.5, 0.25)), Some([500, 250]));
    }

    #[test]
    fn an_element_target_needs_a_reading_with_a_position() {
        let mut ex = executor(Grid::Pixels);
        let err = ex.point_of(&Target::Element(3)).unwrap_err().to_string();
        assert!(err.contains("look at the screen first"), "{err}");

        let mut nodes = vec![
            tree::AxNode {
                id: 0,
                role: "AXWindow".into(),
                ..Default::default()
            },
            tree::AxNode {
                id: 1,
                depth: 1,
                role: "AXButton".into(),
                label: Some("Send".into()),
                pressable: true,
                frame: Some([100.0, 50.0, 100.0, 50.0]),
                ..Default::default()
            },
            tree::AxNode {
                id: 2,
                depth: 1,
                role: "AXButton".into(),
                label: Some("Hidden".into()),
                pressable: true,
                ..Default::default()
            },
        ];
        nodes[0].frame = Some([0.0, 0.0, 1000.0, 500.0]);
        let mut snapshot = ax::AxSnapshot::for_test(nodes);
        snapshot.bounds = [0.0, 0.0, 1000.0, 500.0];
        ex.ax.last = Some(snapshot);
        ex.ax.read_on = ex.display.get();

        let (x, y) = ex.point_of(&Target::Element(1)).unwrap();
        assert!(
            (x - 0.15).abs() < 1e-9 && (y - 0.15).abs() < 1e-9,
            "{x}, {y}"
        );
        let err = ex.point_of(&Target::Element(2)).unwrap_err().to_string();
        assert!(err.contains("no position"), "{err}");
        let err = ex.point_of(&Target::Element(9)).unwrap_err().to_string();
        assert!(err.contains("not in the latest reading"), "{err}");

        // A display switch retires the reading.
        ex.display.set(Some(4));
        let err = ex.point_of(&Target::Element(1)).unwrap_err().to_string();
        assert!(err.contains("changed"), "{err}");
    }

    #[test]
    fn the_screen_description_lists_elements_with_ids_and_centres() {
        let mut ex = executor(Grid::Pixels);
        ex.last_image = Some((1000, 500));
        let mut nodes = vec![
            tree::AxNode {
                id: 0,
                role: "AXWindow".into(),
                label: Some("Inbox".into()),
                ..Default::default()
            },
            tree::AxNode {
                id: 1,
                depth: 1,
                role: "AXTextField".into(),
                label: Some("To".into()),
                value: Some("rae@example.com".into()),
                frame: Some([0.0, 0.0, 200.0, 20.0]),
                focused: true,
                ..Default::default()
            },
        ];
        nodes[0].frame = Some([0.0, 0.0, 1000.0, 500.0]);
        let mut snapshot = ax::AxSnapshot::for_test(nodes);
        snapshot.bounds = [0.0, 0.0, 1000.0, 500.0];
        snapshot.app = "Mail".into();
        snapshot.window = Some("Inbox".into());
        ex.ax.last = Some(snapshot);
        let listed = vec![(1usize, [0.0, 0.0, 0.2, 0.04])];
        let text = ex.describe_screen(
            None,
            false,
            Some((1000, 500)),
            Some((0.5, 0.5)),
            &listed,
            None,
        );
        assert!(text.contains("pixels of this 1000×500 image"), "{text}");
        assert!(text.contains("The pointer is at [500, 250]"), "{text}");
        assert!(
            text.contains("In front: Mail — \u{201c}Inbox\u{201d}"),
            "{text}"
        );
        assert!(text.contains("Keyboard focus: [1] TextField"), "{text}");
        assert!(
            text.contains(
                "[1] TextField \u{201c}To\u{201d} = rae@example.com at [100, 10] (focused)"
            ),
            "{text}"
        );
        // The pruner recognizes it as a reading.
        assert!(text.contains(tree::ELEMENTS_HEADING));

        // A model that cannot see gets ids and the window's words, no
        // coordinates.
        let text = ex.describe_screen(None, false, None, Some((0.5, 0.5)), &listed, None);
        assert!(text.contains("no screenshot"), "{text}");
        assert!(!text.contains(" at ["), "{text}");
        assert!(text.contains("Everything in the window"), "{text}");
    }

    #[test]
    fn secure_keyboard_input_refuses_typing_even_when_focus_cannot_be_read() {
        use crate::agent::security::{floor, Action};
        let typing = |focus| Action::TypeText {
            text: "hunter2".into(),
            focus,
        };
        // The focused element could not be read, but secure input is on.
        let focus = focus_of(None, true);
        assert!(focus.as_ref().is_some_and(|h| h.secure));
        assert!(floor(&typing(focus)).is_some());
        // Nothing known and nothing secure: nothing for the floor to refuse.
        assert_eq!(focus_of(None, false), None);
        // A readable focus carries secure input too.
        let field = ax::HitInfo {
            role: "AXTextField".into(),
            app: "Safari".into(),
            ..Default::default()
        };
        assert!(focus_of(Some(field.clone()), true).is_some_and(|h| h.secure));
        assert!(focus_of(Some(field), false).is_some_and(|h| !h.secure));
    }

    #[test]
    fn keyboard_actions_require_the_same_verified_focus() {
        let field = Hit {
            element: Some(AxTarget::new("AXTextField", "Search")),
            app: "Safari".into(),
            ..Default::default()
        };
        let same = field.clone();
        let other = Hit {
            app: "Mail".into(),
            ..field.clone()
        };
        assert!(focus_is_current(Some(&field), Some(&same)));
        assert!(!focus_is_current(Some(&field), Some(&other)));
        assert!(!focus_is_current(Some(&field), None));
        assert!(!focus_is_current(None, Some(&field)));
    }

    #[test]
    fn only_transient_focus_read_failures_are_retried() {
        assert!(retryable_focus_read_error(
            "no focused application (grant Accessibility, focus an app)"
        ));
        assert!(retryable_focus_read_error(
            "the focused app has no window on the shared display — move it to the screen you are sharing"
        ));
        assert!(!retryable_focus_read_error("AX permission denied"));
    }

    #[test]
    fn a_reading_lists_named_elements_only_and_finds_the_window() {
        let mut nodes = vec![
            tree::AxNode {
                id: 0,
                role: "AXWindow".into(),
                label: Some("Inbox".into()),
                frame: Some([0.0, 0.0, 100.0, 100.0]),
                ..Default::default()
            },
            tree::AxNode {
                id: 1,
                depth: 1,
                role: "AXPopUpButton".into(),
                label: Some("  Mailbox  ".into()),
                value: Some("secret draft text".into()),
                ..Default::default()
            },
            tree::AxNode {
                id: 2,
                depth: 1,
                role: "AXButton".into(),
                label: None,
                ..Default::default()
            },
        ];
        let mut snapshot = ax::AxSnapshot::for_test(nodes.clone());
        snapshot.app = "Mail".into();
        let listed = vec![(1usize, [0.6, 0.0, 0.2, 0.1]), (2usize, [0.0; 4])];
        let reading = screen_reading(&snapshot, &listed);
        assert_eq!(reading.app, "Mail");
        assert_eq!(reading.window, Some(0));
        assert_eq!(
            reading.elements,
            vec![ReadElement {
                id: 1,
                role: "pop up button".into(),
                label: "Mailbox".into(),
                // Coarse, and only coarse: two Sends are told apart by this,
                // and nothing is aimed by it.
                at: Some("top right".into()),
            }],
            "no value, and nothing unnamed"
        );
        // A window with no position is no place to scroll.
        nodes[0].frame = None;
        let snapshot = ax::AxSnapshot::for_test(nodes);
        assert_eq!(screen_reading(&snapshot, &listed).window, None);
    }

    #[tokio::test]
    async fn without_the_input_thread_an_action_fails_with_a_reason() {
        let mut ex = executor(Grid::Pixels);
        ex.observe = false;
        let err = ex
            .act(&Action::TypeText {
                text: "x".into(),
                focus: None,
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("cannot control"), "{err}");
    }
}
