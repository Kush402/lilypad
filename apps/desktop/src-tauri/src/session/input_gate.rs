//! Input-injection gate: enables the `InputWorker` only when
//! `peer_connected && channel_open` both hold. Previously these were two
//! independent `bool` locals in `run_session`, recomputed at four different
//! call sites scattered across two `select!` arms — easy to update in
//! lock-step by hand, easy to forget when a future contributor adds a new
//! state that should also gate injection. One owner, one `recompute`.
//!
//! `InputGate` is also the boundary through which the session's granted
//! scope (from `session-start`'s `grantedScopes`) enters the input
//! subsystem — see [`InputGate::set_granted_scopes`]. That grant is a
//! second, independent gate enforced deeper down in `InputDispatcher`
//! (per-event, alongside `enabled`), not folded into `connected`/
//! `channel_open` here: whether a peer is live and whether it was ever
//! granted `control` are orthogonal facts, and conflating them was exactly
//! the bug in `docs/audit/m3/backend-security.md` Finding 2 (a view-only
//! session's input was never rejected anywhere in the data path because
//! nothing after `session-start` ever consulted `grantedScopes` at all).

use std::collections::HashSet;

use crate::input::{InputWorker, Scope};

pub struct InputGate {
    worker: InputWorker,
    connected: bool,
    channel_open: bool,
}

impl InputGate {
    pub fn new() -> Self {
        Self {
            worker: InputWorker::spawn(),
            connected: false,
            channel_open: false,
        }
    }

    pub fn set_peer_connected(&mut self, v: bool) {
        self.connected = v;
        self.recompute();
    }

    pub fn set_channel_open(&mut self, v: bool) {
        self.channel_open = v;
        self.recompute();
    }

    fn recompute(&mut self) {
        self.worker.set_enabled(self.connected && self.channel_open);
    }

    pub fn handle_message(&self, bytes: Vec<u8>) {
        self.worker.handle_message(bytes);
    }

    /// Record the scopes granted for the current session (from
    /// `session-start`'s `grantedScopes`) and forward them to the
    /// `InputDispatcher`, which rejects any control-plane input (pointer,
    /// key, text, shortcut, clipboard) unless `control` is among them. This
    /// is the desktop-side enforcement point for
    /// `docs/audit/m3/backend-security.md` Finding 2 — the mobile UI's own
    /// scope-gated toolbar/PanResponder (`ViewerScreen.tsx`) is a UX nicety,
    /// never load-bearing: a modified or buggy client can send input
    /// regardless of what its own UI shows, so the desktop — the injection
    /// endpoint — must be the one place that actually refuses it.
    ///
    /// Independent of `connected`/`channel_open`: call this as soon as
    /// `session-start` is parsed, whether or not the DataChannel has opened
    /// yet, so the scope is already on file the moment it does.
    pub fn set_granted_scopes(&mut self, scopes: HashSet<Scope>) {
        self.worker.set_scopes(scopes);
    }

    /// Aim injection at the display the session is showing. Called when media
    /// starts and again on every display switch — a tap on the second monitor
    /// must not land on the first.
    pub fn set_target_display(&mut self, display_id: Option<u32>) {
        self.worker.set_target_display(display_id);
    }

    /// Force injection off, reset both gating flags, and clear any granted
    /// scope — used on session teardown (media failure, disconnect, ...).
    /// Never let input act on a screen the viewer can no longer see
    /// updating, and never let a stale scope grant leak into whatever
    /// session (if any) follows.
    pub fn disable(&mut self) {
        self.connected = false;
        self.channel_open = false;
        self.worker.set_enabled(false);
        self.worker.set_scopes(HashSet::new());
    }
}

impl Default for InputGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `InputWorker::spawn()` starts a real background thread + backend probe
    // (logs a permission warning in this sandboxed/headless test env, which
    // is expected and harmless) — these tests only assert on `InputGate`'s
    // own connected×open bookkeeping, not on injection actually happening
    // (that's `InputDispatcher`'s own unit-tested contract).

    #[test]
    fn starts_with_both_flags_false() {
        let gate = InputGate::new();
        assert!(!gate.connected);
        assert!(!gate.channel_open);
    }

    #[test]
    fn only_enabled_when_both_connected_and_channel_open() {
        let mut gate = InputGate::new();
        gate.set_peer_connected(true);
        assert!(gate.connected && !gate.channel_open);

        gate.set_channel_open(true);
        assert!(gate.connected && gate.channel_open);
    }

    #[test]
    fn losing_either_flag_turns_the_other_off_functionally() {
        let mut gate = InputGate::new();
        gate.set_peer_connected(true);
        gate.set_channel_open(true);

        gate.set_peer_connected(false);
        assert!(!gate.connected);
        assert!(gate.channel_open); // channel_open itself is untouched...

        gate.set_channel_open(false);
        assert!(!gate.channel_open);
    }

    #[test]
    fn disable_resets_both_flags() {
        let mut gate = InputGate::new();
        gate.set_peer_connected(true);
        gate.set_channel_open(true);

        gate.disable();
        assert!(!gate.connected);
        assert!(!gate.channel_open);
    }

    // ── scope wiring (Finding 2: view/control scope enforcement) ───────────
    //
    // `set_granted_scopes` forwards straight to the `InputWorker`/
    // `InputDispatcher`, which is where the actual per-event enforcement is
    // unit-tested (`input::dispatcher`'s own test module) and integration-
    // tested end to end (`tests/input_worker.rs`). What belongs here is
    // proving the gate's own bookkeeping is untouched by scope changes — a
    // regression where scope wiring accidentally started influencing
    // `connected`/`channel_open` (or vice versa) would silently reintroduce
    // exactly the "one giant recomputed condition" bug this module was
    // extracted to prevent.

    #[test]
    fn set_granted_scopes_does_not_disturb_connected_channel_open_bookkeeping() {
        let mut gate = InputGate::new();
        gate.set_peer_connected(true);
        gate.set_channel_open(true);

        gate.set_granted_scopes(HashSet::from([Scope::View]));
        assert!(gate.connected && gate.channel_open);

        gate.set_granted_scopes(HashSet::from([Scope::Control]));
        assert!(gate.connected && gate.channel_open);
    }

    #[test]
    fn set_granted_scopes_before_either_flag_is_set_does_not_enable_it() {
        // Granting scope must never itself flip the connected/channel-open
        // gate — scope and liveness are independent conditions.
        let mut gate = InputGate::new();
        gate.set_granted_scopes(HashSet::from([Scope::Control]));
        assert!(!gate.connected);
        assert!(!gate.channel_open);
    }

    #[test]
    fn disable_clears_granted_scopes_without_panicking() {
        // Can't observe the dispatcher's internal scope set from here (it
        // lives on the worker's background thread) — this guards the
        // wiring itself: disable() must be callable at any point in the
        // scope lifecycle (before a grant ever arrives, and after one did)
        // without panicking, and the real effect (an empty grant on the
        // next session) is what `InputDispatcher`'s own tests assert on
        // directly via a mock backend.
        let mut gate = InputGate::new();
        gate.disable();

        gate.set_granted_scopes(HashSet::from([Scope::Control]));
        gate.set_peer_connected(true);
        gate.set_channel_open(true);
        gate.disable();
        assert!(!gate.connected);
        assert!(!gate.channel_open);
    }
}
