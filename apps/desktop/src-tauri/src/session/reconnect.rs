//! Signaling reconnect policy: exponential backoff + a bounded retry budget.
//! Extracted verbatim from `run_session`'s former `backoff_delay`/
//! `reconnect_signaling` free functions — same behavior, now a named,
//! independently-testable unit that `SignalingClient` composes instead of
//! inlining.

use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::signaling::{self, Envelope};

/// Equal jitter: keep half the delay, randomise the other half.
///
/// No `rand` dependency for this — the requirement is "clients do not land on
/// the same millisecond", not cryptographic randomness, and the low bits of
/// the system clock in nanoseconds are uncorrelated enough between machines
/// and between attempts to do that.
pub(crate) fn jitter(base: Duration) -> Duration {
    let half = base.as_millis() as u64 / 2;
    if half == 0 {
        return base;
    }
    let entropy = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(half + entropy % (half + 1))
}

/// Signaling reconnect attempts before declaring the session lost.
///
/// Mirrors `@lilypad/protocol`'s `MAX_SIGNALING_RECONNECTS`/
/// `RECONNECT_BACKOFF_MS` (`packages/protocol/src/constants.ts`) — Rust can't
/// import that TS constant directly, so this value and `backoff()` below are
/// kept in sync by hand. `apps/mobile/src/lib/signaling.ts`'s
/// `MobileSignaling` reconnect loop consumes the TS side of the same
/// schedule. See `docs/audit/m3/reconnect-lifecycle.md` Findings 1 and 6.
const DEFAULT_MAX_ATTEMPTS: u32 = 4;

/// Bounded-retry, exponential-backoff policy for re-establishing signaling
/// after a mid-session transport drop.
pub struct ReconnectPolicy {
    max_attempts: u32,
}

impl ReconnectPolicy {
    pub fn new() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
        }
    }

    /// Exponential backoff for reconnect attempt `attempt` (0-indexed):
    /// 500ms, 1s, 2s, 4s, 8s, capped at 8s for any further attempt.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let ms = 500u64.saturating_mul(1u64 << attempt.min(6));
        Duration::from_millis(ms.min(8_000))
    }

    /// The same schedule, de-synchronised — what the loop actually sleeps.
    ///
    /// Every client connected when the backend restarts starts its retry clock
    /// at the same instant, and `backoff` is deterministic, so they all knock
    /// at 500ms, then all at 1s, then all at 2s. Deploys make that a routine
    /// event rather than a rare one, and the herd landing together can hold a
    /// just-started server down. Mirrors `jitteredBackoffMs` in
    /// `packages/protocol/src/constants.ts`.
    ///
    /// Equal jitter (half fixed, half random) rather than full jitter: full
    /// jitter can round to ~0 and turn a backoff into an immediate retry,
    /// which is the behaviour being avoided. The jittered value is always
    /// <= the scheduled one, so the cross-tier budget documented in
    /// `constants.ts` (worst case under `BACKEND_REREGISTER_GRACE_MS`) is
    /// unaffected.
    pub fn jittered_backoff(&self, attempt: u32) -> Duration {
        jitter(self.backoff(attempt))
    }

    /// Re-establish signaling: reconnect with exponential backoff and
    /// re-register as the desktop seat, so the backend routes room traffic
    /// to the new socket. Gives up after `max_attempts`.
    pub async fn reconnect(
        &self,
        url: &str,
        room_id: &str,
        device_id: &str,
    ) -> Result<(signaling::SignalingHandle, UnboundedReceiver<Envelope>)> {
        for attempt in 0..self.max_attempts {
            tokio::time::sleep(self.jittered_backoff(attempt)).await;
            match signaling::connect(url, None).await {
                Ok((sig, inbound)) => {
                    sig.send(Envelope::register(room_id, device_id))?;
                    return Ok((sig, inbound));
                }
                Err(e) => {
                    log::warn!(
                        target: "lilypad::session",
                        "signaling reconnect {}/{} failed: {e}",
                        attempt + 1,
                        self.max_attempts,
                    );
                }
            }
        }
        anyhow::bail!("gave up after {} attempts", self.max_attempts)
    }
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_exponential_and_capped() {
        // The first four values (the only ones `reconnect()`'s loop actually
        // reaches at `DEFAULT_MAX_ATTEMPTS = 4`) must match
        // `RECONNECT_BACKOFF_MS` in `packages/protocol/src/constants.ts`
        // exactly — see this module's `DEFAULT_MAX_ATTEMPTS` doc comment for
        // why this can't be a shared import across the Rust/TS boundary.
        let policy = ReconnectPolicy::new();
        assert_eq!(policy.backoff(0), Duration::from_millis(500));
        assert_eq!(policy.backoff(1), Duration::from_millis(1000));
        assert_eq!(policy.backoff(2), Duration::from_millis(2000));
        assert_eq!(policy.backoff(3), Duration::from_millis(4000));
        // The formula's own cap, exercised beyond what the loop ever reaches.
        assert_eq!(policy.backoff(4), Duration::from_millis(8000));
        assert_eq!(policy.backoff(10), Duration::from_millis(8000));
        assert_eq!(policy.backoff(u32::MAX), Duration::from_millis(8000));
    }
}

#[cfg(test)]
mod jitter_tests {
    use super::*;

    /// Mirrors `packages/protocol/src/constants.ts`'s own assertion: the
    /// jittered delay is never longer than the scheduled one, so the
    /// cross-tier timing budget (client retry budget < backend reregister
    /// grace) is unaffected by adding jitter.
    #[test]
    fn jitter_never_exceeds_the_scheduled_delay() {
        let policy = ReconnectPolicy::new();
        for attempt in 0..8 {
            let scheduled = policy.backoff(attempt);
            for _ in 0..200 {
                let jittered = policy.jittered_backoff(attempt);
                assert!(
                    jittered <= scheduled,
                    "attempt {attempt}: {jittered:?} > {scheduled:?}"
                );
                assert!(
                    jittered >= scheduled / 2,
                    "attempt {attempt}: {jittered:?} collapsed below half of {scheduled:?}"
                );
            }
        }
    }

    /// The point of the change: two clients backing off from the same restart
    /// must not choose the same millisecond.
    #[test]
    fn jitter_spreads_a_herd() {
        let policy = ReconnectPolicy::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            seen.insert(policy.jittered_backoff(3).as_millis());
            // The entropy source is the nanosecond clock, so consecutive calls
            // in a tight loop need a moment to differ.
            std::thread::sleep(Duration::from_micros(50));
        }
        assert!(seen.len() > 20, "only {} distinct delays", seen.len());
    }
}
