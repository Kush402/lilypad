//! macOS VideoToolbox hardware H.264 encoder — real implementation.
//!
//! Feeds the captured BGRA frame directly into an `IOSurface` (matching the
//! `videotoolbox` crate's own documented usage — VideoToolbox's hardware does
//! the BGRA→YUV conversion internally, so this backend skips the software
//! `bgra_to_i420` conversion entirely, unlike the openh264 backend). Output is
//! VideoToolbox's native AVCC (length-prefixed NALs); converted to Annex-B for
//! the WebRTC track, and keyframes are detected from the NAL type (5 = IDR).
//!
//! CRITICAL: VideoToolbox carries the H.264 parameter sets (SPS/PPS) in the
//! sample buffer's `CMFormatDescription`, NOT inline in the bitstream — a raw
//! keyframe from the encoder contains only SEI + IDR. A WebRTC receiver cannot
//! initialize its decoder without SPS/PPS, so every keyframe MUST have the
//! parameter sets prepended (Annex-B). We extract them from the format
//! description and inject them ahead of each keyframe's NALs.
//!
//! No OS permission is required for VideoToolbox itself (unlike Accessibility/
//! Screen Recording), so this is fully exercisable headlessly.

use std::os::raw::c_int;

use anyhow::{anyhow, Result};
use apple_cf::iosurface::IOSurface;
use bytes::Bytes;
use videotoolbox::{ffi, Codec, CompressionSession, CompressionSessionBuilder};

use super::{EncodedSample, EncoderSettings, VideoEncoder};
use crate::media::frame::RawFrame;

const BGRA_FOURCC: u32 = u32::from_be_bytes(*b"BGRA");

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        video_desc: *const std::ffi::c_void,
        index: usize,
        param_set_ptr_out: *mut *const u8,
        param_set_size_out: *mut usize,
        param_set_count_out: *mut usize,
        nal_header_len_out: *mut c_int,
    ) -> i32;
}

/// Extract the H.264 parameter sets (SPS, PPS, …) from an encoded frame's
/// format description as raw NAL bytes (no start codes). Empty if unavailable.
fn parameter_sets(frame: &videotoolbox::EncodedFrame) -> Vec<Vec<u8>> {
    let Some(sample) = frame.cm_sample_buffer() else {
        return Vec::new();
    };
    let Some(fmt) = sample.format_description() else {
        return Vec::new();
    };
    let desc = fmt.as_ptr() as *const std::ffi::c_void;

    // First call (index 0) also reports the total parameter-set count.
    let mut count: usize = 0;
    let mut first_ptr: *const u8 = std::ptr::null();
    let mut first_size: usize = 0;
    let status = unsafe {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            desc,
            0,
            &mut first_ptr,
            &mut first_size,
            &mut count,
            std::ptr::null_mut(),
        )
    };
    if status != 0 || count == 0 || first_ptr.is_null() {
        return Vec::new();
    }

    let mut sets = Vec::with_capacity(count);
    for i in 0..count {
        let mut ptr: *const u8 = std::ptr::null();
        let mut size: usize = 0;
        let ok = unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                desc,
                i,
                &mut ptr,
                &mut size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 && !ptr.is_null() && size > 0 {
            sets.push(unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec());
        }
    }
    sets
}

pub struct VideoToolboxEncoder {
    settings: EncoderSettings,
    session: CompressionSession,
    frame_index: i64,
    /// Two surfaces used ping-pong, reused across frames — `IOSurface::create`
    /// is a kernel allocation, wasteful per frame, but a *single* reused
    /// surface stalls: the encoder can still hold frame N's surface when we
    /// lock it to write frame N+1. Alternating between two avoids both.
    /// Recreated only on a dimension change.
    surfaces: Option<(u32, u32, [IOSurface; 2])>,
    surface_flip: usize,
}

fn build_session(s: &EncoderSettings) -> Result<CompressionSession> {
    CompressionSessionBuilder::new(s.width as i32, s.height as i32, Codec::H264)
        .with_real_time(true)
        // No B-frames: low latency over compression efficiency.
        .with_allow_frame_reordering(false)
        // Short GOP: VideoToolbox forces a periodic IDR at this interval.
        .with_max_keyframe_interval(s.keyframe_interval.max(1) as i32)
        .with_average_bit_rate(s.bitrate_kbps.saturating_mul(1000) as i32)
        .with_expected_frame_rate(f64::from(s.fps.max(1)))
        .build()
        .map_err(|e| anyhow!("VideoToolbox session create failed: {e:?}"))
}

impl VideoToolboxEncoder {
    pub fn new(settings: EncoderSettings) -> Result<Self> {
        let session = build_session(&settings)?;
        Ok(Self {
            settings,
            session,
            frame_index: 0,
            surfaces: None,
            surface_flip: 0,
        })
    }

    /// The next ping-pong IOSurface for these dimensions, creating the pair on
    /// first use or after a resolution change.
    fn next_surface(&mut self, width: u32, height: u32) -> Result<&IOSurface> {
        let stale = !matches!(&self.surfaces, Some((w, h, _)) if *w == width && *h == height);
        if stale {
            let make = || {
                IOSurface::create(width as usize, height as usize, BGRA_FOURCC, 4)
                    .ok_or_else(|| anyhow!("failed to allocate IOSurface"))
            };
            self.surfaces = Some((width, height, [make()?, make()?]));
            self.surface_flip = 0;
        }
        self.surface_flip ^= 1;
        Ok(&self.surfaces.as_ref().unwrap().2[self.surface_flip])
    }

    fn write_bgra_into_surface(surface: &IOSurface, frame: &RawFrame) -> Result<()> {
        let mut guard = surface
            .lock_read_write()
            .map_err(|e| anyhow!("IOSurface lock failed (status {e})"))?;
        let stride = guard.bytes_per_row();
        let src_row_bytes = frame.width as usize * 4;
        let dest = guard
            .as_slice_mut()
            .ok_or_else(|| anyhow!("IOSurface has no writable backing store"))?;
        for y in 0..frame.height as usize {
            let src_start = y * src_row_bytes;
            let dst_start = y * stride;
            let copy_len = src_row_bytes.min(stride);
            dest[dst_start..dst_start + copy_len]
                .copy_from_slice(&frame.bgra[src_start..src_start + copy_len]);
        }
        Ok(())
    }
}

impl VideoEncoder for VideoToolboxEncoder {
    fn encode(&mut self, frame: &RawFrame, force_keyframe: bool) -> Result<Option<EncodedSample>> {
        // The crate doesn't expose a per-frame force-keyframe hook (Videotoolbox's
        // C API takes it via per-frame properties, which `encode()` doesn't
        // surface yet). A freshly built session's first frame is always an IDR,
        // so rebuilding is the honest way to satisfy a forced keyframe today —
        // periodic keyframes still come for free from `max_keyframe_interval`.
        if force_keyframe && self.frame_index != 0 {
            self.reset()?;
        }

        self.next_surface(frame.width, frame.height)?;
        let flip = self.surface_flip;
        let surface = &self.surfaces.as_ref().unwrap().2[flip];
        Self::write_bgra_into_surface(surface, frame)?;

        let pts = (self.frame_index, self.settings.fps.max(1) as i32);
        self.frame_index += 1;

        let encoded = self
            .session
            .encode(surface, pts)
            .map_err(|e| anyhow!("VideoToolbox encode failed: {e:?}"))?;

        if encoded.data.is_empty() {
            return Ok(None); // dropped frame
        }
        let (annex_b, is_keyframe) = avcc_to_annexb(&encoded.data);
        if annex_b.is_empty() {
            return Ok(None);
        }

        // A keyframe is undecodable without SPS/PPS, which VideoToolbox keeps
        // out-of-band in the format description. Prepend them (Annex-B) so the
        // receiver's decoder can initialize on any keyframe — including after
        // a mid-stream PLI recovery.
        let data = if is_keyframe {
            let mut out = Vec::with_capacity(annex_b.len() + 64);
            for set in parameter_sets(&encoded) {
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(&set);
            }
            out.extend_from_slice(&annex_b);
            out
        } else {
            annex_b
        };

        Ok(Some(EncodedSample {
            data: Bytes::from(data),
            is_keyframe,
            timestamp: frame.timestamp,
        }))
    }

    /// Retarget the encoder's average bitrate WITHOUT rebuilding the
    /// `VTCompressionSession` — a full rebuild (the previous implementation)
    /// forces a fresh IDR and briefly stalls encoding on every ABR
    /// adjustment, which happens roughly every couple of seconds under
    /// changing network conditions. `VTSessionSetProperty` on a live session
    /// is Apple's documented mechanism for exactly this: `AverageBitRate` is
    /// one of the properties explicitly listed as adjustable mid-session
    /// (`VTCompressionProperties.h`). See
    /// `docs/audit/m3/streaming-media.md` Finding 10.
    fn set_bitrate(&mut self, kbps: u32) -> Result<()> {
        if kbps != self.settings.bitrate_kbps {
            let bps = kbps.saturating_mul(1000) as i32;
            // SAFETY: `kVTCompressionPropertyKey_AverageBitRate` is a valid
            // static CFStringRef exported by VideoToolbox; `value_ref` is a
            // freshly created, valid CFNumberRef of matching type, released
            // right after the call per Core Foundation's create-rule.
            unsafe {
                let value_ref = ffi::CFNumberCreate(
                    ffi::kCFAllocatorDefault,
                    ffi::kCFNumberSInt32Type,
                    core::ptr::from_ref(&bps).cast(),
                );
                let result = self.session.set_property(
                    ffi::kVTCompressionPropertyKey_AverageBitRate,
                    value_ref.cast(),
                );
                ffi::CFRelease(value_ref.cast());
                result
                    .map_err(|e| anyhow!("VTSessionSetProperty(AverageBitRate) failed: {e:?}"))?;
            }
            self.settings.bitrate_kbps = kbps;
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<()> {
        self.session = build_session(&self.settings)?;
        self.frame_index = 0;
        Ok(())
    }

    fn name(&self) -> &'static str {
        "videotoolbox"
    }
}

/// VideoToolbox's native output is AVCC (each NAL prefixed by a 4-byte
/// big-endian length); the WebRTC H.264 packetizer expects Annex-B (start-code
/// prefixed). Also reports whether the sample contains an IDR NAL (type 5).
fn avcc_to_annexb(avcc: &[u8]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(avcc.len() + 16);
    let mut is_keyframe = false;
    let mut i = 0usize;
    while i + 4 <= avcc.len() {
        let len = u32::from_be_bytes([avcc[i], avcc[i + 1], avcc[i + 2], avcc[i + 3]]) as usize;
        i += 4;
        if len == 0 || i + len > avcc.len() {
            break;
        }
        let nal = &avcc[i..i + len];
        if !nal.is_empty() && (nal[0] & 0x1F) == 5 {
            is_keyframe = true;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(nal);
        i += len;
    }
    (out, is_keyframe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ramp_frame(w: u32, h: u32, i: u64) -> RawFrame {
        let mut f = RawFrame::new(w, h, Duration::from_millis(i * 33), i);
        for (n, p) in f.bgra.iter_mut().enumerate() {
            *p = ((n + i as usize * 7) & 0xff) as u8;
        }
        f
    }

    /// Collect the NAL-unit types from an Annex-B bitstream (start codes 3 or 4).
    fn annexb_nal_types(data: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 3 < data.len() {
            let sc4 = data[i..i + 4] == [0, 0, 0, 1];
            let sc3 = data[i..i + 3] == [0, 0, 1];
            if sc4 || sc3 {
                let hdr = i + if sc4 { 4 } else { 3 };
                if hdr < data.len() {
                    types.push(data[hdr] & 0x1F);
                }
                i = hdr;
            } else {
                i += 1;
            }
        }
        types
    }

    #[test]
    fn avcc_to_annexb_converts_single_nal_and_detects_idr() {
        // One 3-byte NAL (type 5 = IDR) with a 4-byte length prefix.
        let nal = [0x65u8, 0xAA, 0xBB]; // 0x65 & 0x1F == 5
        let mut avcc = (nal.len() as u32).to_be_bytes().to_vec();
        avcc.extend_from_slice(&nal);
        let (annexb, is_keyframe) = avcc_to_annexb(&avcc);
        assert!(is_keyframe);
        assert_eq!(annexb, [&[0, 0, 0, 1][..], &nal[..]].concat());
    }

    #[test]
    fn avcc_to_annexb_handles_multiple_nals_non_keyframe() {
        let nal1 = [0x41u8, 0x01, 0x02]; // type 1 = non-IDR slice
        let nal2 = [0x41u8, 0x03];
        let mut avcc = Vec::new();
        avcc.extend_from_slice(&(nal1.len() as u32).to_be_bytes());
        avcc.extend_from_slice(&nal1);
        avcc.extend_from_slice(&(nal2.len() as u32).to_be_bytes());
        avcc.extend_from_slice(&nal2);

        let (annexb, is_keyframe) = avcc_to_annexb(&avcc);
        assert!(!is_keyframe);
        let mut expected = vec![0, 0, 0, 1];
        expected.extend_from_slice(&nal1);
        expected.extend_from_slice(&[0, 0, 0, 1]);
        expected.extend_from_slice(&nal2);
        assert_eq!(annexb, expected);
    }

    #[test]
    fn avcc_to_annexb_empty_input_yields_empty_output() {
        let (annexb, is_keyframe) = avcc_to_annexb(&[]);
        assert!(annexb.is_empty());
        assert!(!is_keyframe);
    }

    #[test]
    fn encodes_a_real_hardware_keyframe_then_delta() {
        let mut enc = VideoToolboxEncoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .expect("VideoToolbox session should build with no special permission");

        let s0 = enc
            .encode(&ramp_frame(320, 240, 0), true)
            .unwrap()
            .expect("keyframe sample");
        assert!(
            s0.is_keyframe,
            "first frame from a fresh session must be an IDR"
        );
        assert!(
            s0.data.starts_with(&[0, 0, 0, 1]),
            "expected an Annex-B start code"
        );
        // The keyframe MUST carry SPS(7)+PPS(8) or the receiver can't decode it.
        let types = annexb_nal_types(&s0.data);
        assert!(
            types.contains(&7),
            "keyframe missing SPS (7); got {types:?}"
        );
        assert!(
            types.contains(&8),
            "keyframe missing PPS (8); got {types:?}"
        );
        assert!(
            types.contains(&5),
            "keyframe missing IDR (5); got {types:?}"
        );

        let s1 = enc.encode(&ramp_frame(320, 240, 1), false).unwrap();
        assert!(s1.is_some(), "second frame should also produce output");
    }

    #[test]
    fn reused_iosurface_sustains_a_multi_frame_stream() {
        // The IOSurface is cached across frames — a corruption bug in the
        // reuse path would break delta encoding within a few frames.
        let mut enc = VideoToolboxEncoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .unwrap();
        let mut produced = 0;
        for i in 0..12u64 {
            if enc
                .encode(&ramp_frame(320, 240, i), i == 0)
                .unwrap()
                .is_some()
            {
                produced += 1;
            }
        }
        assert!(produced >= 10, "only {produced}/12 frames produced output");
        // Exactly one pair of surfaces was allocated for these dimensions.
        assert!(matches!(enc.surfaces, Some((320, 240, _))));
    }

    #[test]
    fn set_bitrate_reconfigures_without_error() {
        let mut enc = VideoToolboxEncoder::new(EncoderSettings::default()).unwrap();
        enc.set_bitrate(1500).unwrap();
        assert_eq!(enc.settings.bitrate_kbps, 1500);
    }

    #[test]
    fn set_bitrate_does_not_rebuild_the_session() {
        // Regression test for docs/audit/m3/streaming-media.md Finding 10: a
        // rebuild resets `frame_index` to 0 and forces the *next* frame to be
        // an IDR (see `encode`'s `force_keyframe && self.frame_index != 0`
        // check). If set_bitrate still rebuilt, frame_index would read back
        // as 0 here instead of continuing to climb.
        let mut enc = VideoToolboxEncoder::new(EncoderSettings {
            width: 320,
            height: 240,
            fps: 30,
            bitrate_kbps: 1000,
            keyframe_interval: 30,
        })
        .unwrap();
        enc.encode(&ramp_frame(320, 240, 0), true).unwrap();
        enc.encode(&ramp_frame(320, 240, 1), false).unwrap();
        assert_eq!(enc.frame_index, 2);

        enc.set_bitrate(2500).unwrap();
        assert_eq!(
            enc.frame_index, 2,
            "set_bitrate must not reset frame_index — that would mean it rebuilt the session"
        );

        // Encoding continues to work fine after an in-place retarget.
        let s = enc.encode(&ramp_frame(320, 240, 2), false).unwrap();
        assert!(
            s.is_some(),
            "encoding should continue normally post-retarget"
        );
        assert_eq!(enc.frame_index, 3);
    }
}
