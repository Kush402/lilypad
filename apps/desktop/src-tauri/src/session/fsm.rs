//! Explicit desktop session state — the same "declared legal transitions,
//! not boolean soup" pattern the backend already uses for its own session
//! lifecycle (`apps/backend/src/session/stateMachine.ts`). Before this
//! module, the desktop's session state was implicit in the *combination* of
//! several independent mutable locals in `run_session` (`peer`, `pipeline`,
//! `peer_connected`, `input_channel_open`, `ice_restarts`,
//! `recovery_deadline`, `paired`, `reconnecting`) — this type gives that
//! state one name and one place to look.
//!
//! Like the backend's `SessionStateMachine`, transitions are advisory: an
//! illegal `transition()` call returns `false` and leaves the state
//! unchanged, but callers do not gate behavior on that result (the backend's
//! `hub.ts` established this exact pattern — `room.fsm.tryTransition(...)`
//! call sites ignore the boolean today). Keeping the FSM observational
//! rather than a new validation gate means this extraction changes nothing
//! about `run_session`'s observable behavior — it only gives that behavior a
//! name, which is the entire point of this decomposition pass.

/// The desktop's view of one session's lifecycle. Mirrors the backend's
/// idle → pairing → waiting_approval → connecting → negotiating → connected
/// lifecycle, with `Recovering` added for the desktop-only ICE-restart
/// window (the backend has no equivalent: media/ICE recovery is entirely a
/// peer-to-peer concern it never observes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Registered with signaling, waiting for a device to scan the QR.
    Registered,
    /// A device has requested pairing; waiting for the user to approve/deny.
    AwaitingApproval,
    /// Approved; SDP offer/answer exchange in flight.
    Negotiating,
    /// The WebRTC peer connection is up.
    Connected,
    /// The peer connection reported `failed`; attempting a bounded number of
    /// ICE restarts before giving up.
    Recovering,
    /// Terminal — the runner is tearing down.
    Ended,
}

const TRANSITIONS: &[(SessionState, &[SessionState])] = &[
    (
        SessionState::Registered,
        &[SessionState::AwaitingApproval, SessionState::Ended],
    ),
    (
        SessionState::AwaitingApproval,
        &[SessionState::Negotiating, SessionState::Ended],
    ),
    (
        SessionState::Negotiating,
        &[
            SessionState::Connected,
            SessionState::Recovering,
            SessionState::Ended,
        ],
    ),
    (
        SessionState::Connected,
        &[
            SessionState::Recovering,
            SessionState::Negotiating,
            SessionState::Ended,
        ],
    ),
    (
        SessionState::Recovering,
        &[SessionState::Connected, SessionState::Ended],
    ),
    (SessionState::Ended, &[]),
];

fn allowed(from: SessionState) -> &'static [SessionState] {
    TRANSITIONS
        .iter()
        .find(|(s, _)| *s == from)
        .map(|(_, allowed)| *allowed)
        .unwrap_or(&[])
}

/// Tracks one session's current state. See the module doc for why
/// `transition` is advisory (non-gating) rather than a hard validation gate.
#[derive(Debug, Clone, Copy)]
pub struct SessionFsm {
    state: SessionState,
}

impl SessionFsm {
    pub fn new() -> Self {
        Self {
            state: SessionState::Registered,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn is_ended(&self) -> bool {
        self.state == SessionState::Ended
    }

    pub fn can_transition(&self, to: SessionState) -> bool {
        allowed(self.state).contains(&to)
    }

    /// Attempt the transition; returns whether it was legal. The state is
    /// only updated on success — an illegal call is a no-op, not a panic
    /// (mirrors `SessionStateMachine.tryTransition` in the backend).
    pub fn transition(&mut self, to: SessionState) -> bool {
        if self.can_transition(to) {
            self.state = to;
            true
        } else {
            false
        }
    }
}

impl Default for SessionFsm {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use SessionState::*;

    #[test]
    fn starts_registered() {
        assert_eq!(SessionFsm::new().state(), Registered);
    }

    #[test]
    fn legal_happy_path_transitions_succeed_in_order() {
        let mut fsm = SessionFsm::new();
        assert!(fsm.transition(AwaitingApproval));
        assert!(fsm.transition(Negotiating));
        assert!(fsm.transition(Connected));
        assert!(fsm.transition(Ended));
        assert_eq!(fsm.state(), Ended);
    }

    #[test]
    fn connected_can_recover_and_return_to_connected() {
        let mut fsm = SessionFsm::new();
        fsm.transition(AwaitingApproval);
        fsm.transition(Negotiating);
        fsm.transition(Connected);
        assert!(fsm.transition(Recovering));
        assert!(fsm.transition(Connected));
        assert_eq!(fsm.state(), Connected);
    }

    #[test]
    fn connected_can_renegotiate_directly() {
        // Mirrors the backend's `connected -> negotiating` transition for a
        // resolution/track-change renegotiation with no failure involved.
        let mut fsm = SessionFsm::new();
        fsm.transition(AwaitingApproval);
        fsm.transition(Negotiating);
        fsm.transition(Connected);
        assert!(fsm.transition(Negotiating));
    }

    #[test]
    fn recovering_can_end_without_returning_to_connected() {
        let mut fsm = SessionFsm::new();
        fsm.transition(AwaitingApproval);
        fsm.transition(Negotiating);
        fsm.transition(Connected);
        fsm.transition(Recovering);
        assert!(fsm.transition(Ended));
    }

    #[test]
    fn any_live_state_can_end() {
        for start in [
            Registered,
            AwaitingApproval,
            Negotiating,
            Connected,
            Recovering,
        ] {
            let mut fsm = SessionFsm { state: start };
            assert!(fsm.transition(Ended), "{start:?} -> Ended should be legal");
        }
    }

    #[test]
    fn ended_is_terminal_and_accepts_no_further_transitions() {
        let mut fsm = SessionFsm { state: Ended };
        for to in [
            Registered,
            AwaitingApproval,
            Negotiating,
            Connected,
            Recovering,
            Ended,
        ] {
            assert!(!fsm.transition(to), "Ended -> {to:?} must be rejected");
        }
    }

    #[test]
    fn illegal_transition_is_a_no_op_not_a_panic() {
        let mut fsm = SessionFsm::new(); // Registered
        assert!(!fsm.transition(Connected)); // can't skip approval/negotiation
        assert_eq!(
            fsm.state(),
            Registered,
            "state must be unchanged after a rejected transition"
        );
    }

    #[test]
    fn is_ended_reflects_terminal_state_only() {
        let mut fsm = SessionFsm::new();
        assert!(!fsm.is_ended());
        fsm.transition(Ended);
        assert!(fsm.is_ended());
    }

    #[test]
    fn cannot_skip_negotiation_straight_from_awaiting_approval_to_connected() {
        let mut fsm = SessionFsm::new();
        fsm.transition(AwaitingApproval);
        assert!(!fsm.transition(Connected));
        assert_eq!(fsm.state(), AwaitingApproval);
    }

    #[test]
    fn cannot_recover_from_a_state_that_never_negotiated() {
        let mut fsm = SessionFsm::new();
        assert!(!fsm.transition(Recovering));
        assert_eq!(fsm.state(), Registered);
    }
}
