//! Desktop input injection — the final stage of the pipeline:
//!
//!   Touch → DataChannel → Input Protocol → Dispatcher → InputBackend → OS
//!
//! `InputBackend` is the per-OS abstraction (CGEvent on macOS, SendInput on
//! Windows); `InputDispatcher` is the OS-agnostic gating/dedup/state logic
//! that drives it, fully unit-testable behind a mock backend.

pub mod dispatcher;
pub mod metrics;
pub mod protocol;
pub mod worker;

#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub use dispatcher::{InputDispatcher, Scope};
pub use metrics::{InputMetrics, InputMetricsSnapshot};
pub use protocol::{
    decode_input_batch, InputBatch, InputEvent, Modifier, PointerButton, ShortcutAction,
};
pub use worker::InputWorker;

/// Whether the OS has granted the permission real injection needs (macOS:
/// Accessibility). Surfaced to the UI so a missing grant is never silent.
/// Shared shape with `media::capture`'s Screen Recording status — see
/// `crate::permission`.
pub use crate::permission::PermissionStatus;

/// `modifiers` (Ctrl/Alt/Shift/Meta) let a click or drag carry keyboard
/// chords — Cmd-click, Shift-click, Option-drag — without the caller having
/// to separately synthesize modifier key-down/up events around the gesture.
/// See `docs/audit/m3/input-touch.md` Finding 5. `Move` (no button held)
/// carries none: a bare hover chord has no meaning.
///
/// Not `Copy` because of the `Vec<Modifier>` payload — it's always moved into
/// `inject_mouse`, so `Clone` suffices.
#[derive(Debug, Clone)]
pub enum MouseAction {
    /// Pure cursor move, no button held.
    Move { x: f64, y: f64 },
    /// Cursor move while `button` is held (drag).
    Drag {
        x: f64,
        y: f64,
        button: PointerButton,
        modifiers: Vec<Modifier>,
    },
    Down {
        x: f64,
        y: f64,
        button: PointerButton,
        modifiers: Vec<Modifier>,
    },
    Up {
        x: f64,
        y: f64,
        button: PointerButton,
        modifiers: Vec<Modifier>,
    },
    /// A discrete click (down+up) at a point; `count` is 1/2/3 for single/
    /// double/triple click.
    Click {
        x: f64,
        y: f64,
        button: PointerButton,
        count: u8,
        modifiers: Vec<Modifier>,
    },
}

#[derive(Debug, Clone)]
pub struct KeyAction {
    /// Physical key per the UI Events `code` set, e.g. "KeyA", "Enter".
    pub code: String,
    pub down: bool,
    pub modifiers: Vec<Modifier>,
    pub repeat: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollAction {
    pub x: f64,
    pub y: f64,
    pub dx: f64,
    pub dy: f64,
}

pub type Result<T> = anyhow::Result<T>;

/// The per-OS input injection surface. Coordinates in [`MouseAction`] /
/// [`ScrollAction`] are normalized 0..1; each backend maps them to its own
/// display's pixel/point space, so the dispatcher never needs to know screen
/// geometry.
pub trait InputBackend: Send {
    fn initialize(&mut self) -> Result<()>;
    /// Current OS permission state; checked before every real injection so a
    /// mid-session grant/revoke is honored without a restart.
    fn permission_status(&self) -> PermissionStatus;
    /// The modifier this OS uses for "primary" shortcuts (Cmd on macOS, Ctrl
    /// elsewhere) — lets the shortcut mapping stay OS-agnostic.
    fn primary_modifier(&self) -> Modifier;
    fn inject_mouse(&mut self, action: MouseAction) -> Result<()>;
    fn inject_keyboard(&mut self, action: KeyAction) -> Result<()>;
    fn inject_scroll(&mut self, action: ScrollAction) -> Result<()>;
    /// Type an arbitrary Unicode string as a unit (IME/autocorrect friendly),
    /// bypassing per-key mapping.
    fn inject_text(&mut self, text: &str) -> Result<()>;
    /// Phone → desktop paste bridge: set the OS clipboard.
    fn set_clipboard(&mut self, text: &str) -> Result<()>;
    fn shutdown(&mut self) -> Result<()>;
}

/// Build the backend for the compiled target.
pub fn create_input_backend() -> Box<dyn InputBackend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacInputBackend::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsInputBackend::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(UnsupportedInputBackend)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct UnsupportedInputBackend;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl InputBackend for UnsupportedInputBackend {
    fn initialize(&mut self) -> Result<()> {
        Ok(())
    }
    fn permission_status(&self) -> PermissionStatus {
        PermissionStatus::NotApplicable
    }
    fn primary_modifier(&self) -> Modifier {
        Modifier::Ctrl
    }
    fn inject_mouse(&mut self, _action: MouseAction) -> Result<()> {
        anyhow::bail!("input injection not available on this OS")
    }
    fn inject_keyboard(&mut self, _action: KeyAction) -> Result<()> {
        anyhow::bail!("input injection not available on this OS")
    }
    fn inject_scroll(&mut self, _action: ScrollAction) -> Result<()> {
        anyhow::bail!("input injection not available on this OS")
    }
    fn inject_text(&mut self, _text: &str) -> Result<()> {
        anyhow::bail!("input injection not available on this OS")
    }
    fn set_clipboard(&mut self, _text: &str) -> Result<()> {
        anyhow::bail!("clipboard not available on this OS")
    }
    fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }
}
