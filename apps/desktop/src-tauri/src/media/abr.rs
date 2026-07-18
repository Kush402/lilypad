//! Adaptive bitrate controller — pure decision logic, no I/O.
//!
//! Standard loss-based AIMD (the same shape libwebrtc's fallback controller
//! uses), optionally capped by the receiver's REMB estimate:
//!   - loss > 10%  → multiplicative decrease (×0.7)
//!   - 2% < loss ≤ 10% → hold (the link is at capacity; don't oscillate)
//!   - loss ≤ 2%  → gentle multiplicative increase (×1.05), rate-limited so a
//!     burst of clean receiver reports doesn't ramp faster than the network
//!     can prove itself
//!   - REMB caps the target at 95% of the receiver's estimate at all times
//!
//! Time is passed in (`Instant`) rather than read, so every branch is
//! deterministic under test.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct AbrConfig {
    pub min_kbps: u32,
    pub max_kbps: u32,
    /// Loss fraction above which we back off multiplicatively.
    pub decrease_loss: f64,
    /// Loss fraction below which the link counts as clean (probe upward).
    pub increase_loss: f64,
    pub decrease_factor: f64,
    pub increase_factor: f64,
    /// Minimum spacing between upward probes.
    pub increase_interval: Duration,
    /// Fraction of the REMB estimate to actually use (headroom for audio/RTCP
    /// overhead and estimate error).
    pub remb_headroom: f64,
    /// How far above the REMB cap a clean-link probe may reach. REMB reports
    /// what the receiver currently OBSERVES — roughly the send rate — so a
    /// hard cap is a deadlock: sending 1000 kbps yields REMB ≈ 1000 which
    /// forbids ever sending more (observed live: an entire cellular session
    /// pinned at the 1000 floor with 0% loss). A bounded overshoot turns the
    /// cap into a ladder: probe 25% past the estimate, the receiver observes
    /// the higher rate, REMB rises, the next probe climbs further; loss (or a
    /// REMB that stops growing) still ends the climb at true capacity.
    pub probe_margin: f64,
}

impl Default for AbrConfig {
    fn default() -> Self {
        Self {
            // 300 kbps at desktop resolutions is unreadable smear — and the
            // receiver's FIRST bandwidth estimate (REMB) is a conservative
            // ~300k before any traffic has flowed, which used to slam the
            // encoder to the floor at session start and hold it there
            // (the estimator only ramps from traffic it actually observes,
            // so a floored sender starves its own recovery). 1 Mbps keeps
            // text legible as the worst case on any link worth using.
            min_kbps: 1000,
            // Generous ceiling: a LAN (or good WAN) path can carry far more
            // than 6 Mbps, and H.264 desktop content at 1920-wide genuinely
            // uses it during motion (video playback, scrolling). The AIMD
            // loop still only reaches this when loss stays clean.
            max_kbps: 10_000,
            decrease_loss: 0.10,
            increase_loss: 0.02,
            decrease_factor: 0.7,
            // Match libwebrtc's ~8%/s ramp — 5% per 2s took minutes to climb
            // out of a low REMB cap, which reads as "quality is dying".
            increase_factor: 1.08,
            increase_interval: Duration::from_secs(1),
            remb_headroom: 0.95,
            probe_margin: 1.25,
        }
    }
}

pub struct BitrateController {
    cfg: AbrConfig,
    current_kbps: u32,
    remb_cap_kbps: Option<u32>,
    last_increase: Option<Instant>,
}

impl BitrateController {
    pub fn new(initial_kbps: u32, cfg: AbrConfig) -> Self {
        Self {
            cfg,
            current_kbps: initial_kbps.clamp(cfg.min_kbps, cfg.max_kbps),
            remb_cap_kbps: None,
            last_increase: None,
        }
    }

    pub fn current_kbps(&self) -> u32 {
        self.current_kbps
    }

    fn ceiling(&self) -> u32 {
        self.remb_cap_kbps.map_or(self.cfg.max_kbps, |cap| {
            (((cap as f64) * self.cfg.probe_margin) as u32).min(self.cfg.max_kbps)
        })
    }

    /// Apply a new target, returning Some(kbps) only when it actually changed.
    fn retarget(&mut self, kbps: u32) -> Option<u32> {
        let clamped = kbps.clamp(self.cfg.min_kbps, self.ceiling());
        if clamped != self.current_kbps {
            self.current_kbps = clamped;
            Some(clamped)
        } else {
            None
        }
    }

    /// RTCP receiver report arrived: `fraction_lost` in [0, 1].
    /// Returns the new target when it changed.
    pub fn on_loss_report(&mut self, fraction_lost: f64, now: Instant) -> Option<u32> {
        if fraction_lost > self.cfg.decrease_loss {
            self.last_increase = Some(now); // back off the probe timer too
            let next = (self.current_kbps as f64 * self.cfg.decrease_factor) as u32;
            return self.retarget(next);
        }
        if fraction_lost > self.cfg.increase_loss {
            return None; // at capacity — hold
        }
        // Clean link: probe upward, rate-limited.
        let due = match self.last_increase {
            Some(t) => now.duration_since(t) >= self.cfg.increase_interval,
            None => true,
        };
        if !due {
            return None;
        }
        self.last_increase = Some(now);
        let next = ((self.current_kbps as f64 * self.cfg.increase_factor) as u32)
            .max(self.current_kbps + 1);
        self.retarget(next)
    }

    /// Receiver Estimated Maximum Bitrate arrived. Caps all future targets and
    /// pulls the current target down immediately if it exceeds the estimate.
    pub fn on_remb(&mut self, bitrate_bps: u64) -> Option<u32> {
        let cap = ((bitrate_bps as f64 * self.cfg.remb_headroom) / 1000.0) as u32;
        self.remb_cap_kbps = Some(cap.max(self.cfg.min_kbps));
        if self.current_kbps > self.ceiling() {
            let target = self.ceiling();
            return self.retarget(target);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctl() -> BitrateController {
        BitrateController::new(2500, AbrConfig::default())
    }

    #[test]
    fn heavy_loss_backs_off_multiplicatively() {
        let mut c = ctl();
        let t = Instant::now();
        assert_eq!(c.on_loss_report(0.25, t), Some(1750)); // 2500 * 0.7
        assert_eq!(c.on_loss_report(0.25, t), Some(1225));
    }

    #[test]
    fn moderate_loss_holds() {
        let mut c = ctl();
        assert_eq!(c.on_loss_report(0.05, Instant::now()), None);
        assert_eq!(c.current_kbps(), 2500);
    }

    #[test]
    fn clean_link_probes_upward_but_rate_limited() {
        let mut c = ctl();
        let t0 = Instant::now();
        assert_eq!(c.on_loss_report(0.0, t0), Some(2700)); // 2500 * 1.08
                                                           // Immediately again: too soon.
        assert_eq!(c.on_loss_report(0.0, t0 + Duration::from_millis(100)), None);
        // After the interval: another step.
        assert_eq!(
            c.on_loss_report(0.0, t0 + Duration::from_secs(3)),
            Some(2916)
        );
    }

    #[test]
    fn never_leaves_configured_bounds() {
        let mut c = ctl();
        let mut t = Instant::now();
        for _ in 0..50 {
            c.on_loss_report(0.5, t);
            t += Duration::from_secs(1);
        }
        assert_eq!(c.current_kbps(), 1000, "floor holds under sustained loss");
        for _ in 0..200 {
            t += Duration::from_secs(3);
            c.on_loss_report(0.0, t);
        }
        assert_eq!(c.current_kbps(), 10_000, "ceiling holds on a clean link");
    }

    #[test]
    fn remb_cap_is_a_ladder_not_a_deadlock() {
        let mut c = ctl();
        // Receiver estimates 1 Mbps → cap 1000 (floor-clamped). The probe
        // ceiling is cap × 1.25 = 1250, so the current 2500 pulls down to
        // the ceiling — not all the way to the estimate.
        assert_eq!(c.on_remb(1_000_000), Some(1250));
        // Clean-link probing stalls at the ceiling…
        let mut t = Instant::now();
        for _ in 0..20 {
            t += Duration::from_secs(3);
            c.on_loss_report(0.0, t);
        }
        assert_eq!(c.current_kbps(), 1250);
        // …until the receiver observes the higher send rate and its estimate
        // rises — each rise unlocks the next rung (this is the ladder that
        // was previously a deadlock: REMB ≈ send rate could never grow).
        assert_eq!(c.on_remb(1_250_000), None); // current below new ceiling
        t += Duration::from_secs(3);
        assert_eq!(c.on_loss_report(0.0, t), Some(1350)); // 1250 * 1.08
    }

    #[test]
    fn heavy_loss_resets_probe_timer() {
        let mut c = ctl();
        let t0 = Instant::now();
        c.on_loss_report(0.25, t0); // back off → probe timer reset
                                    // Clean report right after the loss must NOT probe upward yet.
        assert_eq!(c.on_loss_report(0.0, t0 + Duration::from_millis(500)), None);
    }
}
