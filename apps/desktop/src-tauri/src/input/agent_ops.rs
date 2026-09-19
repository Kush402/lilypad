//! What Ask does with the mouse and keyboard, as whole gestures.
//!
//! The phone sends input as a stream of low-level events and the dispatcher
//! replays them one by one. An agent does not work that way: it asks for "a
//! double click at this point" or "type this sentence", and each of those is a
//! small sequence with timing in it. They run here, on the input thread, as
//! one uninterrupted unit — so nothing from the phone can land in the middle
//! of a drag — and every one of them ends with every button and key it pressed
//! released, whether it finished, failed, or was stopped part way. A stuck
//! Command key after a cancelled run would turn the person's next keystroke
//! into a shortcut.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use super::keys::{text_units, Chord, Key};
use super::{InputBackend, KeyAction, Modifier, MouseAction, PointerButton, ScrollAction};

/// A point in normalized 0..1 coordinates of the target display.
pub type Point = (f64, f64);

/// One gesture Ask performs.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentOp {
    Move {
        to: Point,
    },
    /// `count` 1..3: single, double or triple click.
    Click {
        at: Point,
        button: PointerButton,
        count: u8,
        modifiers: Vec<Modifier>,
    },
    Drag {
        from: Point,
        to: Point,
        modifiers: Vec<Modifier>,
    },
    /// Press and keep holding. Released by `MouseUp`, by the end of the run,
    /// or when control is revoked — never left down past those.
    MouseDown {
        at: Option<Point>,
        button: PointerButton,
    },
    MouseUp {
        at: Option<Point>,
        button: PointerButton,
    },
    /// `dx`/`dy` in wheel clicks; positive `dy` reveals content below.
    Scroll {
        at: Option<Point>,
        dx: i32,
        dy: i32,
        modifiers: Vec<Modifier>,
    },
    Type {
        text: String,
    },
    Keys {
        chords: Vec<Chord>,
        repeat: u32,
    },
    HoldKeys {
        chord: Chord,
        ms: u64,
    },
    /// Where the pointer is. Performs nothing.
    CursorPosition,
    /// Let go of anything an earlier `MouseDown` left held.
    ReleaseHeld,
}

/// What a gesture left behind that the caller may want to report.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AgentReport {
    /// The pointer afterwards, normalized to the target display. `None` when
    /// the backend cannot say, or it is on another display.
    pub cursor: Option<Point>,
}

/// Longest text one `Type` accepts.
pub const MAX_TYPE_CHARS: usize = 4000;
/// Most times one `Keys` may repeat.
pub const MAX_KEY_REPEAT: u32 = 100;
/// Longest a key may be held.
pub const MAX_HOLD_MS: u64 = 10_000;
/// Most wheel clicks in one scroll.
pub const MAX_SCROLL_CLICKS: i32 = 50;

/// Pixels one wheel click scrolls. A physical wheel notch is about three
/// lines, which is roughly this on a default-size Mac text view.
const PIXELS_PER_CLICK: f64 = 48.0;
/// Interpolated drag events between press and release. Apps that watch drag
/// velocity (window moves, sliders, text selection) need intermediate points;
/// a jump from start to end reads as a click at the far end.
const DRAG_STEPS: u32 = 12;

/// Timing, gathered so a test can run the same sequences without the waits.
#[derive(Debug, Clone, Copy)]
pub struct Pace {
    /// After moving to a point, before pressing — hover states and tooltips
    /// react to the move, and some controls only accept a press they saw the
    /// pointer arrive for.
    pub settle: Duration,
    /// Between the clicks of a double or triple click. Well inside the
    /// system's double-click interval.
    pub between_clicks: Duration,
    pub drag_step: Duration,
    pub between_keys: Duration,
    pub between_units: Duration,
    pub scroll_step: Duration,
}

impl Pace {
    pub const REAL: Pace = Pace {
        settle: Duration::from_millis(40),
        between_clicks: Duration::from_millis(60),
        drag_step: Duration::from_millis(12),
        between_keys: Duration::from_millis(25),
        between_units: Duration::from_millis(3),
        scroll_step: Duration::from_millis(16),
    };
    pub const INSTANT: Pace = Pace {
        settle: Duration::ZERO,
        between_clicks: Duration::ZERO,
        drag_step: Duration::ZERO,
        between_keys: Duration::ZERO,
        between_units: Duration::ZERO,
        scroll_step: Duration::ZERO,
    };
}

/// Stateful driver for one op. `held` is the dispatcher's own list of buttons
/// down, so a `MouseDown` left pending is released by the same code that
/// releases the phone's on disconnect.
pub struct Driver<'a> {
    pub backend: &'a mut dyn InputBackend,
    pub held_buttons: &'a mut Vec<PointerButton>,
    pub stop: &'a dyn Fn() -> bool,
    pub pace: Pace,
    keys_down: Vec<String>,
    /// Buttons this op pressed and has not released. Only these are let go
    /// on the way out: a button an earlier `MouseDown` is holding on purpose
    /// stays down until its `MouseUp`.
    pressed: Vec<PointerButton>,
    last_point: Point,
    /// Whether this op moved the pointer, so `last_point` is where it is.
    moved: bool,
}

impl<'a> Driver<'a> {
    pub fn new(
        backend: &'a mut dyn InputBackend,
        held_buttons: &'a mut Vec<PointerButton>,
        stop: &'a dyn Fn() -> bool,
        pace: Pace,
    ) -> Self {
        let last_point = backend.cursor_position().unwrap_or((0.5, 0.5));
        Driver {
            backend,
            held_buttons,
            stop,
            pace,
            keys_down: Vec::new(),
            pressed: Vec::new(),
            last_point,
            moved: false,
        }
    }

    /// Run `op` to completion, then release every key this op pressed. A
    /// button is released too unless the op's whole point was to hold it.
    pub fn run(mut self, op: &AgentOp) -> Result<AgentReport> {
        let result = self.perform(op);
        let keep_button = matches!(op, AgentOp::MouseDown { .. }) && result.is_ok();
        let release_all = matches!(op, AgentOp::ReleaseHeld);
        self.release(keep_button, release_all);
        result?;
        // Where this op put the pointer, not where the system says it is this
        // instant: posted events are delivered asynchronously, and reading the
        // position straight after a drag can see a point just short of the end
        // — which the next gesture would take for a person nudging the mouse.
        Ok(AgentReport {
            cursor: if self.moved {
                Some(self.last_point)
            } else {
                self.backend.cursor_position()
            },
        })
    }

    fn check(&self) -> Result<()> {
        if (self.stop)() {
            bail!("stopped");
        }
        Ok(())
    }

    fn wait(&self, d: Duration) -> Result<()> {
        // Slept in slices so Stop is honoured within a few milliseconds even
        // during a long hold.
        let mut left = d;
        let slice = Duration::from_millis(10);
        while !left.is_zero() {
            self.check()?;
            let step = left.min(slice);
            std::thread::sleep(step);
            left -= step;
        }
        self.check()
    }

    fn perform(&mut self, op: &AgentOp) -> Result<()> {
        self.check()?;
        match op {
            AgentOp::Move { to } => self.move_to(*to),
            AgentOp::Click {
                at,
                button,
                count,
                modifiers,
            } => {
                if !(1..=3).contains(count) {
                    bail!("a click count must be 1, 2 or 3, not {count}");
                }
                self.move_to(*at)?;
                self.wait(self.pace.settle)?;
                self.modifiers_down(modifiers)?;
                // macOS reads double and triple clicks from each event's
                // click state, not from timing — so a double click is two
                // press/release pairs stamped 1 and then 2.
                for n in 1..=*count {
                    if n > 1 {
                        self.wait(self.pace.between_clicks)?;
                    }
                    self.backend.inject_mouse(MouseAction::Click {
                        x: at.0,
                        y: at.1,
                        button: *button,
                        count: n,
                        modifiers: modifiers.clone(),
                    })?;
                }
                Ok(())
            }
            AgentOp::Drag {
                from,
                to,
                modifiers,
            } => {
                self.move_to(*from)?;
                self.wait(self.pace.settle)?;
                self.modifiers_down(modifiers)?;
                self.press(PointerButton::Left, *from, modifiers)?;
                self.wait(self.pace.settle)?;
                for i in 1..=DRAG_STEPS {
                    let t = f64::from(i) / f64::from(DRAG_STEPS);
                    let p = (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
                    self.backend.inject_mouse(MouseAction::Drag {
                        x: p.0,
                        y: p.1,
                        button: PointerButton::Left,
                        modifiers: modifiers.clone(),
                    })?;
                    self.last_point = p;
                    self.moved = true;
                    self.wait(self.pace.drag_step)?;
                }
                self.wait(self.pace.settle)?;
                self.lift(PointerButton::Left, *to, modifiers)
            }
            AgentOp::MouseDown { at, button } => {
                if let Some(at) = at {
                    self.move_to(*at)?;
                    self.wait(self.pace.settle)?;
                }
                let p = self.last_point;
                self.press(*button, p, &[])
            }
            AgentOp::MouseUp { at, button } => {
                if let Some(at) = at {
                    self.move_to(*at)?;
                }
                if !self.held_buttons.contains(button) {
                    bail!("the {button:?} button is not being held; press it first");
                }
                let p = self.last_point;
                self.lift(*button, p, &[])
            }
            AgentOp::Scroll {
                at,
                dx,
                dy,
                modifiers,
            } => {
                if dx.abs() > MAX_SCROLL_CLICKS || dy.abs() > MAX_SCROLL_CLICKS {
                    bail!("scroll at most {MAX_SCROLL_CLICKS} clicks at a time");
                }
                // The wheel scrolls whatever is under the pointer; the scroll
                // event itself carries no position. So the pointer goes there
                // first, or the scroll lands in whatever it happened to be
                // over.
                if let Some(at) = at {
                    self.move_to(*at)?;
                    self.wait(self.pace.settle)?;
                }
                self.modifiers_down(modifiers)?;
                let steps = dx.unsigned_abs().max(dy.unsigned_abs());
                for i in 0..steps as i32 {
                    let sx = if i < dx.abs() { dx.signum() } else { 0 };
                    let sy = if i < dy.abs() { dy.signum() } else { 0 };
                    let (x, y) = self.last_point;
                    self.backend.inject_scroll(ScrollAction {
                        x,
                        y,
                        dx: f64::from(sx) * PIXELS_PER_CLICK,
                        dy: f64::from(sy) * PIXELS_PER_CLICK,
                    })?;
                    self.wait(self.pace.scroll_step)?;
                }
                Ok(())
            }
            AgentOp::Type { text } => {
                if text.chars().count() > MAX_TYPE_CHARS {
                    bail!("type at most {MAX_TYPE_CHARS} characters at a time");
                }
                let mut units = text_units(text).into_iter().peekable();
                while let Some(unit) = units.next() {
                    self.check()?;
                    match unit.as_str() {
                        // Newlines are Return: a text view would take "\n" as
                        // a character, but a form field, a chat box and a
                        // terminal all act on the key.
                        "\r" if units.peek().map(String::as_str) == Some("\n") => continue,
                        "\n" | "\r" => self.tap(&Key::Code("Enter".into()), &[])?,
                        "\t" => self.tap(&Key::Code("Tab".into()), &[])?,
                        other => self.backend.inject_text(other)?,
                    }
                    self.wait(self.pace.between_units)?;
                }
                Ok(())
            }
            AgentOp::Keys { chords, repeat } => {
                if !(1..=MAX_KEY_REPEAT).contains(repeat) {
                    bail!("repeat must be between 1 and {MAX_KEY_REPEAT}");
                }
                for r in 0..*repeat {
                    for (i, chord) in chords.iter().enumerate() {
                        if r > 0 || i > 0 {
                            self.wait(self.pace.between_keys)?;
                        }
                        self.chord(chord)?;
                    }
                }
                Ok(())
            }
            AgentOp::HoldKeys { chord, ms } => {
                if *ms > MAX_HOLD_MS {
                    bail!("hold a key for at most {} seconds", MAX_HOLD_MS / 1000);
                }
                let (key, mut modifiers) = self.resolve(chord)?;
                modifiers.extend(chord.modifiers.iter().copied());
                dedup(&mut modifiers);
                self.modifiers_down(&modifiers)?;
                if let Some(code) = &key {
                    self.key(code, true, &modifiers)?;
                }
                self.wait(Duration::from_millis(*ms))?;
                // Released by `release` on the way out, in reverse order.
                Ok(())
            }
            AgentOp::CursorPosition => Ok(()),
            AgentOp::ReleaseHeld => Ok(()),
        }
    }

    fn move_to(&mut self, to: Point) -> Result<()> {
        check_point(to)?;
        let action = match self.held_buttons.last().copied() {
            Some(button) => MouseAction::Drag {
                x: to.0,
                y: to.1,
                button,
                modifiers: vec![],
            },
            None => MouseAction::Move { x: to.0, y: to.1 },
        };
        self.backend.inject_mouse(action)?;
        self.last_point = to;
        self.moved = true;
        Ok(())
    }

    fn press(&mut self, button: PointerButton, at: Point, modifiers: &[Modifier]) -> Result<()> {
        self.backend.inject_mouse(MouseAction::Down {
            x: at.0,
            y: at.1,
            button,
            modifiers: modifiers.to_vec(),
        })?;
        if !self.held_buttons.contains(&button) {
            self.held_buttons.push(button);
        }
        self.pressed.push(button);
        Ok(())
    }

    fn lift(&mut self, button: PointerButton, at: Point, modifiers: &[Modifier]) -> Result<()> {
        self.held_buttons.retain(|b| *b != button);
        self.pressed.retain(|b| *b != button);
        self.backend.inject_mouse(MouseAction::Up {
            x: at.0,
            y: at.1,
            button,
            modifiers: modifiers.to_vec(),
        })?;
        self.last_point = at;
        Ok(())
    }

    fn key(&mut self, code: &str, down: bool, modifiers: &[Modifier]) -> Result<()> {
        self.backend.inject_keyboard(KeyAction {
            code: code.to_string(),
            down,
            modifiers: modifiers.to_vec(),
            repeat: false,
        })?;
        if down {
            self.keys_down.push(code.to_string());
        } else if let Some(i) = self.keys_down.iter().rposition(|k| k == code) {
            self.keys_down.remove(i);
        }
        Ok(())
    }

    /// Press the modifier keys themselves, as a keyboard would, before the
    /// key or click that carries their flags. Some apps read modifier state
    /// from these transitions rather than from the flags on the event.
    fn modifiers_down(&mut self, modifiers: &[Modifier]) -> Result<()> {
        let mut held: Vec<Modifier> = Vec::new();
        for m in modifiers {
            held.push(*m);
            self.key(modifier_code(*m), true, &held)?;
        }
        Ok(())
    }

    /// What pressing `chord` actually sends: the key's code, and any Shift
    /// the layout needs to produce the character.
    fn resolve(&mut self, chord: &Chord) -> Result<(Option<String>, Vec<Modifier>)> {
        match &chord.key {
            None => Ok((None, vec![])),
            Some(Key::Code(code)) => Ok((Some(code.clone()), vec![])),
            Some(Key::Char(c)) => match self.backend.key_for_char(*c) {
                Some((code, shift)) => Ok((
                    Some(code),
                    if shift { vec![Modifier::Shift] } else { vec![] },
                )),
                None => Err(anyhow!(
                    "`{c}` is not on this Mac's keyboard layout; type it with `type` instead"
                )),
            },
        }
    }

    fn chord(&mut self, chord: &Chord) -> Result<()> {
        // A character with no modifiers that the layout cannot produce can
        // still be typed; only a shortcut needs the physical key.
        if let Some(Key::Char(c)) = &chord.key {
            if chord.modifiers.is_empty() && self.backend.key_for_char(*c).is_none() {
                return self.backend.inject_text(&c.to_string());
            }
        }
        let (key, extra) = self.resolve(chord)?;
        let mut modifiers = chord.modifiers.clone();
        modifiers.extend(extra);
        dedup(&mut modifiers);
        match key {
            Some(code) => self.tap_code(&code, &modifiers),
            None => {
                // Modifiers alone: press and release them.
                self.modifiers_down(&modifiers)?;
                self.release_keys();
                Ok(())
            }
        }
    }

    fn tap(&mut self, key: &Key, modifiers: &[Modifier]) -> Result<()> {
        match key {
            Key::Code(code) => self.tap_code(code, modifiers),
            Key::Char(c) => self.chord(&Chord {
                modifiers: modifiers.to_vec(),
                key: Some(Key::Char(*c)),
            }),
        }
    }

    fn tap_code(&mut self, code: &str, modifiers: &[Modifier]) -> Result<()> {
        self.modifiers_down(modifiers)?;
        self.key(code, true, modifiers)?;
        self.key(code, false, modifiers)?;
        self.release_keys();
        Ok(())
    }

    /// Release keys this op pressed, newest first.
    fn release_keys(&mut self) {
        while let Some(code) = self.keys_down.pop() {
            let _ = self.backend.inject_keyboard(KeyAction {
                code,
                down: false,
                modifiers: vec![],
                repeat: false,
            });
        }
    }

    fn release(&mut self, keep_button: bool, release_all: bool) {
        self.release_keys();
        if keep_button {
            return;
        }
        let (x, y) = self.last_point;
        let to_release: Vec<PointerButton> = if release_all {
            std::mem::take(self.held_buttons)
        } else {
            let mine = std::mem::take(&mut self.pressed);
            self.held_buttons.retain(|b| !mine.contains(b));
            mine
        };
        for button in to_release {
            let _ = self.backend.inject_mouse(MouseAction::Up {
                x,
                y,
                button,
                modifiers: vec![],
            });
        }
    }
}

fn dedup(modifiers: &mut Vec<Modifier>) {
    let mut seen = Vec::new();
    modifiers.retain(|m| {
        if seen.contains(m) {
            false
        } else {
            seen.push(*m);
            true
        }
    });
}

fn modifier_code(m: Modifier) -> &'static str {
    match m {
        Modifier::Ctrl => "ControlLeft",
        Modifier::Alt => "AltLeft",
        Modifier::Shift => "ShiftLeft",
        Modifier::Meta => "MetaLeft",
    }
}

/// A normalized point must be on the display. The backend clamps as a last
/// line, but a point off the screen is the caller's mistake to hear about, not
/// a click on the edge.
fn check_point(p: Point) -> Result<()> {
    let ok = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
    if ok(p.0) && ok(p.1) {
        Ok(())
    } else {
        bail!("that point is outside the screen")
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::parse_keys;
    use super::super::PermissionStatus;
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Records every call as a readable line.
    #[derive(Default)]
    struct Rec {
        calls: Vec<String>,
        fail_on: Option<String>,
    }

    impl InputBackend for Rec {
        fn initialize(&mut self) -> Result<()> {
            Ok(())
        }
        fn permission_status(&self) -> PermissionStatus {
            PermissionStatus::Granted
        }
        fn primary_modifier(&self) -> Modifier {
            Modifier::Meta
        }
        fn inject_mouse(&mut self, action: MouseAction) -> Result<()> {
            let line = match action {
                MouseAction::Move { x, y } => format!("move {x:.2},{y:.2}"),
                MouseAction::Drag { x, y, .. } => format!("drag {x:.2},{y:.2}"),
                MouseAction::Down { button, .. } => format!("down {button:?}"),
                MouseAction::Up { button, .. } => format!("up {button:?}"),
                MouseAction::Click {
                    button,
                    count,
                    modifiers,
                    ..
                } => format!("click {button:?} state{count} {modifiers:?}"),
            };
            if self.fail_on.as_deref() == Some(line.as_str()) {
                bail!("injected failure");
            }
            self.calls.push(line);
            Ok(())
        }
        fn inject_keyboard(&mut self, a: KeyAction) -> Result<()> {
            self.calls
                .push(format!("{} {}", if a.down { "kd" } else { "ku" }, a.code));
            Ok(())
        }
        fn inject_scroll(&mut self, a: ScrollAction) -> Result<()> {
            self.calls.push(format!("scroll {} {}", a.dx, a.dy));
            Ok(())
        }
        fn inject_text(&mut self, text: &str) -> Result<()> {
            self.calls.push(format!("text {text}"));
            Ok(())
        }
        fn set_clipboard(&mut self, _: &str) -> Result<()> {
            Ok(())
        }
        fn shutdown(&mut self) -> Result<()> {
            Ok(())
        }
    }

    fn run(backend: &mut Rec, held: &mut Vec<PointerButton>, op: AgentOp) -> Result<AgentReport> {
        let never = || false;
        Driver::new(backend, held, &never, Pace::INSTANT).run(&op)
    }

    fn calls(op: AgentOp) -> Vec<String> {
        let mut b = Rec::default();
        let mut held = Vec::new();
        run(&mut b, &mut held, op).unwrap();
        assert!(held.is_empty(), "a button was left held");
        b.calls
    }

    #[test]
    fn a_double_click_is_two_pairs_stamped_one_then_two() {
        let c = calls(AgentOp::Click {
            at: (0.5, 0.5),
            button: PointerButton::Left,
            count: 2,
            modifiers: vec![],
        });
        assert_eq!(
            c,
            [
                "move 0.50,0.50",
                "click Left state1 []",
                "click Left state2 []"
            ]
        );
    }

    #[test]
    fn a_modified_click_presses_and_releases_the_modifier_keys() {
        let c = calls(AgentOp::Click {
            at: (0.1, 0.2),
            button: PointerButton::Left,
            count: 1,
            modifiers: vec![Modifier::Meta],
        });
        assert_eq!(
            c,
            [
                "move 0.10,0.20",
                "kd MetaLeft",
                "click Left state1 [Meta]",
                "ku MetaLeft"
            ]
        );
    }

    #[test]
    fn a_scroll_moves_to_its_point_first_because_the_wheel_has_no_position() {
        let c = calls(AgentOp::Scroll {
            at: Some((0.3, 0.7)),
            dx: 0,
            dy: 2,
            modifiers: vec![],
        });
        assert_eq!(c, ["move 0.30,0.70", "scroll 0 48", "scroll 0 48"]);
    }

    #[test]
    fn a_drag_presses_moves_through_intermediate_points_and_releases() {
        let c = calls(AgentOp::Drag {
            from: (0.0, 0.0),
            to: (1.0, 1.0),
            modifiers: vec![],
        });
        assert_eq!(c.first().unwrap(), "move 0.00,0.00");
        assert_eq!(c[1], "down Left");
        assert_eq!(
            c.iter().filter(|l| l.starts_with("drag")).count(),
            DRAG_STEPS as usize
        );
        assert_eq!(c.last().unwrap(), "up Left");
    }

    #[test]
    fn typing_turns_newlines_into_return_and_keeps_emoji_whole() {
        let c = calls(AgentOp::Type {
            text: "hi\r\n👍🏽\tx".into(),
        });
        assert_eq!(
            c,
            [
                "text h",
                "text i",
                "kd Enter",
                "ku Enter",
                "text 👍🏽",
                "kd Tab",
                "ku Tab",
                "text x"
            ]
        );
    }

    #[test]
    fn a_shortcut_resolves_the_letter_and_releases_in_reverse() {
        let c = calls(AgentOp::Keys {
            chords: parse_keys("cmd+shift+t").unwrap(),
            repeat: 1,
        });
        assert_eq!(
            c,
            [
                "kd MetaLeft",
                "kd ShiftLeft",
                "kd KeyT",
                "ku KeyT",
                "ku ShiftLeft",
                "ku MetaLeft"
            ]
        );
    }

    #[test]
    fn a_shifted_character_gets_shift_from_the_layout() {
        let c = calls(AgentOp::Keys {
            chords: parse_keys("cmd+?").unwrap(),
            repeat: 1,
        });
        assert!(c.contains(&"kd ShiftLeft".to_string()), "{c:?}");
        assert!(c.contains(&"kd Slash".to_string()), "{c:?}");
    }

    #[test]
    fn a_character_off_the_layout_is_typed_when_it_has_no_modifiers() {
        assert_eq!(
            calls(AgentOp::Keys {
                chords: parse_keys("é").unwrap(),
                repeat: 1
            }),
            ["text é"]
        );
        let mut b = Rec::default();
        let err = run(
            &mut b,
            &mut vec![],
            AgentOp::Keys {
                chords: parse_keys("cmd+é").unwrap(),
                repeat: 1,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("keyboard layout"), "{err}");
    }

    #[test]
    fn repeat_presses_the_chord_again() {
        let c = calls(AgentOp::Keys {
            chords: parse_keys("Down").unwrap(),
            repeat: 3,
        });
        assert_eq!(c.iter().filter(|l| *l == "kd ArrowDown").count(), 3);
        let mut b = Rec::default();
        assert!(run(
            &mut b,
            &mut vec![],
            AgentOp::Keys {
                chords: parse_keys("Down").unwrap(),
                repeat: 0
            }
        )
        .is_err());
    }

    #[test]
    fn a_stop_mid_drag_still_releases_the_button() {
        let mut b = Rec::default();
        let mut held = Vec::new();
        let steps = std::cell::Cell::new(0);
        // Stop after a few checks, part way through the drag.
        let stop = || {
            steps.set(steps.get() + 1);
            steps.get() > 6
        };
        let err = Driver::new(&mut b, &mut held, &stop, Pace::INSTANT)
            .run(&AgentOp::Drag {
                from: (0.0, 0.0),
                to: (1.0, 1.0),
                modifiers: vec![Modifier::Shift],
            })
            .unwrap_err();
        assert_eq!(err.to_string(), "stopped");
        assert!(held.is_empty());
        assert_eq!(b.calls.last().unwrap(), "up Left", "{:?}", b.calls);
        assert!(b.calls.contains(&"ku ShiftLeft".to_string()));
    }

    #[test]
    fn a_failure_mid_click_releases_the_modifier() {
        let mut b = Rec {
            fail_on: Some("click Left state1 [Meta]".into()),
            ..Default::default()
        };
        let mut held = Vec::new();
        assert!(run(
            &mut b,
            &mut held,
            AgentOp::Click {
                at: (0.5, 0.5),
                button: PointerButton::Left,
                count: 1,
                modifiers: vec![Modifier::Meta]
            }
        )
        .is_err());
        assert_eq!(b.calls.last().unwrap(), "ku MetaLeft");
    }

    #[test]
    fn mouse_down_is_the_one_op_that_keeps_holding() {
        let mut b = Rec::default();
        let mut held = Vec::new();
        run(
            &mut b,
            &mut held,
            AgentOp::MouseDown {
                at: Some((0.2, 0.2)),
                button: PointerButton::Left,
            },
        )
        .unwrap();
        assert_eq!(held, vec![PointerButton::Left]);
        // A move while held is a drag.
        run(&mut b, &mut held, AgentOp::Move { to: (0.4, 0.4) }).unwrap_or_default();
        assert!(
            b.calls.contains(&"drag 0.40,0.40".to_string()),
            "{:?}",
            b.calls
        );
        run(
            &mut b,
            &mut held,
            AgentOp::MouseUp {
                at: None,
                button: PointerButton::Left,
            },
        )
        .unwrap();
        assert!(held.is_empty());
        // Up without a down is refused, not sent.
        assert!(run(
            &mut b,
            &mut held,
            AgentOp::MouseUp {
                at: None,
                button: PointerButton::Left
            }
        )
        .is_err());
    }

    #[test]
    fn points_off_the_screen_and_oversized_requests_are_refused() {
        let mut b = Rec::default();
        for op in [
            AgentOp::Move { to: (1.5, 0.5) },
            AgentOp::Move {
                to: (f64::NAN, 0.5),
            },
            AgentOp::Type {
                text: "x".repeat(MAX_TYPE_CHARS + 1),
            },
            AgentOp::Scroll {
                at: None,
                dx: 0,
                dy: MAX_SCROLL_CLICKS + 1,
                modifiers: vec![],
            },
            AgentOp::HoldKeys {
                chord: parse_keys("shift").unwrap().remove(0),
                ms: MAX_HOLD_MS + 1,
            },
        ] {
            assert!(run(&mut b, &mut vec![], op.clone()).is_err(), "{op:?}");
        }
        assert!(b.calls.is_empty(), "refused ops sent {:?}", b.calls);
    }

    #[test]
    fn stop_is_checked_before_anything_is_sent() {
        let mut b = Rec::default();
        let flag = AtomicBool::new(true);
        let stop = || flag.load(Ordering::SeqCst);
        let err = Driver::new(&mut b, &mut vec![], &stop, Pace::INSTANT)
            .run(&AgentOp::Type { text: "x".into() })
            .unwrap_err();
        assert_eq!(err.to_string(), "stopped");
        assert!(b.calls.is_empty());
    }
}
