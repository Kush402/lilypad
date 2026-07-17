//! Windows input backend — compile-complete stub.
//!
//! The real implementation uses `SendInput()` (user32) with `INPUT_MOUSE` /
//! `INPUT_KEYBOARD` structs: absolute mouse moves via `MOUSEEVENTF_ABSOLUTE`
//! (scaled to `SM_CXSCREEN`/`SM_CYSCREEN`), `KEYEVENTF_UNICODE` for arbitrary
//! text (mirroring the macOS Unicode-typing technique), and virtual-key codes
//! (`VK_*`) for the same UI-Events-`code` table as macOS. Windows does not
//! gate synthetic input behind an explicit user permission the way macOS
//! gates Accessibility, so `permission_status()` is `NotApplicable`.
//!
//! Wiring the real calls needs a Windows machine to verify against; this
//! keeps the platform code isolated behind the same [`InputBackend`] trait so
//! swapping in the real implementation touches only this file.

use super::{
    InputBackend, KeyAction, Modifier, MouseAction, PermissionStatus, Result, ScrollAction,
};

pub struct WindowsInputBackend;

impl WindowsInputBackend {
    pub fn new() -> Self {
        Self
    }
}

impl InputBackend for WindowsInputBackend {
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
        anyhow::bail!("SendInput mouse injection not yet wired — verify on Windows")
    }
    fn inject_keyboard(&mut self, _action: KeyAction) -> Result<()> {
        anyhow::bail!("SendInput keyboard injection not yet wired — verify on Windows")
    }
    fn inject_scroll(&mut self, _action: ScrollAction) -> Result<()> {
        anyhow::bail!("SendInput scroll injection not yet wired — verify on Windows")
    }
    fn inject_text(&mut self, _text: &str) -> Result<()> {
        anyhow::bail!(
            "SendInput KEYEVENTF_UNICODE text injection not yet wired — verify on Windows"
        )
    }
    fn set_clipboard(&mut self, text: &str) -> Result<()> {
        // arboard is cross-platform — this path is real on Windows already.
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard unavailable: {e}"))?;
        clipboard
            .set_text(text.to_string())
            .map_err(|e| anyhow::anyhow!("failed to set clipboard: {e}"))
    }
    fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }
}
