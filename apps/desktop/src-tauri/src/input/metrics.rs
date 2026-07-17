//! Input pipeline metrics — lock-free counters + a serializable snapshot,
//! logged periodically and available for a future debug overlay (mirrors
//! `media::metrics`).

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

#[derive(Default)]
pub struct InputMetrics {
    pub events_received: AtomicU64,
    pub events_injected: AtomicU64,
    pub events_dropped_gated: AtomicU64,
    pub events_dropped_stale: AtomicU64,
    pub events_dropped_permission: AtomicU64,
    pub events_dropped_invalid: AtomicU64,
    /// Events dropped because the session's granted scope didn't include
    /// `control` — see `input::dispatcher::Scope` and
    /// `docs/audit/m3/backend-security.md` Finding 2.
    pub events_dropped_scope: AtomicU64,
    pub inject_us_total: AtomicU64,
    /// Depth of the channel feeding the injection thread, sampled on send.
    pub queue_depth: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputMetricsSnapshot {
    pub events_received: u64,
    pub events_injected: u64,
    pub events_dropped_gated: u64,
    pub events_dropped_stale: u64,
    pub events_dropped_permission: u64,
    pub events_dropped_invalid: u64,
    pub events_dropped_scope: u64,
    pub avg_inject_us: f64,
    pub queue_depth: u64,
}

impl InputMetrics {
    pub fn snapshot(&self) -> InputMetricsSnapshot {
        let injected = self.events_injected.load(Ordering::Relaxed);
        let total_us = self.inject_us_total.load(Ordering::Relaxed);
        InputMetricsSnapshot {
            events_received: self.events_received.load(Ordering::Relaxed),
            events_injected: injected,
            events_dropped_gated: self.events_dropped_gated.load(Ordering::Relaxed),
            events_dropped_stale: self.events_dropped_stale.load(Ordering::Relaxed),
            events_dropped_permission: self.events_dropped_permission.load(Ordering::Relaxed),
            events_dropped_invalid: self.events_dropped_invalid.load(Ordering::Relaxed),
            events_dropped_scope: self.events_dropped_scope.load(Ordering::Relaxed),
            avg_inject_us: if injected > 0 {
                total_us as f64 / injected as f64
            } else {
                0.0
            },
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
        }
    }
}
