//! `InputDispatcher` — OS-agnostic gating, duplicate/reorder suppression, and
//! held-key/button state tracking. Talks only to the [`InputBackend`] trait,
//! so it is fully unit-testable behind a mock (no OS APIs needed).
//!
//! Two independent gates must both be satisfied before an event reaches
//! [`InputBackend`]: `enabled` (peer connected + DataChannel open — owned by
//! `session::InputGate`) and `granted_scopes` (what the session was actually
//! approved for — sourced from `session-start`'s `grantedScopes`). Folding
//! scope into `enabled` would conflate "is a peer live" with "is this peer
//! allowed to control anything," which is exactly the bug this type fixes:
//! per `docs/audit/m3/backend-security.md` Finding 2, a view-only session was
//! previously indistinguishable from a control session once the DataChannel
//! opened, because nothing here ever consulted scope at all.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use super::{
    InputBackend, InputBatch, InputEvent, InputMetrics, KeyAction, Modifier, MouseAction,
    PermissionStatus, PointerButton, ScrollAction, ShortcutAction,
};

/// Permission scope granted for a session — mirrors `@lilypad/protocol`'s
/// `SessionScope` (`packages/protocol/src/pairing.ts`). Only `Control` is
/// meaningful to the input pipeline today (view-only sessions send no input
/// events by protocol design), but this stays an enum rather than a bare
/// bool so a future finer-grained scope (e.g. a dedicated `clipboard` scope,
/// flagged in `docs/audit/m3/backend-security.md` Finding 9) is one more
/// variant checked in the same place, not a re-plumb of the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    View,
    Control,
}

/// The scope an input event requires before it may be injected. Matched
/// exhaustively (rather than a blanket `true`/`Scope::Control`) so a future
/// `InputEvent` variant added to the wire protocol without updating this
/// function fails to compile instead of silently being let through — see
/// the module doc comment for why this check exists at all. Every event
/// kind currently defined is control-plane: a view-only session sends none
/// of these, by design.
fn required_scope(event: &InputEvent) -> Scope {
    match event {
        InputEvent::PointerMove { .. }
        | InputEvent::PointerDown { .. }
        | InputEvent::PointerUp { .. }
        | InputEvent::Click { .. }
        | InputEvent::Scroll { .. }
        | InputEvent::KeyDown { .. }
        | InputEvent::KeyUp { .. }
        | InputEvent::TextInput { .. }
        | InputEvent::Shortcut { .. }
        | InputEvent::Clipboard { .. } => Scope::Control,
    }
}

/// Identifies a stateful "stream" for stale/duplicate rejection: an event is
/// dropped if its ordering key (monotonic `seq`, or `ts` for a pre-v2 sender —
/// see `InputEvent::order_key`) is not strictly greater than the last one
/// accepted for its key. Moves are idempotent-ish so this only guards against
/// visible jitter; down/up/click guard against literal replay and reordering.
#[derive(PartialEq, Eq, Hash, Clone)]
enum EventKey {
    Pointer,
    Button(&'static str, PointerButton),
    Key(&'static str, String),
}

fn event_key(e: &InputEvent) -> Option<EventKey> {
    match e {
        InputEvent::PointerMove { .. } => Some(EventKey::Pointer),
        InputEvent::PointerDown { button, .. } => Some(EventKey::Button("down", *button)),
        InputEvent::PointerUp { button, .. } => Some(EventKey::Button("up", *button)),
        InputEvent::Click { button, .. } => Some(EventKey::Button("click", *button)),
        InputEvent::KeyDown { code, .. } => Some(EventKey::Key("down", code.clone())),
        InputEvent::KeyUp { code, .. } => Some(EventKey::Key("up", code.clone())),
        // Scroll/text/shortcut/clipboard have no natural held-state identity;
        // dropping a legitimate repeat would be worse than an unlikely replay.
        _ => None,
    }
}

pub struct InputDispatcher {
    backend: Box<dyn InputBackend>,
    metrics: Arc<InputMetrics>,
    /// Gate: only true once the session is Connected AND the input
    /// DataChannel is open. Set by the session runner; independently enforced
    /// here so the dispatcher can never inject after disconnect even if a
    /// caller forgets to stop feeding it.
    enabled: bool,
    /// Scopes actually granted for the current session (from `session-start`'s
    /// `grantedScopes`). Starts empty — fail closed, matching `enabled`'s
    /// default — so input is rejected until a real grant arrives, never
    /// implicitly allowed before scope is even known.
    granted_scopes: HashSet<Scope>,
    /// Buttons currently held, in press order (oldest first) — NOT a
    /// `HashSet`: iteration order there is unspecified, which previously let
    /// a hypothetical multi-button chord pick an arbitrary button to drive
    /// `Drag` instead of a deterministic one. Push on down (deduped — a
    /// repeat down for an already-held button is a no-op), remove on up;
    /// `.last()` is "the most recently pressed still-held button," the
    /// precedence rule that drives `Drag`. See
    /// `docs/audit/m3/input-touch.md` Finding 13.
    held_buttons: Vec<PointerButton>,
    held_keys: HashSet<String>,
    last_pointer_pos: (f64, f64),
    /// Modifiers that were held at the most recent pointer-down, carried onto
    /// the drag events that follow (pointer_move carries no modifiers of its
    /// own, so an Option-drag / Shift-drag must inherit them from the press
    /// that started it). Cleared on pointer-up. See Finding 5.
    active_modifiers: Vec<Modifier>,
    /// Last accepted ordering key per stream — see [`EventKey`] and
    /// `InputEvent::order_key`. Named `last_seq` (not `last_ts`) since the
    /// discriminant is now the monotonic sequence, not wall-clock time.
    last_seq: HashMap<EventKey, u64>,
}

impl InputDispatcher {
    pub fn new(backend: Box<dyn InputBackend>, metrics: Arc<InputMetrics>) -> Self {
        Self {
            backend,
            metrics,
            enabled: false,
            granted_scopes: HashSet::new(),
            held_buttons: Vec::new(),
            held_keys: HashSet::new(),
            last_pointer_pos: (0.5, 0.5),
            active_modifiers: Vec::new(),
            last_seq: HashMap::new(),
        }
    }

    pub fn permission_status(&self) -> PermissionStatus {
        self.backend.permission_status()
    }

    /// Enable/disable injection. Disabling releases any held keys/buttons so a
    /// disconnect (including mid-drag) never leaves the OS in a stuck state.
    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled && self.enabled {
            self.release_all();
        }
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Replace the granted-scope set for the current session (called whenever
    /// `session-start` arrives, including on a repeat session-start replacing
    /// an existing peer). Does NOT release held keys/buttons the way
    /// `set_enabled(false)` does — a scope change only ever happens alongside
    /// a fresh session-start, at which point no keys/buttons are held yet.
    pub fn set_scopes(&mut self, scopes: HashSet<Scope>) {
        self.granted_scopes = scopes;
    }

    pub fn process_batch(&mut self, batch: InputBatch) {
        for event in batch.events {
            self.process_event(event);
        }
    }

    fn process_event(&mut self, event: InputEvent) {
        self.metrics.events_received.fetch_add(1, Ordering::Relaxed);

        if !self.enabled {
            self.metrics
                .events_dropped_gated
                .fetch_add(1, Ordering::Relaxed);
            return;
        }

        // Scope enforcement — the fix for `docs/audit/m3/backend-security.md`
        // Finding 2 ("View/control scope is asserted in the protocol but
        // enforced nowhere in the data path"). This is a hard boundary, not a
        // best-effort hint: never trust that the peer only sends what its
        // scope allows (a modified/malicious mobile client can send anything
        // over the DataChannel regardless of what the UI shows). Checked
        // before the dedup/staleness bookkeeping below so an out-of-scope
        // attempt never perturbs that state.
        if !self.granted_scopes.contains(&required_scope(&event)) {
            self.metrics
                .events_dropped_scope
                .fetch_add(1, Ordering::Relaxed);
            log::warn!(
                target: "lilypad::input",
                "dropping input: session scope does not grant control (view-only session?)"
            );
            return;
        }

        if let Some(key) = event_key(&event) {
            // Monotonic `seq` when the sender stamped one; wall-clock `ts`
            // only as a pre-v2 fallback. Using `seq` here is what makes the
            // gate immune to the phone's clock stepping backward mid-session
            // (NTP resync, sleep/resume), which would otherwise permanently
            // wedge the stream — see `docs/audit/m3/input-touch.md` Finding 8.
            let order = event.order_key();
            if let Some(&last) = self.last_seq.get(&key) {
                if order <= last {
                    self.metrics
                        .events_dropped_stale
                        .fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
            self.last_seq.insert(key, order);
        }

        if matches!(
            self.backend.permission_status(),
            PermissionStatus::NotGranted
        ) {
            self.metrics
                .events_dropped_permission
                .fetch_add(1, Ordering::Relaxed);
            log::warn!(
                target: "lilypad::input",
                "dropping input: OS permission not granted (Accessibility on macOS)"
            );
            return;
        }

        let t0 = Instant::now();
        let result = self.apply(event);
        self.metrics
            .inject_us_total
            .fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);

        match result {
            Ok(()) => {
                self.metrics.events_injected.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                self.metrics
                    .events_dropped_invalid
                    .fetch_add(1, Ordering::Relaxed);
                log::warn!(target: "lilypad::input", "injection failed: {e}");
            }
        }
    }

    fn apply(&mut self, event: InputEvent) -> anyhow::Result<()> {
        match event {
            InputEvent::PointerMove { x, y, .. } => {
                self.last_pointer_pos = (x, y);
                let action = match self.held_buttons.last().copied() {
                    // A drag inherits the modifiers held at the press that
                    // started it — pointer_move carries none of its own.
                    Some(button) => MouseAction::Drag {
                        x,
                        y,
                        button,
                        modifiers: self.active_modifiers.clone(),
                    },
                    None => MouseAction::Move { x, y },
                };
                self.backend.inject_mouse(action)
            }
            InputEvent::PointerDown {
                x,
                y,
                button,
                modifiers,
                ..
            } => {
                self.last_pointer_pos = (x, y);
                if !self.held_buttons.contains(&button) {
                    self.held_buttons.push(button);
                }
                self.active_modifiers = modifiers.clone();
                self.backend.inject_mouse(MouseAction::Down {
                    x,
                    y,
                    button,
                    modifiers,
                })
            }
            InputEvent::PointerUp {
                x,
                y,
                button,
                modifiers,
                ..
            } => {
                self.last_pointer_pos = (x, y);
                self.held_buttons.retain(|b| *b != button);
                self.active_modifiers.clear();
                self.backend.inject_mouse(MouseAction::Up {
                    x,
                    y,
                    button,
                    modifiers,
                })
            }
            InputEvent::Click {
                x,
                y,
                button,
                count,
                modifiers,
                ..
            } => {
                self.last_pointer_pos = (x, y);
                self.backend.inject_mouse(MouseAction::Click {
                    x,
                    y,
                    button,
                    count,
                    modifiers,
                })
            }
            InputEvent::Scroll { x, y, dx, dy, .. } => {
                self.backend.inject_scroll(ScrollAction { x, y, dx, dy })
            }
            InputEvent::KeyDown {
                code,
                modifiers,
                repeat,
                ..
            } => {
                self.held_keys.insert(code.clone());
                self.backend.inject_keyboard(KeyAction {
                    code,
                    down: true,
                    modifiers,
                    repeat,
                })
            }
            InputEvent::KeyUp {
                code, modifiers, ..
            } => {
                self.held_keys.remove(&code);
                self.backend.inject_keyboard(KeyAction {
                    code,
                    down: false,
                    modifiers,
                    repeat: false,
                })
            }
            InputEvent::TextInput { text, .. } => self.backend.inject_text(&text),
            InputEvent::Shortcut { action, .. } => self.apply_shortcut(action),
            InputEvent::Clipboard { text, .. } => self.backend.set_clipboard(&text),
        }
    }

    fn apply_shortcut(&mut self, action: ShortcutAction) -> anyhow::Result<()> {
        let primary = self.backend.primary_modifier();
        let chord = |backend: &mut dyn InputBackend,
                     code: &str,
                     modifiers: Vec<Modifier>|
         -> anyhow::Result<()> {
            backend.inject_keyboard(KeyAction {
                code: code.to_string(),
                down: true,
                modifiers: modifiers.clone(),
                repeat: false,
            })?;
            backend.inject_keyboard(KeyAction {
                code: code.to_string(),
                down: false,
                modifiers,
                repeat: false,
            })
        };
        match action {
            ShortcutAction::Copy => chord(&mut *self.backend, "KeyC", vec![primary]),
            ShortcutAction::Paste => chord(&mut *self.backend, "KeyV", vec![primary]),
            ShortcutAction::Cut => chord(&mut *self.backend, "KeyX", vec![primary]),
            ShortcutAction::Undo => chord(&mut *self.backend, "KeyZ", vec![primary]),
            ShortcutAction::Redo => {
                chord(&mut *self.backend, "KeyZ", vec![primary, Modifier::Shift])
            }
            ShortcutAction::SelectAll => chord(&mut *self.backend, "KeyA", vec![primary]),
            ShortcutAction::Save => chord(&mut *self.backend, "KeyS", vec![primary]),
            ShortcutAction::Escape => chord(&mut *self.backend, "Escape", vec![]),
            ShortcutAction::Tab => chord(&mut *self.backend, "Tab", vec![]),
            ShortcutAction::Enter => chord(&mut *self.backend, "Enter", vec![]),
            ShortcutAction::ArrowUp => chord(&mut *self.backend, "ArrowUp", vec![]),
            ShortcutAction::ArrowDown => chord(&mut *self.backend, "ArrowDown", vec![]),
            ShortcutAction::ArrowLeft => chord(&mut *self.backend, "ArrowLeft", vec![]),
            ShortcutAction::ArrowRight => chord(&mut *self.backend, "ArrowRight", vec![]),
        }
    }

    /// Release every held key/button. Called when the gate closes (disconnect,
    /// reconnect, session end) so nothing is left stuck on the OS side.
    fn release_all(&mut self) {
        let (x, y) = self.last_pointer_pos;
        self.active_modifiers.clear();
        for button in std::mem::take(&mut self.held_buttons) {
            let _ = self.backend.inject_mouse(MouseAction::Up {
                x,
                y,
                button,
                modifiers: vec![],
            });
        }
        for code in self.held_keys.drain().collect::<Vec<_>>() {
            let _ = self.backend.inject_keyboard(KeyAction {
                code,
                down: false,
                modifiers: vec![],
                repeat: false,
            });
        }
    }

    pub fn shutdown(&mut self) {
        self.release_all();
        self.enabled = false;
        let _ = self.backend.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::ScrollAction as Scroll;
    use std::sync::Mutex;

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Mouse(String),
        Keyboard(String),
        Scroll(String),
        Text(String),
        Clipboard(String),
    }

    /// Shared inner state so a test can hold `Arc<MockInner>` for inspection
    /// while a `Box<dyn InputBackend>` clone (sharing the same Arc) is moved
    /// into the dispatcher.
    #[derive(Default)]
    struct MockInner {
        calls: Mutex<Vec<Call>>,
        permission: Mutex<Option<PermissionStatus>>,
        fail_next: Mutex<bool>,
    }

    #[derive(Clone, Default)]
    struct MockBackend(Arc<MockInner>);

    impl MockBackend {
        fn calls(&self) -> Vec<Call> {
            self.0.calls.lock().unwrap().clone()
        }
        fn set_permission(&self, p: PermissionStatus) {
            *self.0.permission.lock().unwrap() = Some(p);
        }
        fn set_fail_next(&self, fail: bool) {
            *self.0.fail_next.lock().unwrap() = fail;
        }
        fn boxed(&self) -> Box<dyn InputBackend> {
            Box::new(self.clone())
        }
    }

    impl InputBackend for MockBackend {
        fn initialize(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
        fn permission_status(&self) -> PermissionStatus {
            self.0
                .permission
                .lock()
                .unwrap()
                .unwrap_or(PermissionStatus::Granted)
        }
        fn primary_modifier(&self) -> Modifier {
            Modifier::Meta
        }
        fn inject_mouse(&mut self, action: MouseAction) -> anyhow::Result<()> {
            if *self.0.fail_next.lock().unwrap() {
                anyhow::bail!("mock failure");
            }
            self.0
                .calls
                .lock()
                .unwrap()
                .push(Call::Mouse(format!("{action:?}")));
            Ok(())
        }
        fn inject_keyboard(&mut self, action: KeyAction) -> anyhow::Result<()> {
            self.0.calls.lock().unwrap().push(Call::Keyboard(format!(
                "{}:{}:{:?}",
                action.code, action.down, action.modifiers
            )));
            Ok(())
        }
        fn inject_scroll(&mut self, action: Scroll) -> anyhow::Result<()> {
            self.0
                .calls
                .lock()
                .unwrap()
                .push(Call::Scroll(format!("{action:?}")));
            Ok(())
        }
        fn inject_text(&mut self, text: &str) -> anyhow::Result<()> {
            self.0
                .calls
                .lock()
                .unwrap()
                .push(Call::Text(text.to_string()));
            Ok(())
        }
        fn set_clipboard(&mut self, text: &str) -> anyhow::Result<()> {
            self.0
                .calls
                .lock()
                .unwrap()
                .push(Call::Clipboard(text.to_string()));
            Ok(())
        }
        fn shutdown(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn batch(events: Vec<InputEvent>) -> InputBatch {
        InputBatch {
            kind: "input_batch".into(),
            events,
        }
    }

    /// Returns a dispatcher plus the mock handle (for call inspection) and the
    /// metrics handle, all sharing state with what's inside the dispatcher.
    ///
    /// Pre-grants `Scope::Control`, mirroring `MockBackend`'s own
    /// default-`Granted` permission status: every test in this module below
    /// that isn't specifically about scope enforcement predates scope
    /// existing at all and is about `enabled`/dedup/permission/backend-error
    /// behavior, so it shouldn't also have to think about scope. The
    /// scope-specific tests below explicitly override this via `set_scopes`
    /// to exercise the un-granted / view-only paths.
    fn setup() -> (InputDispatcher, MockBackend, Arc<InputMetrics>) {
        let mock = MockBackend::default();
        let metrics = Arc::new(InputMetrics::default());
        let mut d = InputDispatcher::new(mock.boxed(), Arc::clone(&metrics));
        d.set_scopes(HashSet::from([Scope::Control]));
        (d, mock, metrics)
    }

    #[test]
    fn rejects_all_input_while_disabled() {
        let (mut d, _mock, metrics) = setup();
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.1,
            y: 0.1,
            ts: 1,
            seq: None,
        }]));
        let snap = metrics.snapshot();
        assert_eq!(snap.events_dropped_gated, 1);
        assert_eq!(snap.events_injected, 0);
    }

    #[test]
    fn injects_once_enabled() {
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.1,
            y: 0.1,
            ts: 1,
            seq: None,
        }]));
        assert_eq!(metrics.snapshot().events_injected, 1);
    }

    #[test]
    fn drops_stale_and_duplicate_events_by_timestamp() {
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 10,
                seq: None,
            },
            // Exact duplicate resend.
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 10,
                seq: None,
            },
            // Reordered/stale (older ts arriving late).
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 5,
                seq: None,
            },
        ]));
        let snap = metrics.snapshot();
        assert_eq!(snap.events_injected, 1);
        assert_eq!(snap.events_dropped_stale, 2);
    }

    #[test]
    fn key_repeat_with_increasing_timestamps_is_not_treated_as_duplicate() {
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::KeyDown {
                code: "KeyA".into(),
                modifiers: vec![],
                repeat: false,
                ts: 1,
                seq: None,
            },
            InputEvent::KeyDown {
                code: "KeyA".into(),
                modifiers: vec![],
                repeat: true,
                ts: 2,
                seq: None,
            },
            InputEvent::KeyDown {
                code: "KeyA".into(),
                modifiers: vec![],
                repeat: true,
                ts: 3,
                seq: None,
            },
        ]));
        assert_eq!(metrics.snapshot().events_injected, 3);
    }

    #[test]
    fn drag_emits_dragged_variant_while_button_held() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 1,
                seq: None,
            },
            InputEvent::PointerMove {
                x: 0.2,
                y: 0.2,
                ts: 2,
                seq: None,
            },
            InputEvent::PointerUp {
                x: 0.2,
                y: 0.2,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 3,
                seq: None,
            },
        ]));
        let calls = mock.calls();
        assert!(matches!(&calls[0], Call::Mouse(s) if s.contains("Down")));
        assert!(matches!(&calls[1], Call::Mouse(s) if s.contains("Drag")));
        assert!(matches!(&calls[2], Call::Mouse(s) if s.contains("Up")));
    }

    /// `held_buttons` is a `Vec` (press order), not a `HashSet`, specifically
    /// so a multi-button chord has a deterministic, documented precedence
    /// rule ("most recently pressed still-held button drives `Drag`")
    /// instead of picking an arbitrary one. See
    /// `docs/audit/m3/input-touch.md` Finding 13.
    #[test]
    fn drag_reflects_the_most_recently_pressed_still_held_button() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 1,
                seq: None,
            },
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Right,
                modifiers: vec![],
                ts: 2,
                seq: None,
            },
            InputEvent::PointerMove {
                x: 0.2,
                y: 0.2,
                ts: 3,
                seq: None,
            },
        ]));
        let calls = mock.calls();
        let drag = calls
            .iter()
            .find(|c| matches!(c, Call::Mouse(s) if s.contains("Drag")))
            .expect("expected a Drag call");
        assert!(
            matches!(drag, Call::Mouse(s) if s.contains("Right")),
            "drag should reflect Right (pressed most recently, still held), got {drag:?}"
        );

        // Releasing the most-recent button falls back to the still-held one.
        d.process_batch(batch(vec![
            InputEvent::PointerUp {
                x: 0.2,
                y: 0.2,
                button: PointerButton::Right,
                modifiers: vec![],
                ts: 4,
                seq: None,
            },
            InputEvent::PointerMove {
                x: 0.3,
                y: 0.3,
                ts: 5,
                seq: None,
            },
        ]));
        let calls = mock.calls();
        let drag = calls
            .iter()
            .rev()
            .find(|c| matches!(c, Call::Mouse(s) if s.contains("Drag")))
            .expect("expected a second Drag call after releasing Right");
        assert!(
            matches!(drag, Call::Mouse(s) if s.contains("Left")),
            "drag should fall back to Left once Right is released, got {drag:?}"
        );
    }

    #[test]
    fn disabling_mid_drag_releases_the_held_button() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::PointerDown {
            x: 0.3,
            y: 0.3,
            button: PointerButton::Left,
            modifiers: vec![],
            ts: 1,
            seq: None,
        }]));
        d.set_enabled(false); // simulate disconnect mid-drag
        let calls = mock.calls();
        assert!(
            calls
                .iter()
                .any(|c| matches!(c, Call::Mouse(s) if s.contains("Up"))),
            "expected a synthetic mouse-up releasing the held button, got {calls:?}"
        );
    }

    #[test]
    fn stuck_modifier_key_is_released_on_shutdown() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::KeyDown {
            code: "ControlLeft".into(),
            modifiers: vec![],
            repeat: false,
            ts: 1,
            seq: None,
        }]));
        d.shutdown();
        let calls = mock.calls();
        assert!(calls
            .iter()
            .any(|c| matches!(c, Call::Keyboard(s) if s.starts_with("ControlLeft:false"))));
        assert!(!d.is_enabled());
    }

    #[test]
    fn shortcut_copy_sends_primary_modifier_c_down_then_up() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::Shortcut {
            action: ShortcutAction::Copy,
            ts: 1,
            seq: None,
        }]));
        let calls = mock.calls();
        assert_eq!(calls.len(), 2);
        assert!(matches!(&calls[0], Call::Keyboard(s) if s == "KeyC:true:[Meta]"));
        assert!(matches!(&calls[1], Call::Keyboard(s) if s == "KeyC:false:[Meta]"));
    }

    #[test]
    fn permission_not_granted_drops_with_distinct_metric() {
        let (mut d, mock, metrics) = setup();
        mock.set_permission(PermissionStatus::NotGranted);
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.1,
            y: 0.1,
            ts: 1,
            seq: None,
        }]));
        let snap = metrics.snapshot();
        assert_eq!(snap.events_dropped_permission, 1);
        assert_eq!(snap.events_injected, 0);
    }

    #[test]
    fn backend_error_is_counted_as_dropped_invalid_not_a_panic() {
        let (mut d, mock, metrics) = setup();
        mock.set_fail_next(true);
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.1,
            y: 0.1,
            ts: 1,
            seq: None,
        }]));
        assert_eq!(metrics.snapshot().events_dropped_invalid, 1);
    }

    // ── scope enforcement (Finding 2: view/control scope was previously
    // unenforced anywhere in the input-injection path) ─────────────────────

    /// One representative event of every control-plane kind — pointer,
    /// click, scroll, key, text, shortcut, and clipboard — so a scope test
    /// can assert none of them slip through, not just the pointer-move case
    /// every other test in this file happens to use.
    fn every_control_plane_event() -> Vec<InputEvent> {
        vec![
            InputEvent::PointerMove {
                x: 0.1,
                y: 0.1,
                ts: 1,
                seq: None,
            },
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 2,
                seq: None,
            },
            InputEvent::PointerUp {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 3,
                seq: None,
            },
            InputEvent::Click {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                count: 1,
                ts: 4,
                seq: None,
            },
            InputEvent::Scroll {
                x: 0.1,
                y: 0.1,
                dx: 1.0,
                dy: 0.0,
                ts: 5,
                seq: None,
            },
            InputEvent::KeyDown {
                code: "KeyA".into(),
                modifiers: vec![],
                repeat: false,
                ts: 6,
                seq: None,
            },
            InputEvent::KeyUp {
                code: "KeyA".into(),
                modifiers: vec![],
                ts: 7,
                seq: None,
            },
            InputEvent::TextInput {
                text: "hello".into(),
                ts: 8,
                seq: None,
            },
            InputEvent::Shortcut {
                action: ShortcutAction::Copy,
                ts: 9,
                seq: None,
            },
            InputEvent::Clipboard {
                text: "clip".into(),
                ts: 10,
                seq: None,
            },
        ]
    }

    #[test]
    fn view_only_session_drops_every_control_plane_event_kind() {
        let (mut d, mock, metrics) = setup();
        d.set_enabled(true);
        d.set_scopes(HashSet::from([Scope::View])); // explicit view-only grant, not just absence
        let events = every_control_plane_event();
        let n = events.len() as u64;
        d.process_batch(batch(events));

        let snap = metrics.snapshot();
        assert_eq!(
            snap.events_dropped_scope, n,
            "every control-plane event must be dropped for scope when only 'view' is granted"
        );
        assert_eq!(snap.events_injected, 0, "no input may reach the OS");
        assert!(
            mock.calls().is_empty(),
            "the backend must never be called at all for a view-only session"
        );
    }

    #[test]
    fn no_scope_granted_yet_drops_input_the_same_as_view_only() {
        // A session that is `enabled` (peer connected + channel open) but has
        // never received a session-start's grantedScopes at all (or hasn't
        // yet, defensively) must fail closed exactly like an explicit
        // view-only grant — absence of a grant is never treated as consent.
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.set_scopes(HashSet::new());
        d.process_batch(batch(vec![InputEvent::Click {
            x: 0.1,
            y: 0.1,
            button: PointerButton::Left,
            modifiers: vec![],
            count: 1,
            ts: 1,
            seq: None,
        }]));
        let snap = metrics.snapshot();
        assert_eq!(snap.events_dropped_scope, 1);
        assert_eq!(snap.events_injected, 0);
    }

    #[test]
    fn control_granted_session_allows_every_event_kind_through() {
        let (mut d, _mock, metrics) = setup(); // setup() already grants Control
        d.set_enabled(true);
        let events = every_control_plane_event();
        let n = events.len() as u64;
        d.process_batch(batch(events));

        let snap = metrics.snapshot();
        assert_eq!(snap.events_dropped_scope, 0);
        assert_eq!(
            snap.events_injected, n,
            "a control-granted session must inject every event kind, unchanged from pre-scope behavior"
        );
    }

    #[test]
    fn scope_check_runs_before_dedup_bookkeeping() {
        // A dropped-for-scope attempt must not poison the stale/duplicate
        // timestamp tracker: once scope is granted, the very same (ts,
        // event-identity) pair that was previously rejected for scope must
        // still be accepted, not rejected as a stale replay.
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.set_scopes(HashSet::new());
        d.process_batch(batch(vec![InputEvent::PointerDown {
            x: 0.1,
            y: 0.1,
            button: PointerButton::Left,
            modifiers: vec![],
            ts: 10,
            seq: None,
        }]));
        assert_eq!(metrics.snapshot().events_dropped_scope, 1);

        d.set_scopes(HashSet::from([Scope::Control]));
        d.process_batch(batch(vec![InputEvent::PointerDown {
            x: 0.1,
            y: 0.1,
            button: PointerButton::Left,
            modifiers: vec![],
            ts: 10, // same ts as the scope-dropped attempt above
            seq: None,
        }]));
        let snap = metrics.snapshot();
        assert_eq!(
            snap.events_dropped_stale, 0,
            "the scope-dropped attempt must not have registered as 'last seen ts'"
        );
        assert_eq!(snap.events_injected, 1);
    }

    #[test]
    fn clipboard_write_is_rejected_without_control_scope() {
        // Clipboard called out specifically per
        // docs/audit/m3/backend-security.md Finding 9: a clipboard write is
        // unusually sensitive (can clobber a password just copied) and must
        // never reach `set_clipboard` without a control grant.
        let (mut d, mock, metrics) = setup();
        d.set_enabled(true);
        d.set_scopes(HashSet::from([Scope::View]));
        d.process_batch(batch(vec![InputEvent::Clipboard {
            text: "sensitive".into(),
            ts: 1,
            seq: None,
        }]));
        assert_eq!(metrics.snapshot().events_dropped_scope, 1);
        assert!(
            mock.calls().is_empty(),
            "clipboard must never be written to for a view-only session"
        );
    }

    #[test]
    fn revoking_scope_mid_session_stops_further_injection_immediately() {
        let (mut d, _mock, metrics) = setup(); // Control granted
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.1,
            y: 0.1,
            ts: 1,
            seq: None,
        }]));
        assert_eq!(metrics.snapshot().events_injected, 1);

        d.set_scopes(HashSet::new()); // e.g. a corrected/re-sent session-start
        d.process_batch(batch(vec![InputEvent::PointerMove {
            x: 0.2,
            y: 0.2,
            ts: 2,
            seq: None,
        }]));
        let snap = metrics.snapshot();
        assert_eq!(
            snap.events_injected, 1,
            "no new injection after scope is revoked"
        );
        assert_eq!(snap.events_dropped_scope, 1);
    }

    // ── monotonic sequence ordering (Finding 8: wall-clock `ts` could step
    // backward mid-session and permanently wedge the input stream) ──────────

    #[test]
    fn seq_keeps_ordering_when_wall_clock_ts_steps_backward() {
        // The failure this guards: the phone's clock resyncs backward (NTP,
        // sleep/resume) mid-session. With `ts`-based ordering every later
        // event would read as "stale" forever. With `seq`, a monotonically
        // increasing counter, the later events keep flowing even though `ts`
        // went down.
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 1_000_000,
                seq: Some(1),
            },
            // Clock stepped BACK (smaller ts) but seq advanced — must inject.
            InputEvent::PointerDown {
                x: 0.2,
                y: 0.2,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 5, // wall clock went backward
                seq: Some(2),
            },
        ]));
        let snap = metrics.snapshot();
        assert_eq!(
            snap.events_injected, 2,
            "seq must keep the stream alive when ts steps backward"
        );
        assert_eq!(snap.events_dropped_stale, 0);
    }

    #[test]
    fn seq_still_rejects_a_replayed_lower_sequence() {
        // The replay-protection property must survive the switch to seq: a
        // re-sent OLD event (lower seq) is still dropped.
        let (mut d, _mock, metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 1,
                seq: Some(5),
            },
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 2,
                seq: Some(3), // replay of an older event
            },
        ]));
        let snap = metrics.snapshot();
        assert_eq!(snap.events_injected, 1);
        assert_eq!(snap.events_dropped_stale, 1);
    }

    // ── mouse modifiers (Finding 5: pointer events couldn't carry modifiers,
    // so Cmd-click / Shift-click / Option-drag were impossible) ─────────────

    #[test]
    fn modifiers_on_a_click_reach_the_backend() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![InputEvent::Click {
            x: 0.1,
            y: 0.1,
            button: PointerButton::Left,
            count: 1,
            modifiers: vec![Modifier::Meta],
            ts: 1,
            seq: Some(1),
        }]));
        let calls = mock.calls();
        assert!(
            matches!(&calls[0], Call::Mouse(s) if s.contains("Meta")),
            "the Cmd modifier must be threaded into the injected click, got {calls:?}"
        );
    }

    #[test]
    fn drag_inherits_modifiers_from_the_initiating_press() {
        // pointer_move carries no modifiers; an Option-drag must inherit them
        // from the pointer_down that started the drag.
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![Modifier::Alt],
                ts: 1,
                seq: Some(1),
            },
            InputEvent::PointerMove {
                x: 0.2,
                y: 0.2,
                ts: 2,
                seq: Some(2),
            },
        ]));
        let calls = mock.calls();
        assert!(matches!(&calls[1], Call::Mouse(s) if s.contains("Drag") && s.contains("Alt")));
    }

    #[test]
    fn drag_modifiers_clear_after_the_press_is_released() {
        let (mut d, mock, _metrics) = setup();
        d.set_enabled(true);
        d.process_batch(batch(vec![
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![Modifier::Shift],
                ts: 1,
                seq: Some(1),
            },
            InputEvent::PointerUp {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![Modifier::Shift],
                ts: 2,
                seq: Some(2),
            },
            // A fresh press with NO modifier, then a move — the move must not
            // still carry the earlier Shift.
            InputEvent::PointerDown {
                x: 0.1,
                y: 0.1,
                button: PointerButton::Left,
                modifiers: vec![],
                ts: 3,
                seq: Some(3),
            },
            InputEvent::PointerMove {
                x: 0.2,
                y: 0.2,
                ts: 4,
                seq: Some(4),
            },
        ]));
        let calls = mock.calls();
        let drag = calls
            .iter()
            .rev()
            .find(|c| matches!(c, Call::Mouse(s) if s.contains("Drag")))
            .expect("a drag call");
        assert!(matches!(drag, Call::Mouse(s) if !s.contains("Shift")));
    }
}
