//! macOS input backend — real CGEvent injection.
//!
//! Synthetic system-wide input (`CGEventPost` to the HID event stream)
//! requires **Accessibility** permission (System Settings ▸ Privacy &
//! Security ▸ Accessibility). We check `AXIsProcessTrusted()` before every
//! injection so a missing/revoked grant is reported, not silently swallowed.
//!
//! `AXIsProcessTrusted()` is an XPC round-trip to `tccd`, not a cheap local
//! check — measured at tens of milliseconds per call, which throttles a
//! sustained pointer-move stream badly if called per-event. We cache the
//! result for a short TTL; a human granting/revoking Accessibility is not a
//! latency-sensitive action, so a sub-second staleness window is invisible in
//! practice while keeping the hot path fast.

use std::cell::Cell;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField, KeyCode,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

use super::{
    InputBackend, KeyAction, Modifier, MouseAction, PermissionStatus, PointerButton, Result,
    ScrollAction,
};

const PERMISSION_CACHE_TTL: Duration = Duration::from_millis(500);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    /// The PROMPTING variant of `AXIsProcessTrusted` — triggers the native
    /// "Lilypad would like to control this computer" dialog if the user
    /// hasn't decided yet (a no-op if already granted or denied this
    /// session). `options` is a `CFDictionary` with the
    /// `kAXTrustedCheckOptionPrompt` key set to `true`.
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    /// `CFStringRef` constant naming the one recognized key in the options
    /// dictionary above — declared `static`, not `fn`, since it's data, not
    /// code (ApplicationServices exports it as a global `CFStringRef`).
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// Cheap, instance-free preflight check — `permission::accessibility_status()`
/// calls this directly (with its own process-wide cache) so the debug health
/// overlay never needs to construct a full input backend just to ask the OS
/// a yes/no question.
pub(crate) fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Actively request Accessibility, prompting the user if undecided. Used by
/// the first-run Setup flow's "Grant" button — see
/// `docs/audit/m3/desktop-ux.md` Finding 1. Distinct from
/// `accessibility_trusted()` above (the passive check used on the hot input
/// path and by the ongoing health poll), which must never itself trigger a
/// dialog mid-session.
pub(crate) fn accessibility_request() -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

// CGEventSource is created fresh per call (see `source()`), rather than
// stored on the struct — the foreign-type wrapper around the CF pointer
// doesn't implement `Send`, and this backend must satisfy `InputBackend: Send`
// to be constructed inside the dedicated input-worker thread. Creating one is
// a cheap Core Graphics call, not a heavyweight resource.
pub struct MacInputBackend {
    initialized: bool,
    /// (checked_at, was_trusted) — see the module-level note on why this is
    /// cached instead of calling `AXIsProcessTrusted()` on every check.
    permission_cache: Cell<Option<(Instant, bool)>>,
}

impl MacInputBackend {
    pub fn new() -> Self {
        Self {
            initialized: false,
            permission_cache: Cell::new(None),
        }
    }

    fn cached_accessibility_trusted(&self) -> bool {
        let now = Instant::now();
        if let Some((checked_at, trusted)) = self.permission_cache.get() {
            if now.duration_since(checked_at) < PERMISSION_CACHE_TTL {
                return trusted;
            }
        }
        let trusted = accessibility_trusted();
        self.permission_cache.set(Some((now, trusted)));
        trusted
    }

    fn source(&self) -> anyhow::Result<CGEventSource> {
        if !self.initialized {
            anyhow::bail!("input backend not initialized");
        }
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| anyhow::anyhow!("failed to create CGEventSource"))
    }

    /// Main display size in points, used to map normalized 0..1 coordinates
    /// to the absolute screen space CGEvent expects.
    ///
    /// Coordinates arrive as raw `f64` from the phone (JSON), so a modified or
    /// buggy client could send out-of-range or non-finite values. Clamp to the
    /// normalized [0, 1] range and treat any non-finite value as 0 — an
    /// injected event must always land on the actual screen, never at a
    /// degenerate (NaN) or off-screen point. See the 2026-07-19 security audit.
    fn screen_point(&self, x: f64, y: f64) -> CGPoint {
        let bounds = CGDisplay::main().bounds();
        let clamp01 = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        CGPoint::new(
            bounds.size.width * clamp01(x),
            bounds.size.height * clamp01(y),
        )
    }

    fn require_permission(&self) -> anyhow::Result<()> {
        if self.cached_accessibility_trusted() {
            Ok(())
        } else {
            anyhow::bail!(
                "Accessibility permission not granted — grant Lilypad access in \
                 System Settings ▸ Privacy & Security ▸ Accessibility, then reconnect"
            )
        }
    }

    fn button_type(button: PointerButton, down: bool) -> (CGEventType, CGMouseButton) {
        let cg_button = match button {
            PointerButton::Left => CGMouseButton::Left,
            PointerButton::Right => CGMouseButton::Right,
            PointerButton::Middle => CGMouseButton::Center,
        };
        let event_type = match (button, down) {
            (PointerButton::Left, true) => CGEventType::LeftMouseDown,
            (PointerButton::Left, false) => CGEventType::LeftMouseUp,
            (PointerButton::Right, true) => CGEventType::RightMouseDown,
            (PointerButton::Right, false) => CGEventType::RightMouseUp,
            (PointerButton::Middle, true) => CGEventType::OtherMouseDown,
            (PointerButton::Middle, false) => CGEventType::OtherMouseUp,
        };
        (event_type, cg_button)
    }

    fn dragged_type(button: PointerButton) -> CGEventType {
        match button {
            PointerButton::Left => CGEventType::LeftMouseDragged,
            PointerButton::Right => CGEventType::RightMouseDragged,
            PointerButton::Middle => CGEventType::OtherMouseDragged,
        }
    }

    fn post_mouse(
        &self,
        event_type: CGEventType,
        point: CGPoint,
        button: CGMouseButton,
    ) -> anyhow::Result<()> {
        self.post_mouse_with_flags(event_type, point, button, &[])
    }

    /// Post a mouse event carrying keyboard-modifier flags (Cmd-click,
    /// Shift-click, Option-drag, …). See `docs/audit/m3/input-touch.md`
    /// Finding 5. `inject_keyboard` already sets flags this same way; mouse
    /// events previously never did.
    fn post_mouse_with_flags(
        &self,
        event_type: CGEventType,
        point: CGPoint,
        button: CGMouseButton,
        modifiers: &[Modifier],
    ) -> anyhow::Result<()> {
        let event = CGEvent::new_mouse_event(self.source()?, event_type, point, button)
            .map_err(|_| anyhow::anyhow!("CGEventCreateMouseEvent failed"))?;
        if !modifiers.is_empty() {
            event.set_flags(Self::modifier_flags(modifiers));
        }
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn modifier_flags(modifiers: &[Modifier]) -> CGEventFlags {
        let mut flags = CGEventFlags::CGEventFlagNull;
        for m in modifiers {
            flags |= match m {
                Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
                Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
                Modifier::Shift => CGEventFlags::CGEventFlagShift,
                Modifier::Meta => CGEventFlags::CGEventFlagCommand,
            };
        }
        flags
    }
}

impl InputBackend for MacInputBackend {
    fn initialize(&mut self) -> Result<()> {
        // Fail fast if the OS refuses to hand out an event source at all.
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| anyhow::anyhow!("failed to create CGEventSource"))?;
        self.initialized = true;
        if !accessibility_trusted() {
            log::warn!(
                target: "lilypad::input",
                "Accessibility permission not granted yet — input will be rejected until the user grants it"
            );
        }
        Ok(())
    }

    fn permission_status(&self) -> PermissionStatus {
        if self.cached_accessibility_trusted() {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }

    fn primary_modifier(&self) -> Modifier {
        Modifier::Meta // Cmd
    }

    fn inject_mouse(&mut self, action: MouseAction) -> Result<()> {
        self.require_permission()?;
        match action {
            MouseAction::Move { x, y } => {
                let point = self.screen_point(x, y);
                self.post_mouse(CGEventType::MouseMoved, point, CGMouseButton::Left)
            }
            MouseAction::Drag {
                x,
                y,
                button,
                modifiers,
            } => {
                let point = self.screen_point(x, y);
                let (_, cg_button) = Self::button_type(button, true);
                self.post_mouse_with_flags(Self::dragged_type(button), point, cg_button, &modifiers)
            }
            MouseAction::Down {
                x,
                y,
                button,
                modifiers,
            } => {
                let point = self.screen_point(x, y);
                let (event_type, cg_button) = Self::button_type(button, true);
                self.post_mouse_with_flags(event_type, point, cg_button, &modifiers)
            }
            MouseAction::Up {
                x,
                y,
                button,
                modifiers,
            } => {
                let point = self.screen_point(x, y);
                let (event_type, cg_button) = Self::button_type(button, false);
                self.post_mouse_with_flags(event_type, point, cg_button, &modifiers)
            }
            MouseAction::Click {
                x,
                y,
                button,
                count,
                modifiers,
            } => {
                let point = self.screen_point(x, y);
                let (down_type, cg_button) = Self::button_type(button, true);
                let (up_type, _) = Self::button_type(button, false);
                let flags = Self::modifier_flags(&modifiers);
                // macOS derives double/triple-click from `clickState` on the
                // event, NOT from wall-clock timing between injected events.
                // `count` IS that state: the mobile app sends tap 1 as
                // count=1 and the follow-up tap of a double-tap as count=2 —
                // one down/up pair per click, stamped with its position in
                // the sequence, exactly mirroring native click delivery.
                // (Before this fix nothing stamped clickState, so a remote
                // double-click never opened anything.)
                let click_state = i64::from(count.max(1));
                let down = CGEvent::new_mouse_event(self.source()?, down_type, point, cg_button)
                    .map_err(|_| anyhow::anyhow!("CGEventCreateMouseEvent failed"))?;
                down.set_flags(flags);
                down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
                down.post(CGEventTapLocation::HID);
                let up = CGEvent::new_mouse_event(self.source()?, up_type, point, cg_button)
                    .map_err(|_| anyhow::anyhow!("CGEventCreateMouseEvent failed"))?;
                up.set_flags(flags);
                up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
                up.post(CGEventTapLocation::HID);
                Ok(())
            }
        }
    }

    fn inject_keyboard(&mut self, action: KeyAction) -> Result<()> {
        self.require_permission()?;
        let keycode = code_to_keycode(&action.code)
            .ok_or_else(|| anyhow::anyhow!("unmapped key code: {}", action.code))?;
        let event = CGEvent::new_keyboard_event(self.source()?, keycode, action.down)
            .map_err(|_| anyhow::anyhow!("CGEventCreateKeyboardEvent failed"))?;
        event.set_flags(Self::modifier_flags(&action.modifiers));
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn inject_scroll(&mut self, action: ScrollAction) -> Result<()> {
        self.require_permission()?;
        // Deltas are raw f64 from the phone: a non-finite value casts to a
        // saturated i32 (Inf → i32::MAX) — a single frame that scrolls the
        // content by billions of pixels. Zero non-finite deltas and bound the
        // per-event magnitude to a large-but-sane pixel range. See the
        // 2026-07-19 security audit.
        const MAX_SCROLL_PX: f64 = 10_000.0;
        let bound = |v: f64| {
            if v.is_finite() {
                v.clamp(-MAX_SCROLL_PX, MAX_SCROLL_PX)
            } else {
                0.0
            }
        };
        // dy in the protocol: positive scrolls content down ⇒ wheel delta is
        // negative (natural direction matches AppKit's "scroll" semantics).
        let event = CGEvent::new_scroll_event(
            self.source()?,
            ScrollEventUnit::PIXEL,
            2,
            -(bound(action.dy).round() as i32),
            -(bound(action.dx).round() as i32),
            0,
        )
        .map_err(|_| anyhow::anyhow!("CGEventCreateScrollWheelEvent failed"))?;
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn inject_text(&mut self, text: &str) -> Result<()> {
        self.require_permission()?;
        // Unicode-typing technique: a keycode-0 key event carrying the string
        // payload types arbitrary text without per-key mapping.
        let down = CGEvent::new_keyboard_event(self.source()?, 0, true)
            .map_err(|_| anyhow::anyhow!("CGEventCreateKeyboardEvent failed"))?;
        down.set_string(text);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(self.source()?, 0, false)
            .map_err(|_| anyhow::anyhow!("CGEventCreateKeyboardEvent failed"))?;
        up.set_string(text);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn set_clipboard(&mut self, text: &str) -> Result<()> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard unavailable: {e}"))?;
        clipboard
            .set_text(text.to_string())
            .map_err(|e| anyhow::anyhow!("failed to set clipboard: {e}"))
    }

    fn shutdown(&mut self) -> Result<()> {
        self.initialized = false;
        Ok(())
    }
}

/// UI Events `code` (physical key position) → macOS virtual keycode. Both are
/// positional, not character-based, so this mapping is layout-agnostic.
fn code_to_keycode(code: &str) -> Option<u16> {
    Some(match code {
        "KeyA" => KeyCode::ANSI_A,
        "KeyB" => KeyCode::ANSI_B,
        "KeyC" => KeyCode::ANSI_C,
        "KeyD" => KeyCode::ANSI_D,
        "KeyE" => KeyCode::ANSI_E,
        "KeyF" => KeyCode::ANSI_F,
        "KeyG" => KeyCode::ANSI_G,
        "KeyH" => KeyCode::ANSI_H,
        "KeyI" => KeyCode::ANSI_I,
        "KeyJ" => KeyCode::ANSI_J,
        "KeyK" => KeyCode::ANSI_K,
        "KeyL" => KeyCode::ANSI_L,
        "KeyM" => KeyCode::ANSI_M,
        "KeyN" => KeyCode::ANSI_N,
        "KeyO" => KeyCode::ANSI_O,
        "KeyP" => KeyCode::ANSI_P,
        "KeyQ" => KeyCode::ANSI_Q,
        "KeyR" => KeyCode::ANSI_R,
        "KeyS" => KeyCode::ANSI_S,
        "KeyT" => KeyCode::ANSI_T,
        "KeyU" => KeyCode::ANSI_U,
        "KeyV" => KeyCode::ANSI_V,
        "KeyW" => KeyCode::ANSI_W,
        "KeyX" => KeyCode::ANSI_X,
        "KeyY" => KeyCode::ANSI_Y,
        "KeyZ" => KeyCode::ANSI_Z,
        "Digit0" => KeyCode::ANSI_0,
        "Digit1" => KeyCode::ANSI_1,
        "Digit2" => KeyCode::ANSI_2,
        "Digit3" => KeyCode::ANSI_3,
        "Digit4" => KeyCode::ANSI_4,
        "Digit5" => KeyCode::ANSI_5,
        "Digit6" => KeyCode::ANSI_6,
        "Digit7" => KeyCode::ANSI_7,
        "Digit8" => KeyCode::ANSI_8,
        "Digit9" => KeyCode::ANSI_9,
        "Minus" => KeyCode::ANSI_MINUS,
        "Equal" => KeyCode::ANSI_EQUAL,
        "BracketLeft" => KeyCode::ANSI_LEFT_BRACKET,
        "BracketRight" => KeyCode::ANSI_RIGHT_BRACKET,
        "Backslash" => KeyCode::ANSI_BACKSLASH,
        "Semicolon" => KeyCode::ANSI_SEMICOLON,
        "Quote" => KeyCode::ANSI_QUOTE,
        "Comma" => KeyCode::ANSI_COMMA,
        "Period" => KeyCode::ANSI_PERIOD,
        "Slash" => KeyCode::ANSI_SLASH,
        "Backquote" => KeyCode::ANSI_GRAVE,
        "Enter" => KeyCode::RETURN,
        "Tab" => KeyCode::TAB,
        "Space" => KeyCode::SPACE,
        "Backspace" => KeyCode::DELETE,
        "Delete" => KeyCode::FORWARD_DELETE,
        "Escape" => KeyCode::ESCAPE,
        "CapsLock" => KeyCode::CAPS_LOCK,
        "ArrowLeft" => KeyCode::LEFT_ARROW,
        "ArrowRight" => KeyCode::RIGHT_ARROW,
        "ArrowUp" => KeyCode::UP_ARROW,
        "ArrowDown" => KeyCode::DOWN_ARROW,
        "ControlLeft" => KeyCode::CONTROL,
        "ControlRight" => KeyCode::RIGHT_CONTROL,
        "ShiftLeft" => KeyCode::SHIFT,
        "ShiftRight" => KeyCode::RIGHT_SHIFT,
        "AltLeft" => KeyCode::OPTION,
        "AltRight" => KeyCode::RIGHT_OPTION,
        "MetaLeft" => KeyCode::COMMAND,
        "MetaRight" => KeyCode::RIGHT_COMMAND,
        "Home" => KeyCode::HOME,
        "End" => KeyCode::END,
        "PageUp" => KeyCode::PAGE_UP,
        "PageDown" => KeyCode::PAGE_DOWN,
        "F1" => KeyCode::F1,
        "F2" => KeyCode::F2,
        "F3" => KeyCode::F3,
        "F4" => KeyCode::F4,
        "F5" => KeyCode::F5,
        "F6" => KeyCode::F6,
        "F7" => KeyCode::F7,
        "F8" => KeyCode::F8,
        "F9" => KeyCode::F9,
        "F10" => KeyCode::F10,
        "F11" => KeyCode::F11,
        "F12" => KeyCode::F12,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_codes() {
        assert_eq!(code_to_keycode("KeyA"), Some(KeyCode::ANSI_A));
        assert_eq!(code_to_keycode("Digit1"), Some(KeyCode::ANSI_1));
        assert_eq!(code_to_keycode("Enter"), Some(KeyCode::RETURN));
        assert_eq!(code_to_keycode("ArrowLeft"), Some(KeyCode::LEFT_ARROW));
        assert_eq!(code_to_keycode("MetaLeft"), Some(KeyCode::COMMAND));
    }

    #[test]
    fn rejects_unknown_codes() {
        assert_eq!(code_to_keycode("SomeUnknownKey"), None);
        assert_eq!(code_to_keycode(""), None);
    }

    #[test]
    fn every_mapped_keycode_is_distinct_per_letter_row() {
        // Sanity check the table isn't accidentally aliasing two different
        // physical keys onto the same virtual keycode.
        let codes = ["KeyA", "KeyB", "KeyC", "KeyD", "Digit1", "Digit2"];
        let mapped: Vec<u16> = codes.iter().map(|c| code_to_keycode(c).unwrap()).collect();
        let unique: std::collections::HashSet<_> = mapped.iter().collect();
        assert_eq!(unique.len(), mapped.len());
    }
}
