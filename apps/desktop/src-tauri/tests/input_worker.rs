//! Integration test: the real `InputWorker` (dedicated thread + channel),
//! fed the exact JSON wire format `@lilypad/protocol` produces, correctly
//! decodes, gates, and accounts for every event — independent of whether this
//! machine has granted the OS permission real injection needs.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use lilypad_desktop_lib::input::{InputMetricsSnapshot, InputWorker, Scope};

/// How long a `wait_for` may take before the test calls it a failure.
///
/// Generous on purpose. `wait_for` returns the instant its condition holds, so
/// a large budget costs a passing run nothing — the whole file finishes in
/// about 1.3 seconds on an idle machine. What it buys is not being a
/// wall-clock assertion about the host's spare capacity: these ran green alone
/// and failed three-of-eight inside `pnpm verify`, which builds two Rust
/// targets and seven JavaScript test suites at the same time. A suite that
/// only passes on an unloaded laptop makes `main` randomly red, and a randomly
/// red `main` teaches everyone to re-run instead of read.
const SETTLE: Duration = Duration::from_secs(20);

fn wait_for<F: Fn() -> bool>(cond: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Events that have reached a TERMINAL decision. `events_received` increments
/// at parse time, before the gate/scope/injection decision — waiting on it
/// races the worker thread's decision counters (the exact flake these tests
/// exhibited on a machine where real injection is slow enough to lose).
fn decided(snap: &InputMetricsSnapshot) -> u64 {
    snap.events_injected
        + snap.events_dropped_gated
        + snap.events_dropped_stale
        + snap.events_dropped_permission
        + snap.events_dropped_invalid
        + snap.events_dropped_scope
}

#[test]
fn rejects_input_before_the_gate_opens() {
    let worker = InputWorker::spawn();
    let frame =
        br#"{"kind":"input_batch","events":[{"kind":"pointer_move","x":0.5,"y":0.5,"ts":1}]}"#;
    worker.handle_message(frame.to_vec());

    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 1,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(
        snap.events_dropped_gated, 1,
        "input sent before set_enabled(true) must be gated"
    );
    assert_eq!(snap.events_injected, 0);
}

#[test]
fn processes_the_exact_wire_format_the_mobile_app_sends() {
    let worker = InputWorker::spawn();
    worker.set_enabled(true);
    // A control grant is a precondition for injection just like `set_enabled`
    // — see the scope-enforcement tests below for the case where it's absent.
    worker.set_scopes(HashSet::from([Scope::Control]));

    // Mirrors packages/protocol/src/input.ts encodeInputBatch() output exactly.
    let frame = br#"{"kind":"input_batch","events":[
        {"kind":"pointer_move","x":0.5,"y":0.4,"ts":1},
        {"kind":"pointer_down","x":0.5,"y":0.4,"button":"left","ts":2},
        {"kind":"click","x":0.5,"y":0.4,"button":"left","count":1,"ts":3},
        {"kind":"key_down","code":"KeyA","modifiers":["meta"],"repeat":false,"ts":4},
        {"kind":"key_up","code":"KeyA","modifiers":[],"ts":5},
        {"kind":"shortcut","action":"copy","ts":6}
    ]}"#;
    worker.handle_message(frame.to_vec());

    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 6,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(snap.events_received, 6);
    // Whether injection succeeds depends on this machine's Accessibility grant
    // (macOS) — either way every event must be accounted for, never silently
    // vanish: injected + dropped_permission + dropped_invalid == received.
    let accounted =
        snap.events_injected + snap.events_dropped_permission + snap.events_dropped_invalid;
    assert_eq!(
        accounted, snap.events_received,
        "every event must be accounted for"
    );
    assert_eq!(snap.events_dropped_gated, 0);
    assert_eq!(snap.events_dropped_stale, 0);
    assert_eq!(snap.events_dropped_scope, 0);
}

#[test]
fn malformed_frame_is_rejected_without_crashing_the_worker() {
    let worker = InputWorker::spawn();
    worker.set_enabled(true);
    worker.handle_message(b"{ not valid json".to_vec());
    assert!(wait_for(
        || worker.metrics().snapshot().events_dropped_invalid >= 1,
        SETTLE
    ));

    // The worker thread must still be alive and processing after a bad frame.
    let frame =
        br#"{"kind":"input_batch","events":[{"kind":"pointer_move","x":0.1,"y":0.1,"ts":1}]}"#;
    worker.handle_message(frame.to_vec());
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 1,
        SETTLE
    ));
}

#[test]
fn reconnect_cycle_re_gates_correctly() {
    let worker = InputWorker::spawn();
    let frame = |ts: u64| -> Vec<u8> {
        format!(r#"{{"kind":"input_batch","events":[{{"kind":"pointer_move","x":0.1,"y":0.1,"ts":{ts}}}]}}"#)
            .into_bytes()
    };

    worker.set_enabled(true);
    worker.handle_message(frame(1));
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 1,
        SETTLE
    ));

    // Simulate a disconnect.
    worker.set_enabled(false);
    worker.handle_message(frame(2));
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 2,
        SETTLE
    ));
    assert_eq!(worker.metrics().snapshot().events_dropped_gated, 1);

    // Reconnect — the gate must open again cleanly.
    worker.set_enabled(true);
    worker.handle_message(frame(3));
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 3,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(
        snap.events_dropped_gated, 1,
        "only the mid-disconnect event should have been gated"
    );
}

// ── view/control scope enforcement ──────────────────────────────────────────
//
// `docs/audit/m3/backend-security.md` Finding 2: a session granted only
// `view` must have every control-plane input event rejected at the real
// injection boundary, not merely have its own mobile UI decline to send
// them. These exercise the real `InputWorker` (background thread + real
// `InputDispatcher`), same as the tests above, just with `set_scopes` now in
// the mix alongside `set_enabled`.

#[test]
fn view_only_session_input_is_dropped_at_the_injection_boundary() {
    let worker = InputWorker::spawn();
    worker.set_enabled(true);
    worker.set_scopes(HashSet::from([Scope::View])); // explicit view-only grant

    // A representative mix of control-plane kinds, including clipboard
    // (docs/audit/m3/backend-security.md Finding 9 calls this out
    // specifically as unusually sensitive).
    let frame = br#"{"kind":"input_batch","events":[
        {"kind":"pointer_down","x":0.5,"y":0.4,"button":"left","ts":1},
        {"kind":"click","x":0.5,"y":0.4,"button":"left","count":1,"ts":2},
        {"kind":"key_down","code":"KeyA","modifiers":["meta"],"repeat":false,"ts":3},
        {"kind":"shortcut","action":"copy","ts":4},
        {"kind":"clipboard","text":"secret","ts":5}
    ]}"#;
    worker.handle_message(frame.to_vec());

    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 5,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(
        snap.events_dropped_scope, 5,
        "a view-only session must drop every control-plane event kind, including clipboard"
    );
    assert_eq!(
        snap.events_injected, 0,
        "no input may reach the OS without a control grant"
    );
    assert_eq!(
        snap.events_dropped_gated, 0,
        "these were rejected for scope, not for the connected/channel-open gate"
    );
}

#[test]
fn no_grant_at_all_is_treated_the_same_as_view_only() {
    // A worker that is `enabled` but has never received `set_scopes` at all
    // (e.g. a defensive scenario where session-start parsing is skipped)
    // must fail closed exactly like an explicit view-only grant.
    let worker = InputWorker::spawn();
    worker.set_enabled(true);

    let frame = br#"{"kind":"input_batch","events":[
        {"kind":"click","x":0.5,"y":0.4,"button":"left","count":1,"ts":1}
    ]}"#;
    worker.handle_message(frame.to_vec());

    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 1,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(snap.events_dropped_scope, 1);
    assert_eq!(snap.events_injected, 0);
}

#[test]
fn control_scope_allows_input_through_same_as_before_the_fix() {
    let worker = InputWorker::spawn();
    worker.set_enabled(true);
    worker.set_scopes(HashSet::from([Scope::Control]));

    let frame = br#"{"kind":"input_batch","events":[
        {"kind":"pointer_down","x":0.5,"y":0.4,"button":"left","ts":1},
        {"kind":"click","x":0.5,"y":0.4,"button":"left","count":1,"ts":2},
        {"kind":"key_down","code":"KeyA","modifiers":["meta"],"repeat":false,"ts":3},
        {"kind":"shortcut","action":"copy","ts":4},
        {"kind":"clipboard","text":"ok to sync","ts":5}
    ]}"#;
    worker.handle_message(frame.to_vec());

    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 5,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(snap.events_dropped_scope, 0);
    // Same "never silently vanish" accounting as
    // `processes_the_exact_wire_format_the_mobile_app_sends`: whether actual
    // OS injection succeeds depends on this machine's Accessibility grant,
    // but every event must reach that decision, not get stopped for scope.
    let accounted =
        snap.events_injected + snap.events_dropped_permission + snap.events_dropped_invalid;
    assert_eq!(accounted, snap.events_received);
}

#[test]
fn scope_change_mid_session_takes_effect_on_the_very_next_batch() {
    let worker = InputWorker::spawn();
    worker.set_enabled(true);
    worker.set_scopes(HashSet::from([Scope::View]));

    let frame = |ts: u64| -> Vec<u8> {
        format!(
            r#"{{"kind":"input_batch","events":[{{"kind":"click","x":0.1,"y":0.1,"button":"left","count":1,"ts":{ts}}}]}}"#
        )
        .into_bytes()
    };

    worker.handle_message(frame(1));
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 1,
        SETTLE
    ));
    assert_eq!(worker.metrics().snapshot().events_dropped_scope, 1);

    // A corrected/re-sent session-start grants control mid-session.
    worker.set_scopes(HashSet::from([Scope::Control]));
    worker.handle_message(frame(2));
    assert!(wait_for(
        || decided(&worker.metrics().snapshot()) >= 2,
        SETTLE
    ));
    let snap = worker.metrics().snapshot();
    assert_eq!(
        snap.events_dropped_scope, 1,
        "only the pre-grant event should have been scope-dropped"
    );
    let accounted =
        snap.events_injected + snap.events_dropped_permission + snap.events_dropped_invalid;
    assert_eq!(
        accounted, 1,
        "the post-grant event must have reached the injection decision"
    );
}
