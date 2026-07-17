/**
 * Protocol-wide constants shared by every Lilypad surface.
 * Bump PROTOCOL_VERSION on any breaking change to a wire format below.
 *
 * v2 (M3 Phase 5): input events carry a monotonic `seq` alongside `ts`
 * (`docs/audit/m3/input-touch.md` Finding 8); pointer events carry
 * `modifiers` (Finding 5); a `frame-size` signaling message carries the
 * desktop's capture resolution so the phone can map touches onto the
 * letterboxed video content rect rather than the raw view (Finding 1).
 */
export const PROTOCOL_VERSION = 2 as const;

/** QR payload schema version (independent so the scanner can reject old apps).
 * Bumped to 2 to carry `deviceName`/`platform` for the pairing-confirmation
 * identity card — see `docs/audit/m3/mobile-ux.md` Finding 9. */
export const QR_PAYLOAD_VERSION = 2 as const;

/** WebSocket signaling endpoint path on the backend. */
export const SIGNALING_PATH = '/ws/signal' as const;

/** DataChannel label used for the input protocol (phone → desktop). Carries
 * every discrete, must-not-lose, must-not-reorder event: pointer down/up,
 * clicks, keys, text, shortcuts, clipboard. Ordered + reliable (the
 * transport default) — losing a key-up is a stuck key on the desktop. */
export const INPUT_CHANNEL_LABEL = 'lilypad-input' as const;

/** DataChannel label for disposable, loss-tolerant input: `pointer_move` and
 * `scroll` only. `ordered: true` (cheap, avoids new reorder logic) but
 * `maxRetransmits: 0` — a lost or superseded batch is simply gone, no
 * retransmit, no head-of-line-blocking a click or key sitting behind it on
 * the critical channel. If this channel never opens (older peer, transient
 * negotiation failure), the sender falls back to the critical channel —
 * pointer moves still work, just without the loss-tolerance benefit. See
 * `docs/audit/m3/input-touch.md` Finding 2. */
export const INPUT_MOVE_CHANNEL_LABEL = 'lilypad-input-move' as const;

/**
 * Pointer-move coalescing budget on the mobile sender. Moves are batched and
 * flushed at most this often; downs/ups/keys/shortcuts bypass coalescing.
 */
export const POINTER_COALESCE_MS = 8 as const; // ~120Hz ceiling

/**
 * Touch precision-assist tuning (`docs/audit/m3/input-touch.md` Finding 7).
 * On first contact the interpreter waits `TOUCH_SETTLE_MS`, tracking the
 * finger; if it stays within `TOUCH_SETTLE_RADIUS_PX` (container points) it
 * commits a click-in-place at the *settled* centroid rather than the jittery
 * first-contact pixel; if it moves beyond that, it's a drag and the press
 * commits immediately at first contact. Consumed only by the mobile touch
 * interpreter; kept here beside `POINTER_COALESCE_MS` so every input-timing
 * knob lives in one place.
 */
export const TOUCH_SETTLE_MS = 70 as const;
export const TOUCH_SETTLE_RADIUS_PX = 6 as const;

/**
 * Sustained single-finger press (with negligible movement) longer than this
 * is interpreted as a right-click (context menu), the standard mobile-RDP
 * convention (`docs/audit/m3/input-touch.md` Finding 5).
 */
export const LONG_PRESS_MS = 500 as const;

/**
 * Signaling reconnect backoff schedule (ms per attempt, 0-indexed), shared
 * across every client tier so mobile and desktop stay in lockstep with each
 * other and with the backend's `reregisterGraceMs`
 * (`apps/backend/src/signaling/lifecyclePolicy.ts`) — see
 * `docs/audit/m3/reconnect-lifecycle.md` Findings 1 and 6. The desktop's
 * `apps/desktop/src-tauri/src/session/reconnect.rs` (`ReconnectPolicy`)
 * mirrors this exact schedule in Rust, since Rust can't import a TS
 * constant directly; its own test asserts the same values with a comment
 * pointing back here. Keep both in sync by hand if this ever changes.
 */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000] as const;

/** Signaling reconnect attempts before declaring the transport lost. Worst-
 * case sleep (500+1000+2000+4000 = 7.5s) stays safely under
 * `BACKEND_REREGISTER_GRACE_MS` even accounting for per-attempt connect
 * time — see the cross-tier timing budget below. */
export const MAX_SIGNALING_RECONNECTS = RECONNECT_BACKOFF_MS.length;

/**
 * Backoff for reconnect attempt `attempt` (0-indexed) — capped at the last
 * (largest) schedule entry for any attempt beyond the table's length.
 */
export function reconnectBackoffMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 0), RECONNECT_BACKOFF_MS.length - 1);
  // `idx` is clamped into range above, but a computed (non-literal) index
  // into a tuple type is `T | undefined` under `noUncheckedIndexedAccess` —
  // the assertion reflects that proven invariant, not an unchecked guess.
  return RECONNECT_BACKOFF_MS[idx]!;
}

/**
 * Cross-tier timing budget (`docs/audit/m3/reconnect-lifecycle.md` Finding 6)
 * — these four constants were previously tuned independently per tier and
 * raced each other (the desktop's reconnect budget could exceed the
 * backend's reregister grace, so a desktop mid-reconnect could get reaped
 * out from under itself). Kept together, in order, so the invariant is
 * visible at a glance:
 *
 *   app heartbeat interval  <<  backend heartbeat timeout  <  backend reregister grace
 *          (8s)                        (25s)                        (15s* — see below)
 *
 * `*` the reregister grace guards a DIFFERENT failure (a vacated seat
 * waiting for the SAME device to reclaim it, `LifecyclePolicy`) than the
 * reconnect backoff above guards (the client's own retry budget) — the
 * invariant that actually matters is `MAX_SIGNALING_RECONNECTS`' worst-case
 * sleep staying under `BACKEND_REREGISTER_GRACE_MS`, which it does (7.5s vs
 * 15s) with real margin for per-attempt connect time on top.
 */

/** How often a live client (desktop or mobile) sends a heartbeat frame.
 * Mirrored by hand in the desktop's Rust session runner
 * (`apps/desktop/src-tauri/src/session/mod.rs`) since Rust can't import
 * this constant directly. */
export const APP_HEARTBEAT_INTERVAL_MS = 8_000 as const;

/** Backend: a peer is reaped if silent this long — three missed heartbeats'
 * worth of jitter tolerance, not one. */
export const BACKEND_HEARTBEAT_TIMEOUT_MS = 25_000 as const;

/** Backend: how long a vacated seat is held for the same device to
 * re-register before the room is torn down. */
export const BACKEND_REREGISTER_GRACE_MS = 15_000 as const;

/** Backend: how often the periodic reap sweep (grace-expiry + heartbeat-
 * stale) runs. Halved from an earlier 10s so a truly-abandoned room's
 * worst-case lingering time is tighter. */
export const BACKEND_REAP_INTERVAL_MS = 5_000 as const;

/**
 * Bounded ICE-restart budget per unhealthy period (reset once the peer
 * reports `connected` again). Mirrored by hand in the desktop's Rust
 * `MAX_ICE_RESTARTS` (`apps/desktop/src-tauri/src/session/mod.rs`) — the
 * authoritative counter, since the desktop is the offerer that actually
 * performs the restart. The mobile client's own counter
 * (`apps/mobile/src/lib/webrtc.ts`) is an independent, client-side safety
 * valve bounding how often IT asks for a restart — intentionally the same
 * shape as this value, not the same enforcement mechanism.
 */
export const MAX_ICE_RESTARTS = 2 as const;

/**
 * Recovery deadline per restart attempt (1-indexed — the Nth attempt's own
 * budget), scaled up for later attempts since a second restart often has to
 * fall back to a slower relayed-only candidate pair after a faster direct
 * path already failed. Capped at the last entry for any attempt beyond the
 * table's length. Mirrored by hand in the desktop's Rust
 * `recovery_timeout_for_attempt` (`session/mod.rs`).
 */
export const ICE_RECOVERY_TIMEOUT_MS = [12_000, 20_000] as const;

export function iceRecoveryTimeoutMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt - 1, 0), ICE_RECOVERY_TIMEOUT_MS.length - 1);
  return ICE_RECOVERY_TIMEOUT_MS[idx]!;
}
