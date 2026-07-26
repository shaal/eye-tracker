//! Gaze estimation, smoothing, blink detection and native mouse control.
//!
//! This crate is deliberately free of any Node/napi dependency so that the
//! parts most likely to be subtly wrong — the ridge solver, the filter, the
//! blink state machine — are testable with no JS runtime, no camera and no
//! display (ADR-0004). The napi surface lives in `eye-tracker-bindings`.
//!
//! Pipeline, one call per camera frame:
//!
//! ```text
//! packed Float64Array  →  GazeFrame          (frame.rs,        ADR-0009)
//!                      →  CalibrationModel   (calibration/,    ADR-0006)
//!                      →  FilterPipeline     (filter/,         ADR-0007)
//!                      →  BlinkFsm+Arbiter   (blink/,          ADR-0008)
//!                      →  MouseBackend       (mouse/,          ADR-0010)
//! ```

pub mod blink;
pub mod calibration;
pub mod config;
pub mod engine;
pub mod filter;
pub mod frame;
pub mod math;
pub mod mouse;

pub use config::{BlinkConfig, CalibrationConfig, EngineConfig, FilterConfig, GuardConfig};
pub use engine::{Engine, EngineError, FrameOutput, Guard};
pub use frame::{GazeFrame, FRAME_WIDTH};
pub use math::{Rect, Vec2};

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
