//! The handful of preferences that belong to this Mac rather than to an
//! account, kept in one small JSON file beside the agent's settings.
//!
//! Deliberately not in the keychain (nothing here is a secret), not in the
//! backend (a preference about a window on THIS machine is not an account
//! fact), and not in `localStorage` (the tray and the Rust side read it before
//! any webview exists).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /// Whether the floating bubble is on screen.
    ///
    /// On by default, because it is how most people reach the app and it is the
    /// only always-visible sign that Lilypad is running at all. Off is a real
    /// choice all the same: it is a 108-pixel always-on-top window sitting over
    /// someone's work, and until this existed the only way to be rid of it was
    /// to quit Lilypad — which also stopped every phone from reaching the Mac.
    /// The tray icon is the fallback entry point and is never hidden.
    pub show_bubble: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { show_bubble: true }
    }
}

fn prefs_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support/Lilypad")
        .join("desktop-prefs.json"))
}

/// Never fails: an unreadable or corrupt file means the defaults, which are the
/// behaviour every install had before this file existed.
pub fn load() -> Prefs {
    let Ok(path) = prefs_path() else {
        return Prefs::default();
    };
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

pub fn save(prefs: &Prefs) -> Result<()> {
    let path = prefs_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating the settings directory")?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(prefs)?)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default has to be the OLD behaviour, or an update would silently
    /// take the bubble away from everyone who never asked.
    #[test]
    fn the_bubble_is_on_unless_someone_turned_it_off() {
        assert!(Prefs::default().show_bubble);
        // An empty or partial file is not a preference — it is the absence of
        // one, and `serde(default)` is what makes it read that way rather than
        // failing and being swallowed as `unwrap_or_default` anyway.
        let partial: Prefs = serde_json::from_str("{}").unwrap();
        assert!(partial.show_bubble);
        let explicit: Prefs = serde_json::from_str(r#"{"showBubble":false}"#).unwrap();
        assert!(!explicit.show_bubble);
    }
}
