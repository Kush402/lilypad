//! Desktop media pipeline: capture → pixel conversion → H.264 encode → queue →
//! WebRTC video track. Source- and codec-agnostic behind traits, so the
//! synthetic source / software encoder swap out for ScreenCaptureKit /
//! VideoToolbox with no downstream changes.

pub mod abr;
pub mod capture;
pub mod convert;
pub mod encoder;
pub mod frame;
pub mod metrics;
pub mod mode;
pub mod pipeline;

pub use abr::{AbrConfig, BitrateController};
pub use capture::{
    create_capture, list_displays, main_display_id, CaptureBackend, CaptureConfig, CaptureKind,
    Display,
};
pub use encoder::{create_encoder, EncodedSample, EncoderKind, EncoderSettings, VideoEncoder};
pub use metrics::{MetricsSnapshot, PipelineMetrics};
pub use mode::CaptureMode;
pub use pipeline::{MediaPipeline, PipelineConfig, PipelineControl};
