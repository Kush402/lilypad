//! Shared desktop application state, guarded by a Mutex and managed by Tauri.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::session::Control;

/// Coarse session lifecycle shown in the UI (visible session indicator).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// No pairing in progress.
    Idle,
    /// QR shown, waiting for a phone to scan + redeem.
    Pairing,
    /// Phone redeemed; desktop must Approve/Deny.
    AwaitingApproval,
    /// Approved — a control session is live.
    Active,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A pending pair-request's details, so the approve/deny UI can show WHO is
/// asking and for WHAT instead of a fixed sentence — plumbed all the way from
/// `SessionEvent::PairRequested`, which previously reached `apply_session_event`
/// and was discarded via a `{ .. }` wildcard match (see
/// `docs/audit/m3/desktop-ux.md` Finding 2).
#[derive(Debug, Clone, Serialize)]
pub struct PendingRequest {
    pub device_name: Option<String>,
    pub requested_scopes: Vec<String>,
    /// Epoch milliseconds this request arrived — lets the UI show "requesting
    /// since Xs ago" so a stale request (e.g. the window was backgrounded) is
    /// visually distinguishable from a fresh one.
    pub requested_at: u64,
}

impl PendingRequest {
    pub fn new(device_name: Option<String>, requested_scopes: Vec<String>) -> Self {
        Self {
            device_name,
            requested_scopes,
            requested_at: now_ms(),
        }
    }
}

pub struct AppState {
    pub device_id: String,
    pub backend_base_url: String,
    pub session: SessionStatus,
    /// The most recent room id from a pairing.
    pub current_room_id: Option<String>,
    /// Scopes the desktop offers when approving (default view+control).
    pub offered_scopes: Vec<String>,
    /// Control channel into the active session runner (Approve/Deny/Disconnect).
    pub control_tx: Option<UnboundedSender<Control>>,
    /// Set while `session == AwaitingApproval`; cleared once approved, denied,
    /// or the session ends. See `PendingRequest`'s doc comment.
    pub pending_request: Option<PendingRequest>,
    /// M5.4 no-QR reconnect: set by the presence channel when a trusted
    /// pair's "Always allow" rang this room — `apply_session_event` skips the
    /// ring and auto-approves the instant the pair-request arrives. Cleared
    /// when the session ends.
    pub auto_approve_room: Option<String>,
}

impl AppState {
    pub fn new(device_id: String, backend_base_url: String) -> Self {
        Self {
            device_id,
            backend_base_url,
            session: SessionStatus::Idle,
            current_room_id: None,
            offered_scopes: vec!["view".to_owned(), "control".to_owned()],
            control_tx: None,
            pending_request: None,
            auto_approve_room: None,
        }
    }
}

pub type SharedState = Mutex<AppState>;

/// Serializable snapshot returned to the UI via the `get_state` command.
#[derive(Debug, Serialize)]
pub struct AppStateDto {
    pub device_id: String,
    pub backend_base_url: String,
    pub session: SessionStatus,
    pub current_room_id: Option<String>,
    pub pending_request: Option<PendingRequest>,
    /// plugin name → health label, for the Diagnostics window (moved out of
    /// the normal approve/session UI — see `docs/audit/m3/desktop-ux.md`
    /// Finding 2).
    pub plugin_health: std::collections::BTreeMap<String, String>,
}
