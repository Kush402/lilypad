//! Software H.264 encoder via openh264. Real, cross-platform, and verifiable in
//! automated tests — the default until VideoToolbox is wired on-device.

use anyhow::{anyhow, Result};
use bytes::Bytes;
use openh264::encoder::{
    BitRate, Encoder as Oh264Encoder, EncoderConfig as Oh264Config, FrameRate, FrameType,
    RateControlMode,
};
use openh264::formats::YUVSlices;
use openh264::OpenH264API;

use super::{EncodedSample, EncoderSettings, VideoEncoder};
use crate::media::convert::bgra_to_i420_into;
use crate::media::frame::{I420Buffer, RawFrame};

pub struct Openh264Encoder {
    inner: Oh264Encoder,
    settings: EncoderSettings,
    frames_since_keyframe: u32,
    frame_index: u64,
    /// Fault injection: `encode` errors for frame indices in
    /// `[fail_after, fail_after + fail_count)` — used to exercise the
    /// pipeline's consecutive-encode-error budget
    /// (`LILYPAD_ENCODER_FAIL_AFTER`/`LILYPAD_ENCODER_FAIL_COUNT`, mirroring
    /// `SyntheticSource`'s `LILYPAD_SYNTHETIC_FAIL_AFTER`). `fail_count` of
    /// `None` means "fail forever once started" (a persistent failure).
    /// Off by default. See `docs/audit/m3/streaming-media.md` Finding 14.
    fail_after: Option<u64>,
    fail_count: Option<u64>,
    /// Scratch I420 buffer reused across every `encode()` call
    /// (`convert::bgra_to_i420_into` resizes it in place only when the
    /// frame's dimensions actually change) instead of allocating three
    /// fresh `Vec`s (Y/U/V) per frame. Safe to reuse — unlike
    /// `VideoToolboxEncoder`'s ping-ponged IOSurfaces, which a hardware
    /// session may still be asynchronously reading when the next frame is
    /// submitted — because `self.inner.encode(&yuv)` is a single synchronous
    /// FFI call into openh264 (`ISVCEncoder::EncodeFrame`): it reads
    /// `self.i420`'s planes only for the duration of that call and copies
    /// what it needs into its own internal picture buffer before returning,
    /// so nothing outside this struct still borrows or aliases `i420` once
    /// `encode()` has returned. One buffer, not two, is therefore enough.
    i420: I420Buffer,
}

impl Openh264Encoder {
    pub fn new(settings: EncoderSettings) -> Result<Self> {
        let inner = build(&settings)?;
        let fail_after = std::env::var("LILYPAD_ENCODER_FAIL_AFTER")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());
        let fail_count = std::env::var("LILYPAD_ENCODER_FAIL_COUNT")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());
        // Real dimensions are whatever the first `encode()` call's frame
        // says — `bgra_to_i420_into` resizes on first use exactly like any
        // later resolution change, so starting at 0×0 costs nothing extra.
        let i420 = I420Buffer::new(0, 0, std::time::Duration::ZERO);
        Ok(Self {
            inner,
            settings,
            frames_since_keyframe: 0,
            frame_index: 0,
            fail_after,
            fail_count,
            i420,
        })
    }
}

fn build(s: &EncoderSettings) -> Result<Oh264Encoder> {
    // Low-latency config: bitrate-controlled, no frame skipping (we manage drops
    // upstream), single-threaded to avoid reordering latency. openh264 emits no
    // B-frames in this configuration.
    let config = Oh264Config::new()
        // 0.8 renamed `set_bitrate_bps(u32)` to `bitrate(BitRate)`; the units
        // are unchanged, the type is now explicit.
        .bitrate(BitRate::from_bps(s.bitrate_kbps.saturating_mul(1000)))
        // 0.8 also gave the frame rate and skip flag typed setters.
        .max_frame_rate(FrameRate::from_hz(s.fps as f32))
        .rate_control_mode(RateControlMode::Bitrate)
        .skip_frames(false);
    Oh264Encoder::with_api_config(OpenH264API::from_source(), config)
        .map_err(|e| anyhow!("openh264 init failed: {e}"))
}

impl VideoEncoder for Openh264Encoder {
    fn encode(&mut self, frame: &RawFrame, force_keyframe: bool) -> Result<Option<EncodedSample>> {
        let index = self.frame_index;
        self.frame_index += 1;
        if let Some(start) = self.fail_after {
            let still_failing = match self.fail_count {
                Some(count) => index >= start && index < start + count,
                None => index >= start,
            };
            if still_failing {
                anyhow::bail!("encoder fault injected at frame {index}");
            }
        }

        if force_keyframe || self.frames_since_keyframe >= self.settings.keyframe_interval {
            self.inner.force_intra_frame();
            self.frames_since_keyframe = 0;
        }

        // openh264 needs YUV; this is the one backend that pays the BGRA→I420
        // conversion cost (VideoToolbox consumes BGRA directly via IOSurface).
        // Writes into `self.i420` in place — see its field doc comment for
        // why reusing the same buffer across calls is safe here.
        bgra_to_i420_into(frame, &mut self.i420);
        let (w, h) = (self.i420.width as usize, self.i420.height as usize);
        let yuv = YUVSlices::new(
            (&self.i420.y, &self.i420.u, &self.i420.v),
            (w, h),
            (
                self.i420.y_stride(),
                self.i420.chroma_stride(),
                self.i420.chroma_stride(),
            ),
        );

        let bitstream = self
            .inner
            .encode(&yuv)
            .map_err(|e| anyhow!("openh264 encode failed: {e}"))?;
        let frame_type = bitstream.frame_type();
        let data = bitstream.to_vec();
        self.frames_since_keyframe = self.frames_since_keyframe.saturating_add(1);

        if data.is_empty() || matches!(frame_type, FrameType::Skip) {
            return Ok(None);
        }
        let is_keyframe = matches!(frame_type, FrameType::IDR | FrameType::I);
        Ok(Some(EncodedSample {
            data: Bytes::from(data),
            is_keyframe,
            timestamp: frame.timestamp,
        }))
    }

    fn set_bitrate(&mut self, kbps: u32) -> Result<()> {
        if kbps != self.settings.bitrate_kbps {
            self.settings.bitrate_kbps = kbps;
            // openh264 0.6 applies bitrate at init; rebuild to retarget (next
            // frame will be an IDR). Coarse but effective for adaptive bitrate.
            self.reset()?;
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<()> {
        self.inner = build(&self.settings)?;
        self.frames_since_keyframe = 0;
        Ok(())
    }

    fn name(&self) -> &'static str {
        "openh264"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ramp_frame(w: u32, h: u32, i: u64) -> RawFrame {
        let mut f = RawFrame::new(w, h, Duration::from_millis(i * 33), i);
        // `RawFrame::new` hands back a uniquely-owned `Arc<Vec<u8>>`.
        for (n, p) in std::sync::Arc::get_mut(&mut f.bgra)
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            *p = ((n + i as usize * 7) & 0xff) as u8;
        }
        f
    }

    #[test]
    fn encodes_real_annexb_keyframe_then_delta() {
        let mut enc = Openh264Encoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .expect("encoder init");

        let s0 = enc
            .encode(&ramp_frame(320, 240, 0), true)
            .unwrap()
            .expect("keyframe");
        assert!(s0.is_keyframe, "forced first frame must be a keyframe");
        assert!(!s0.data.is_empty());
        assert!(
            s0.data.starts_with(&[0, 0, 0, 1]) || s0.data.starts_with(&[0, 0, 1]),
            "expected an Annex-B start code"
        );

        // Subsequent frames encode (may be P-frames).
        let s1 = enc.encode(&ramp_frame(320, 240, 1), false).unwrap();
        assert!(s1.is_some());
    }

    #[test]
    fn set_bitrate_reconfigures_without_error() {
        let mut enc = Openh264Encoder::new(EncoderSettings::default()).unwrap();
        enc.set_bitrate(1500).unwrap();
        assert_eq!(enc.settings.bitrate_kbps, 1500);
    }

    /// The point of Fix 3: encoding a run of same-size frames must not
    /// allocate a fresh I420 buffer every call — `self.i420` (see its field
    /// doc comment) is reused in place across `encode()` calls.
    #[test]
    fn encoding_same_sized_frames_reuses_the_i420_scratch_buffer() {
        let mut enc = Openh264Encoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .expect("encoder init");

        enc.encode(&ramp_frame(320, 240, 0), true).unwrap();
        let (y_cap, u_cap, v_cap) = (
            enc.i420.y.capacity(),
            enc.i420.u.capacity(),
            enc.i420.v.capacity(),
        );

        for i in 1..5u64 {
            enc.encode(&ramp_frame(320, 240, i), false).unwrap();
        }

        assert_eq!(
            enc.i420.y.capacity(),
            y_cap,
            "luma plane must not reallocate"
        );
        assert_eq!(enc.i420.u.capacity(), u_cap, "U plane must not reallocate");
        assert_eq!(enc.i420.v.capacity(), v_cap, "V plane must not reallocate");
    }

    /// A resolution change mid-session (capture mode switch) must still be
    /// handled correctly by the reused buffer, not leave it stuck at the old
    /// size.
    #[test]
    fn encoding_survives_a_resolution_change_across_calls() {
        let mut enc = Openh264Encoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .expect("encoder init");

        enc.encode(&ramp_frame(320, 240, 0), true).unwrap();
        assert_eq!((enc.i420.width, enc.i420.height), (320, 240));

        let s1 = enc
            .encode(&ramp_frame(160, 120, 1), true)
            .unwrap()
            .expect("a forced keyframe at the new resolution must still encode");
        assert!(s1.is_keyframe);
        assert_eq!((enc.i420.width, enc.i420.height), (160, 120));
    }
}
