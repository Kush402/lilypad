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
use core_graphics::geometry::{CGPoint, CGRect};

use super::{
    InputBackend, KeyAction, Modifier, MouseAction, PermissionStatus, PointerButton, Result,
    ScrollAction, PHONE_EVENT_TAG,
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
    /// The display the session is showing (`CGDirectDisplayID`), or `None` for
    /// the main one. See `screen_point`.
    target_display: Option<u32>,
    /// Stamped into `kCGEventSourceUserData` on every event, so a listener can
    /// tell the phone's input and Ask's input from a person at the Mac.
    event_tag: i64,
    /// Character → key on the current layout, and when it was read.
    layout: Option<(Instant, layout::CharMap)>,
}

impl MacInputBackend {
    pub fn new() -> Self {
        Self {
            initialized: false,
            permission_cache: Cell::new(None),
            target_display: None,
            event_tag: PHONE_EVENT_TAG,
            layout: None,
        }
    }

    fn tag(&self, event: &CGEvent) {
        event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, self.event_tag);
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

    /// The captured display's rectangle in points, used to map normalized
    /// 0..1 coordinates to the absolute screen space CGEvent expects.
    ///
    /// CGEvent coordinates are GLOBAL: every display occupies its own
    /// rectangle in one shared space, with only the main display's origin at
    /// (0, 0). So the origin has to be added, or a session showing the second
    /// monitor injects every tap onto the first — the display switcher's
    /// whole point, silently undone. For the main display the origin is (0, 0)
    /// and this is arithmetically identical to what it replaced.
    ///
    /// A display that has been unplugged since the switch reports a zero rect;
    /// fall back to the main display rather than injecting at (0, 0), which
    /// on macOS is the menu bar.
    ///
    /// Coordinates arrive as raw `f64` from the phone (JSON), so a modified or
    /// buggy client could send out-of-range or non-finite values. Clamp to the
    /// normalized [0, 1] range and treat any non-finite value as 0 — an
    /// injected event must always land on the actual screen, never at a
    /// degenerate (NaN) or off-screen point. See the 2026-07-19 security audit.
    fn screen_point(&self, x: f64, y: f64) -> CGPoint {
        map_normalized(self.target_bounds(), x, y)
    }

    /// The target display's global rectangle, or the main display's when no
    /// display has been chosen or the chosen one has gone away.
    fn target_bounds(&self) -> CGRect {
        if let Some(id) = self.target_display {
            let bounds = CGDisplay::new(id).bounds();
            if bounds.size.width > 0.0 && bounds.size.height > 0.0 {
                return bounds;
            }
        }
        CGDisplay::main().bounds()
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
        self.tag(&event);
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

    fn set_target_display(&mut self, display_id: Option<u32>) {
        self.target_display = display_id;
    }

    fn set_event_tag(&mut self, tag: i64) {
        self.event_tag = tag;
    }

    fn cursor_position(&self) -> Option<(f64, f64)> {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
        let at = CGEvent::new(source).ok()?.location();
        let b = self.target_bounds();
        let x = (at.x - b.origin.x) / b.size.width;
        let y = (at.y - b.origin.y) / b.size.height;
        ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x, y))
    }

    fn key_for_char(&mut self, c: char) -> Option<(String, bool)> {
        // Re-read at most every few seconds: a person can switch layouts while
        // Ask runs, and reading costs a hop to the main thread.
        let stale = self
            .layout
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > LAYOUT_TTL);
        if stale {
            if let Some(map) = layout::current() {
                self.layout = Some((Instant::now(), map));
            }
        }
        match &self.layout {
            Some((_, map)) if !map.is_empty() => {
                let (keycode, shift) = *map.get(&c)?;
                Some((keycode_to_code(keycode)?.to_string(), shift))
            }
            // The layout could not be read at all: US is the honest guess.
            _ => super::keys::us_key_for_char(c),
        }
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
                self.tag(&down);
                down.post(CGEventTapLocation::HID);
                let up = CGEvent::new_mouse_event(self.source()?, up_type, point, cg_button)
                    .map_err(|_| anyhow::anyhow!("CGEventCreateMouseEvent failed"))?;
                up.set_flags(flags);
                up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
                self.tag(&up);
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
        self.tag(&event);
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
        self.tag(&event);
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
        self.tag(&down);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(self.source()?, 0, false)
            .map_err(|_| anyhow::anyhow!("CGEventCreateKeyboardEvent failed"))?;
        up.set_string(text);
        self.tag(&up);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn set_clipboard(&mut self, text: &str) -> Result<()> {
        // Via `crate::clipboard` so this write is serialized against the
        // session tick's clipboard poll — see CRASH-1.
        crate::clipboard::write_text(text)
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
        "F13" => 0x69,
        "F14" => 0x6B,
        "F15" => 0x71,
        "F16" => 0x6A,
        "F17" => 0x40,
        "F18" => 0x4F,
        "F19" => 0x50,
        "F20" => 0x5A,
        "Help" => 0x72,
        "IntlBackslash" => 0x0A,
        "IntlYen" => 0x5D,
        "IntlRo" => 0x5E,
        "NumpadDecimal" => 0x41,
        "NumpadMultiply" => 0x43,
        "NumpadAdd" => 0x45,
        "NumpadClear" => 0x47,
        "NumpadDivide" => 0x4B,
        "NumpadEnter" => 0x4C,
        "NumpadSubtract" => 0x4E,
        "NumpadEqual" => 0x51,
        "Numpad0" => 0x52,
        "Numpad1" => 0x53,
        "Numpad2" => 0x54,
        "Numpad3" => 0x55,
        "Numpad4" => 0x56,
        "Numpad5" => 0x57,
        "Numpad6" => 0x58,
        "Numpad7" => 0x59,
        "Numpad8" => 0x5B,
        "Numpad9" => 0x5C,
        _ => return None,
    })
}

/// Every code [`code_to_keycode`] knows, for the reverse lookup.
const KNOWN_CODES: &[&str] = &[
    "KeyA",
    "KeyB",
    "KeyC",
    "KeyD",
    "KeyE",
    "KeyF",
    "KeyG",
    "KeyH",
    "KeyI",
    "KeyJ",
    "KeyK",
    "KeyL",
    "KeyM",
    "KeyN",
    "KeyO",
    "KeyP",
    "KeyQ",
    "KeyR",
    "KeyS",
    "KeyT",
    "KeyU",
    "KeyV",
    "KeyW",
    "KeyX",
    "KeyY",
    "KeyZ",
    "Digit0",
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "Backquote",
    "Space",
    "IntlBackslash",
    "IntlYen",
    "IntlRo",
];

/// The UI Events code for a character key's virtual keycode.
fn keycode_to_code(keycode: u16) -> Option<&'static str> {
    KNOWN_CODES
        .iter()
        .copied()
        .find(|code| code_to_keycode(code) == Some(keycode))
}

/// How long a read of the keyboard layout is trusted.
const LAYOUT_TTL: Duration = Duration::from_secs(5);

/// The current keyboard layout, read the only way macOS allows.
///
/// Text Input Sources must be queried on the main thread — off it, recent
/// macOS versions assert and abort the process. The input thread therefore
/// asks the main queue and waits a bounded time; in a process whose main
/// thread is not running an event loop (a unit test), the answer never comes
/// and the caller falls back to US.
mod layout {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    use core_foundation::string::CFStringRef;

    /// Character → (virtual keycode, needs Shift).
    pub type CharMap = HashMap<char, (u16, bool)>;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(source: *mut c_void, key: CFStringRef) -> *const c_void;
        static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
        fn LMGetKbdType() -> u8;
        #[allow(clippy::too_many_arguments)]
        fn UCKeyTranslate(
            layout: *const c_void,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(cf: *const c_void);
    }

    extern "C" {
        static _dispatch_main_q: u8;
        fn dispatch_async_f(
            queue: *const c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    const K_UC_KEY_ACTION_DISPLAY: u16 = 3;
    const K_UC_KEY_TRANSLATE_NO_DEAD_KEYS: u32 = 1;
    /// `(shiftKey >> 8) & 0xFF`, the form UCKeyTranslate wants.
    const SHIFT_STATE: u32 = 2;
    /// Keypad keycodes: they type digits too, but a shortcut means the main
    /// row.
    const KEYPAD: &[u16] = &[
        0x41, 0x43, 0x45, 0x47, 0x4B, 0x4C, 0x4E, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
        0x59, 0x5B, 0x5C,
    ];

    /// Only call on the main thread.
    unsafe fn read_on_main() -> Option<CharMap> {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        let result = if data.is_null() {
            None
        } else {
            let layout = CFDataGetBytePtr(data) as *const c_void;
            let kbd = u32::from(LMGetKbdType());
            let mut map = CharMap::new();
            for (shift, state) in [(false, 0), (true, SHIFT_STATE)] {
                for keycode in 0u16..0x80 {
                    if KEYPAD.contains(&keycode) {
                        continue;
                    }
                    let mut dead = 0u32;
                    let mut len = 0usize;
                    let mut buf = [0u16; 4];
                    let status = UCKeyTranslate(
                        layout,
                        keycode,
                        K_UC_KEY_ACTION_DISPLAY,
                        state,
                        kbd,
                        K_UC_KEY_TRANSLATE_NO_DEAD_KEYS,
                        &mut dead,
                        buf.len(),
                        &mut len,
                        buf.as_mut_ptr(),
                    );
                    if status != 0 || len != 1 {
                        continue;
                    }
                    if let Some(c) = char::from_u32(u32::from(buf[0])) {
                        if !c.is_control() {
                            map.entry(c).or_insert((keycode, shift));
                        }
                    }
                }
            }
            Some(map)
        };
        CFRelease(source);
        result
    }

    extern "C" fn work(context: *mut c_void) {
        // SAFETY: `context` is the boxed sender `current` leaked for exactly
        // this one call.
        let tx = unsafe { Box::from_raw(context as *mut mpsc::Sender<Option<CharMap>>) };
        let _ = tx.send(unsafe { read_on_main() });
    }

    /// Read the layout via the main thread, waiting at most a moment.
    pub fn current() -> Option<CharMap> {
        let (tx, rx) = mpsc::channel::<Option<CharMap>>();
        let context = Box::into_raw(Box::new(tx)) as *mut c_void;
        unsafe {
            dispatch_async_f(
                &_dispatch_main_q as *const u8 as *const c_void,
                context,
                work,
            );
        }
        rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
    }
}

/// Normalized 0..1 → a point inside `bounds`, in CGEvent's global space.
/// Free-standing so the arithmetic can be tested against a second display's
/// rectangle without one being plugged in.
fn map_normalized(bounds: CGRect, x: f64, y: f64) -> CGPoint {
    let clamp01 = |v: f64| {
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    CGPoint::new(
        bounds.origin.x + bounds.size.width * clamp01(x),
        bounds.origin.y + bounds.size.height * clamp01(y),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_graphics::geometry::CGSize;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> CGRect {
        CGRect::new(&CGPoint::new(x, y), &CGSize::new(w, h))
    }

    /// The main display's origin is (0, 0), so this is the behaviour that
    /// existed before displays could be switched — pinned so the added origin
    /// term can never move a single-display session's taps.
    #[test]
    fn the_main_display_maps_exactly_as_it_always_did() {
        let main = rect(0.0, 0.0, 1512.0, 982.0);
        let p = map_normalized(main, 0.5, 0.25);
        assert_eq!((p.x, p.y), (756.0, 245.5));
    }

    /// The whole point of the switcher: a tap on the second monitor has to
    /// land on the second monitor. Without the origin term this returns
    /// (1720, 720) — a point on the BUILT-IN display, which is what every tap
    /// would have hit.
    #[test]
    fn a_second_display_maps_into_its_own_slice_of_the_global_space() {
        let second = rect(1512.0, 0.0, 3440.0, 1440.0);
        let p = map_normalized(second, 0.5, 0.5);
        assert_eq!((p.x, p.y), (1512.0 + 1720.0, 720.0));
    }

    /// Displays can sit above or to the left of the main one, which macOS
    /// expresses as a NEGATIVE origin.
    #[test]
    fn a_display_left_of_the_main_one_maps_into_negative_space() {
        let left = rect(-1920.0, -200.0, 1920.0, 1080.0);
        let p = map_normalized(left, 0.0, 0.0);
        assert_eq!((p.x, p.y), (-1920.0, -200.0));
    }

    /// A modified client can send anything; an injected event must always land
    /// on the target display, never outside it and never at NaN.
    #[test]
    fn hostile_coordinates_still_land_inside_the_target_display() {
        let second = rect(1512.0, 0.0, 3440.0, 1440.0);
        for (x, y) in [
            (-5.0, -5.0),
            (99.0, 99.0),
            (f64::NAN, f64::NAN),
            (f64::INFINITY, f64::NEG_INFINITY),
        ] {
            let p = map_normalized(second, x, y);
            assert!(
                (1512.0..=1512.0 + 3440.0).contains(&p.x),
                "x {} escaped the display for input {x}",
                p.x
            );
            assert!(
                (0.0..=1440.0).contains(&p.y),
                "y {} escaped the display for input {y}",
                p.y
            );
        }
    }

    /// An id for a monitor that was unplugged mid-session reports a zero rect.
    /// Falling back to the main display keeps taps on a real screen instead of
    /// pinning them to the global origin, which on macOS is the menu bar.
    #[test]
    fn an_unplugged_display_falls_back_to_the_main_one() {
        let mut backend = MacInputBackend::new();
        backend.set_target_display(Some(0xDEAD_BEEF));
        let bounds = backend.target_bounds();
        assert_eq!(bounds.size.width, CGDisplay::main().bounds().size.width);
        assert!(bounds.size.width > 0.0);
    }

    #[test]
    fn maps_known_codes() {
        assert_eq!(code_to_keycode("KeyA"), Some(KeyCode::ANSI_A));
        assert_eq!(code_to_keycode("Digit1"), Some(KeyCode::ANSI_1));
        assert_eq!(code_to_keycode("Enter"), Some(KeyCode::RETURN));
        assert_eq!(code_to_keycode("ArrowLeft"), Some(KeyCode::LEFT_ARROW));
        assert_eq!(code_to_keycode("MetaLeft"), Some(KeyCode::COMMAND));
    }

    #[test]
    fn every_code_the_chord_parser_emits_has_a_keycode() {
        for code in [
            "Enter",
            "NumpadEnter",
            "Tab",
            "Backspace",
            "Delete",
            "Escape",
            "ArrowUp",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Help",
            "CapsLock",
            "F1",
            "F13",
            "F20",
            "Numpad0",
            "Numpad9",
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            "NumpadEqual",
            "NumpadClear",
            "ControlLeft",
            "AltLeft",
            "ShiftLeft",
            "MetaLeft",
        ] {
            assert!(code_to_keycode(code).is_some(), "{code}");
        }
        // And the reverse lookup the layout path depends on round-trips.
        for code in KNOWN_CODES {
            assert_eq!(keycode_to_code(code_to_keycode(code).unwrap()), Some(*code));
        }
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
