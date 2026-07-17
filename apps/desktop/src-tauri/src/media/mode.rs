//! Capture/encode mode: trade frame rate for resolution/sharpness. The
//! documented "1080p text mode" (`docs/technical-design.md:29-30`) had zero
//! implementation before this — see `docs/audit/m3/prior-art.md` Finding 2.
//!
//! `Text` mode does NOT hard-crop to a fixed 16:9 1920x1080 frame. Like
//! `Motion`, it preserves the real display's own aspect ratio
//! (`downscale_to_fit`, wired in `session/media_controller.rs`) — just with a
//! higher resolution ceiling and a lower frame rate, since dense static text
//! benefits far more from resolution than from motion smoothness, and a
//! forced 16:9 crop would need new capture-side cropping logic this audit
//! never exercised. The literal "1920x1080" the design doc names is exactly
//! what `Text` falls back to when there's no real display to query
//! (synthetic capture, non-macOS, Screen Recording not yet granted) — the
//! same situation `Motion` falls back to its own 1280x720 default in.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureMode {
    #[default]
    Motion,
    Text,
}

impl CaptureMode {
    /// Encode/capture frame rate. Static, read-don't-scroll content doesn't
    /// need `Motion`'s 30fps smoothness, and the lower rate buys back some of
    /// the bandwidth/CPU cost of `Text`'s higher resolution ceiling.
    pub fn fps(self) -> u32 {
        match self {
            CaptureMode::Motion => 30,
            CaptureMode::Text => 15,
        }
    }

    /// Resolution ceiling passed to `downscale_to_fit`'s `max_long_edge` —
    /// the real-display-aware path never upscales past the display's own
    /// native resolution regardless of this cap, so this only matters on a
    /// display bigger than the cap.
    pub fn max_capture_long_edge(self) -> u32 {
        match self {
            CaptureMode::Motion => 1920,
            CaptureMode::Text => 2560,
        }
    }

    /// Fallback (width, height) when there's no real display to query.
    pub fn fallback_dimensions(self) -> (u32, u32) {
        match self {
            CaptureMode::Motion => (1280, 720),
            CaptureMode::Text => (1920, 1080),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CaptureMode::Motion => "motion",
            CaptureMode::Text => "text",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_is_the_default() {
        assert_eq!(CaptureMode::default(), CaptureMode::Motion);
    }

    #[test]
    fn text_mode_trades_a_higher_resolution_ceiling_for_a_lower_frame_rate() {
        assert!(
            CaptureMode::Text.max_capture_long_edge() > CaptureMode::Motion.max_capture_long_edge()
        );
        assert!(CaptureMode::Text.fps() < CaptureMode::Motion.fps());
    }

    #[test]
    fn text_mode_falls_back_to_the_literal_1080p_the_design_doc_promised() {
        assert_eq!(CaptureMode::Text.fallback_dimensions(), (1920, 1080));
    }

    #[test]
    fn motion_mode_falls_back_to_todays_existing_720p_default() {
        assert_eq!(CaptureMode::Motion.fallback_dimensions(), (1280, 720));
    }

    #[test]
    fn as_str_round_trips_through_the_wire_lowercase_names() {
        assert_eq!(CaptureMode::Motion.as_str(), "motion");
        assert_eq!(CaptureMode::Text.as_str(), "text");
    }
}
