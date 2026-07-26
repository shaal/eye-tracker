#![deny(clippy::all)]
//! napi-rs surface for `eye-tracker-core`.
//!
//! This crate is deliberately thin: it converts between JS values and core
//! types and does nothing else. All logic — and all of the tests — live in
//! `eye-tracker-core`, which has no Node dependency (ADR-0004).

use napi::bindgen_prelude::*;
use napi_derive::napi;

use eye_tracker_core as core;
use eye_tracker_core::calibration::model::{CalibrationModel, CalibrationReport, FeatureTier};
use eye_tracker_core::config::ClickMode;
use eye_tracker_core::math::{Rect, Vec2};
use eye_tracker_core::mouse::{self, Button, MouseBackend};

// NOTE: `core` is aliased to `eye_tracker_core` throughout this file, which
// shadows Rust's built-in `core` crate — so use `std::fmt` explicitly.
fn err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(e.to_string())
}

// ---------------------------------------------------------------------------
// Plain data
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl From<Vec2> for Point {
    fn from(v: Vec2) -> Self {
        Point { x: v.x, y: v.y }
    }
}

impl From<&Point> for Vec2 {
    fn from(p: &Point) -> Self {
        Vec2::new(p.x, p.y)
    }
}

/// Union of all display bounds, in logical (DIP) pixels with a top-left origin
/// — Electron's `screen` coordinate space (ADR-0010).
#[napi(object)]
pub struct ScreenBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<&ScreenBounds> for Rect {
    fn from(b: &ScreenBounds) -> Self {
        Rect::new(b.x, b.y, b.width, b.height)
    }
}

#[napi(object)]
pub struct FilterConfigPatch {
    pub min_cutoff: Option<f64>,
    pub beta: Option<f64>,
    pub d_cutoff: Option<f64>,
    pub saccade_px: Option<f64>,
    pub clamp_radius: Option<f64>,
    pub clamp_ms: Option<f64>,
    pub clamp_max_hold_ms: Option<f64>,
    pub median_window: Option<u32>,
    pub adaptive_clamp: Option<bool>,
    pub clamp_noise_scale: Option<f64>,
    pub clamp_radius_max: Option<f64>,
    /// Let per-frame confidence modulate smoothing continuously (ADR-0023).
    /// Off reproduces the pre-ADR-0023 pipeline exactly, which is what makes
    /// this A/B-able on real hardware.
    pub confidence_trust: Option<bool>,
    /// Lower bound on the trust scalar, and so on all three modulations at once.
    pub trust_floor: Option<f64>,
}

#[napi(object)]
pub struct BlinkConfigPatch {
    /// "blink" or "wink" (ADR-0013).
    pub mode: Option<String>,
    pub close_thresh: Option<f64>,
    pub open_thresh: Option<f64>,
    pub min_close_ms: Option<f64>,
    pub max_close_ms: Option<f64>,
    pub wink_min_close_ms: Option<f64>,
    pub wink_max_close_ms: Option<f64>,
    pub wink_asymmetry: Option<f64>,
    pub double_window_ms: Option<f64>,
    pub refractory_ms: Option<f64>,
    pub pre_blink_lookback_ms: Option<f64>,
    pub use_geometric_fallback: Option<bool>,
    pub rest_open_ratio: Option<f64>,
}

#[napi(object)]
pub struct GuardConfigPatch {
    pub min_quality: Option<f64>,
    pub track_settle_ms: Option<f64>,
    pub max_frame_age_ms: Option<f64>,
    pub arming_ms: Option<f64>,
}

#[napi(object)]
pub struct TakeoverConfigPatch {
    pub enabled: Option<bool>,
    pub epsilon_px: Option<f64>,
    pub resume_after_ms: Option<f64>,
    pub require_manual_resume: Option<bool>,
}

/// How the calibration fit treats the samples it was given (ADR-0021).
#[napi(object)]
pub struct CalibrationConfigPatch {
    /// Weight each sample by its tracking quality instead of counting every
    /// admitted sample the same. Off reproduces the pre-ADR-0021 fit exactly,
    /// which is what makes this A/B-able.
    pub quality_weighting: Option<bool>,
    /// Lower bound on a sample's weight, so a marginal-but-admitted sample is
    /// discounted rather than deleted.
    pub weight_floor: Option<f64>,
}

#[napi(object)]
pub struct EngineConfigPatch {
    pub filter: Option<FilterConfigPatch>,
    pub blink: Option<BlinkConfigPatch>,
    pub guard: Option<GuardConfigPatch>,
    pub takeover: Option<TakeoverConfigPatch>,
    pub calibration: Option<CalibrationConfigPatch>,
    pub px_per_degree: Option<f64>,
}

macro_rules! patch {
    ($target:expr, $src:expr, $($field:ident),+ $(,)?) => {
        $( if let Some(v) = $src.$field { $target.$field = v; } )+
    };
}

fn apply_patch(cfg: &mut core::EngineConfig, p: &EngineConfigPatch) {
    if let Some(f) = &p.filter {
        patch!(
            cfg.filter, f,
            min_cutoff, beta, d_cutoff, saccade_px, clamp_radius, clamp_ms, clamp_max_hold_ms,
            median_window, adaptive_clamp, clamp_noise_scale, clamp_radius_max,
            confidence_trust, trust_floor
        );
    }
    if let Some(b) = &p.blink {
        patch!(
            cfg.blink, b,
            close_thresh, open_thresh, min_close_ms, max_close_ms,
            wink_min_close_ms, wink_max_close_ms, wink_asymmetry, double_window_ms,
            refractory_ms, pre_blink_lookback_ms, use_geometric_fallback, rest_open_ratio
        );
        // An unrecognised mode string is ignored rather than throwing: the
        // caller is a UI control, and silently keeping the current mode is
        // safer than leaving the engine half-configured.
        if let Some(m) = b.mode.as_deref().and_then(ClickMode::from_name) {
            cfg.blink.mode = m;
        }
    }
    if let Some(g) = &p.guard {
        patch!(cfg.guard, g, min_quality, track_settle_ms, max_frame_age_ms, arming_ms);
    }
    if let Some(tk) = &p.takeover {
        patch!(cfg.takeover, tk, enabled, epsilon_px, resume_after_ms, require_manual_resume);
    }
    if let Some(c) = &p.calibration {
        patch!(cfg.calibration, c, quality_weighting, weight_floor);
    }
    if let Some(v) = p.px_per_degree {
        cfg.px_per_degree = v;
    }
}

/// Resolved configuration, for showing current values in the UI.
#[napi(object)]
pub struct EngineConfigView {
    pub mode: String,
    pub min_cutoff: f64,
    pub beta: f64,
    pub d_cutoff: f64,
    pub saccade_px: f64,
    pub clamp_radius: f64,
    pub clamp_ms: f64,
    pub clamp_max_hold_ms: f64,
    pub median_window: u32,
    pub adaptive_clamp: bool,
    pub clamp_noise_scale: f64,
    pub clamp_radius_max: f64,
    pub confidence_trust: bool,
    pub trust_floor: f64,
    pub close_thresh: f64,
    pub open_thresh: f64,
    pub min_close_ms: f64,
    pub max_close_ms: f64,
    pub wink_min_close_ms: f64,
    pub wink_max_close_ms: f64,
    pub wink_asymmetry: f64,
    pub double_window_ms: f64,
    pub refractory_ms: f64,
    pub pre_blink_lookback_ms: f64,
    pub use_geometric_fallback: bool,
    pub rest_open_ratio: f64,
    pub min_quality: f64,
    pub track_settle_ms: f64,
    pub max_frame_age_ms: f64,
    pub arming_ms: f64,
    pub takeover_enabled: bool,
    pub takeover_epsilon_px: f64,
    pub takeover_resume_after_ms: f64,
    pub takeover_require_manual_resume: bool,
    pub quality_weighting: bool,
    pub weight_floor: f64,
    pub px_per_degree: f64,
}

impl From<&core::EngineConfig> for EngineConfigView {
    fn from(c: &core::EngineConfig) -> Self {
        Self {
            mode: c.blink.mode.as_str().to_string(),
            min_cutoff: c.filter.min_cutoff,
            beta: c.filter.beta,
            d_cutoff: c.filter.d_cutoff,
            saccade_px: c.filter.saccade_px,
            clamp_radius: c.filter.clamp_radius,
            clamp_ms: c.filter.clamp_ms,
            clamp_max_hold_ms: c.filter.clamp_max_hold_ms,
            median_window: c.filter.median_window,
            adaptive_clamp: c.filter.adaptive_clamp,
            clamp_noise_scale: c.filter.clamp_noise_scale,
            clamp_radius_max: c.filter.clamp_radius_max,
            confidence_trust: c.filter.confidence_trust,
            trust_floor: c.filter.trust_floor,
            close_thresh: c.blink.close_thresh,
            open_thresh: c.blink.open_thresh,
            min_close_ms: c.blink.min_close_ms,
            max_close_ms: c.blink.max_close_ms,
            wink_min_close_ms: c.blink.wink_min_close_ms,
            wink_max_close_ms: c.blink.wink_max_close_ms,
            wink_asymmetry: c.blink.wink_asymmetry,
            double_window_ms: c.blink.double_window_ms,
            refractory_ms: c.blink.refractory_ms,
            pre_blink_lookback_ms: c.blink.pre_blink_lookback_ms,
            use_geometric_fallback: c.blink.use_geometric_fallback,
            rest_open_ratio: c.blink.rest_open_ratio,
            min_quality: c.guard.min_quality,
            track_settle_ms: c.guard.track_settle_ms,
            max_frame_age_ms: c.guard.max_frame_age_ms,
            arming_ms: c.guard.arming_ms,
            takeover_enabled: c.takeover.enabled,
            takeover_epsilon_px: c.takeover.epsilon_px,
            takeover_resume_after_ms: c.takeover.resume_after_ms,
            takeover_require_manual_resume: c.takeover.require_manual_resume,
            quality_weighting: c.calibration.quality_weighting,
            weight_floor: c.calibration.weight_floor,
            px_per_degree: c.px_per_degree,
        }
    }
}

#[napi(object)]
pub struct FrameOutput {
    pub has_gaze: bool,
    /// This frame's tracking confidence, independent of the guard's verdict.
    pub quality: f64,
    pub x: f64,
    pub y: f64,
    pub raw_x: f64,
    pub raw_y: f64,
    pub moved: bool,
    /// 0 none, 1 single, 2 double.
    pub click: u32,
    /// 0 left, 1 right, 2 middle.
    pub click_button: u32,
    pub click_x: f64,
    pub click_y: f64,
    /// 0 open, 1 closed, 2 long-close.
    pub blink_phase: u32,
    pub closure: f64,
    pub closure_left: f64,
    pub closure_right: f64,
    /// Head-pose distance from the calibration pose, in standard deviations.
    pub pose_drift: f64,
    /// Whether the loaded model contains head compensation at all.
    pub head_compensated: bool,
    pub clamp_radius: f64,
    pub gaze_spread: f64,
    /// Gaze has yielded to a physical mouse or trackpad (ADR-0016).
    pub manual_override: bool,
    pub guard: u32,
    pub guard_reason: String,
    pub control_enabled: bool,
    pub calibrated: bool,
    pub clamped: bool,
    pub saccade: bool,
    pub fps: f64,
    pub stale: bool,
    pub calibrating: bool,
    pub calibration_samples: u32,
    pub error: Option<String>,
}

impl From<core::FrameOutput> for FrameOutput {
    fn from(o: core::FrameOutput) -> Self {
        Self {
            has_gaze: o.has_gaze,
            quality: o.quality,
            x: o.x,
            y: o.y,
            raw_x: o.raw_x,
            raw_y: o.raw_y,
            moved: o.moved,
            click: u32::from(o.click),
            click_button: u32::from(o.click_button),
            click_x: o.click_x,
            click_y: o.click_y,
            blink_phase: u32::from(o.blink_phase),
            closure: o.closure,
            closure_left: o.closure_left,
            closure_right: o.closure_right,
            pose_drift: o.pose_drift,
            head_compensated: o.head_compensated,
            clamp_radius: o.clamp_radius,
            gaze_spread: o.gaze_spread,
            manual_override: o.manual_override,
            guard: u32::from(o.guard),
            guard_reason: o.guard_reason,
            control_enabled: o.control_enabled,
            calibrated: o.calibrated,
            clamped: o.clamped,
            saccade: o.saccade,
            fps: o.fps,
            stale: o.stale,
            calibrating: o.calibrating,
            calibration_samples: o.calibration_samples,
            error: o.error,
        }
    }
}

#[napi(object)]
pub struct CalibrationReportJs {
    pub tier_name: String,
    pub samples: u32,
    pub targets: u32,
    pub mean_error_px: f64,
    pub p95_error_px: f64,
    pub mean_error_deg: f64,
    pub per_target_error_px: Vec<f64>,
    pub lambda_x: f64,
    pub lambda_y: f64,
    /// False when there were too few targets to hold one out, in which case the
    /// errors are training errors and are optimistic.
    pub cross_validated: bool,
    /// Whether tracking quality weighted the fit (ADR-0021).
    ///
    /// Optional, like the three below it, because a profile saved before
    /// ADR-0021 has none of these fields, and a stored calibration must not
    /// become unloadable just because the report grew.
    pub quality_weighted: Option<bool>,
    /// Mean sample weight — "were my samples mostly good?".
    pub mean_weight: Option<f64>,
    /// Weight of the worst sample that still made it into the fit.
    pub min_weight: Option<f64>,
    /// Kish's effective sample size. Compare against `samples` to see whether
    /// the weight spread was material.
    pub effective_samples: Option<f64>,
}

impl From<&CalibrationReport> for CalibrationReportJs {
    fn from(r: &CalibrationReport) -> Self {
        Self {
            tier_name: r.tier_name.clone(),
            samples: r.samples as u32,
            targets: r.targets as u32,
            mean_error_px: r.mean_error_px,
            p95_error_px: r.p95_error_px,
            mean_error_deg: r.mean_error_deg,
            per_target_error_px: r.per_target_error_px.clone(),
            lambda_x: r.lambda_x,
            lambda_y: r.lambda_y,
            cross_validated: r.cross_validated,
            quality_weighted: Some(r.quality_weighted),
            mean_weight: Some(r.mean_weight),
            min_weight: Some(r.min_weight),
            effective_samples: Some(r.effective_samples),
        }
    }
}

/// One calibration sample in gaze-feature space, for the debug scatter plot.
///
/// If the per-target clusters overlap here, the input signal never separated
/// the targets and no amount of refitting will help — a different diagnosis to
/// "the fit was poor" (ADR-0006).
#[napi(object)]
pub struct ScatterPointJs {
    pub gx: f64,
    pub gy: f64,
    pub target_index: u32,
    /// False when the outlier filter dropped this sample from the fit.
    pub kept: bool,
}

/// Serializable calibration, for persisting a profile to disk.
#[napi(object)]
pub struct CalibrationModelJs {
    pub tier: String,
    pub mean: Vec<f64>,
    pub scale: Vec<f64>,
    pub beta_x: Vec<f64>,
    pub beta_y: Vec<f64>,
    pub intercept_x: f64,
    pub intercept_y: f64,
    pub lambda_x: f64,
    pub lambda_y: f64,
    pub display_fingerprint: String,
    pub report: CalibrationReportJs,
    /// Mean head pose during calibration (yaw, pitch, roll, hx, hy, hz).
    pub pose_mean: Vec<f64>,
    /// Head-pose spread during calibration. Near-zero here means the user held
    /// still and the model contains no head compensation (ADR-0015).
    pub pose_std: Vec<f64>,
}

impl From<&CalibrationModel> for CalibrationModelJs {
    fn from(m: &CalibrationModel) -> Self {
        Self {
            tier: m.tier.as_str().to_string(),
            mean: m.mean.clone(),
            scale: m.scale.clone(),
            beta_x: m.beta_x.clone(),
            beta_y: m.beta_y.clone(),
            intercept_x: m.intercept_x,
            intercept_y: m.intercept_y,
            lambda_x: m.lambda_x,
            lambda_y: m.lambda_y,
            display_fingerprint: m.display_fingerprint.clone(),
            report: (&m.report).into(),
            pose_mean: m.pose_mean.clone(),
            pose_std: m.pose_std.clone(),
        }
    }
}

impl TryFrom<&CalibrationModelJs> for CalibrationModel {
    type Error = Error;

    fn try_from(m: &CalibrationModelJs) -> Result<Self> {
        let tier = match m.tier.as_str() {
            "basic" => FeatureTier::Basic,
            "full" => FeatureTier::Full,
            other => return Err(Error::from_reason(format!("unknown feature tier '{other}'"))),
        };
        // A profile whose vectors do not match its tier would silently produce
        // nonsense predictions, so reject it at load time.
        let p = tier.len();
        for (name, v) in [
            ("mean", &m.mean),
            ("scale", &m.scale),
            ("betaX", &m.beta_x),
            ("betaY", &m.beta_y),
        ] {
            if v.len() != p {
                return Err(Error::from_reason(format!(
                    "calibration profile is corrupt: {name} has {} entries, tier '{}' needs {p}",
                    v.len(),
                    m.tier
                )));
            }
        }
        Ok(CalibrationModel {
            tier,
            mean: m.mean.clone(),
            scale: m.scale.clone(),
            beta_x: m.beta_x.clone(),
            beta_y: m.beta_y.clone(),
            intercept_x: m.intercept_x,
            intercept_y: m.intercept_y,
            lambda_x: m.lambda_x,
            lambda_y: m.lambda_y,
            pose_mean: if m.pose_mean.len() == 6 { m.pose_mean.clone() } else { vec![0.0; 6] },
            pose_std: if m.pose_std.len() == 6 { m.pose_std.clone() } else { vec![0.0; 6] },
            report: CalibrationReport {
                tier_name: m.report.tier_name.clone(),
                samples: m.report.samples as usize,
                targets: m.report.targets as usize,
                mean_error_px: m.report.mean_error_px,
                p95_error_px: m.report.p95_error_px,
                mean_error_deg: m.report.mean_error_deg,
                per_target_error_px: m.report.per_target_error_px.clone(),
                lambda_x: m.report.lambda_x,
                lambda_y: m.report.lambda_y,
                cross_validated: m.report.cross_validated,
                // A pre-ADR-0021 profile was fitted unweighted, so that is
                // exactly what the absent fields mean.
                quality_weighted: m.report.quality_weighted.unwrap_or(false),
                mean_weight: m.report.mean_weight.unwrap_or(1.0),
                min_weight: m.report.min_weight.unwrap_or(1.0),
                effective_samples: m
                    .report
                    .effective_samples
                    .unwrap_or(m.report.samples as f64),
            },
            display_fingerprint: m.display_fingerprint.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

#[napi]
pub fn core_version() -> String {
    core::version().to_string()
}

/// Number of f64 slots in a packed frame. The renderer asserts against this so
/// a drifted layout fails loudly at startup (ADR-0009).
#[napi]
pub fn frame_width() -> u32 {
    core::FRAME_WIDTH as u32
}

/// Whether this process may synthesize input events that reach other apps.
///
/// On macOS this is Accessibility authorization. Checking matters: without it,
/// `CGEventPost` silently succeeds and does nothing (ADR-0011).
#[napi]
pub fn check_accessibility_permission(prompt: bool) -> bool {
    mouse::permissions::has_input_permission(prompt)
}

fn backend() -> Result<Box<dyn MouseBackend>> {
    mouse::default_backend().map_err(err)
}

/// Move the cursor. Exposed for the debug panel and smoke tests (milestone M2).
#[napi]
pub fn move_cursor(x: f64, y: f64) -> Result<()> {
    backend()?.move_to(x, y).map_err(err)
}

/// Click at the current cursor position. `count` of 2 issues a genuine
/// double-click, not two singles (ADR-0010).
#[napi]
pub fn click_cursor(count: u32) -> Result<()> {
    backend()?.click(Button::Left, count.clamp(1, 3) as u8).map_err(err)
}

#[napi]
pub fn cursor_position() -> Result<Point> {
    let (x, y) = backend()?.cursor_position().map_err(err)?;
    Ok(Point { x, y })
}

#[napi]
pub fn mouse_backend_name() -> Result<String> {
    Ok(backend()?.name().to_string())
}

/// Standard calibration target layout for a work area (ADR-0006).
#[napi]
pub fn calibration_targets(bounds: ScreenBounds, points: u32) -> Vec<Point> {
    eye_tracker_core::calibration::target_grid(&(&bounds).into(), points)
        .into_iter()
        .map(Point::from)
        .collect()
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[napi]
pub struct Engine {
    inner: core::Engine,
}

#[napi]
impl Engine {
    #[napi(constructor)]
    pub fn new(bounds: ScreenBounds, config: Option<EngineConfigPatch>) -> Result<Self> {
        let mut cfg = core::EngineConfig::default();
        if let Some(p) = &config {
            apply_patch(&mut cfg, p);
        }
        let mouse = backend()?;
        Ok(Self { inner: core::Engine::new(cfg, (&bounds).into(), mouse) })
    }

    /// The hot path: one call per camera frame (ADR-0004).
    #[napi]
    pub fn push_frame(&mut self, frame: Float64Array) -> Result<FrameOutput> {
        let slots: &[f64] = &frame;
        self.inner.push_frame(slots).map(FrameOutput::from).map_err(err)
    }

    #[napi]
    pub fn set_control_enabled(&mut self, enabled: bool, now_ms: f64) {
        self.inner.set_control_enabled(enabled, now_ms);
    }

    #[napi(getter)]
    pub fn control_enabled(&self) -> bool {
        self.inner.control_enabled()
    }

    #[napi(getter)]
    pub fn calibrated(&self) -> bool {
        self.inner.is_calibrated()
    }

    #[napi(getter)]
    pub fn calibrating(&self) -> bool {
        self.inner.is_calibrating()
    }

    #[napi(getter)]
    pub fn backend_name(&self) -> String {
        self.inner.backend_name().to_string()
    }

    #[napi]
    pub fn set_bounds(&mut self, bounds: ScreenBounds) {
        self.inner.set_bounds((&bounds).into());
    }

    #[napi]
    pub fn set_config(&mut self, patch: EngineConfigPatch) {
        let mut cfg = *self.inner.config();
        apply_patch(&mut cfg, &patch);
        self.inner.set_config(cfg);
    }

    #[napi]
    pub fn get_config(&self) -> EngineConfigView {
        self.inner.config().into()
    }

    // -- calibration --

    #[napi]
    pub fn begin_calibration(&mut self, targets: Vec<Point>) {
        self.inner.begin_calibration(targets.iter().map(Vec2::from).collect());
    }

    /// Arm collection for a target, or pass nothing to disarm between targets.
    #[napi]
    pub fn set_calibration_target(&mut self, target_index: Option<u32>) {
        self.inner.set_calibration_target(target_index.map(|i| i as usize));
    }

    #[napi]
    pub fn calibration_progress(&self, target_index: u32) -> u32 {
        self.inner.calibration_progress(target_index as usize) as u32
    }

    #[napi]
    pub fn cancel_calibration(&mut self) {
        self.inner.cancel_calibration();
    }

    #[napi]
    pub fn finish_calibration(&mut self, display_fingerprint: String) -> Result<CalibrationModelJs> {
        let m = self.inner.finish_calibration(display_fingerprint).map_err(err)?;
        Ok((&m).into())
    }

    #[napi]
    pub fn load_calibration(&mut self, model: CalibrationModelJs) -> Result<()> {
        let m = CalibrationModel::try_from(&model)?;
        self.inner.load_calibration(m);
        Ok(())
    }

    #[napi]
    pub fn get_calibration(&self) -> Option<CalibrationModelJs> {
        self.inner.calibration().map(CalibrationModelJs::from)
    }

    #[napi]
    pub fn clear_calibration(&mut self) {
        self.inner.clear_calibration();
    }

    /// Gaze-feature scatter from the most recent calibration run, including the
    /// samples the outlier filter rejected. Debug panel only — not a hot path.
    #[napi]
    pub fn calibration_scatter(&self) -> Vec<ScatterPointJs> {
        self.inner
            .calibration_scatter()
            .iter()
            .map(|p| ScatterPointJs {
                gx: p.gx,
                gy: p.gy,
                target_index: p.target_index as u32,
                kept: p.kept,
            })
            .collect()
    }

    /// Map a synthetic frame through the calibration model without touching any
    /// engine state. The debug panel finite-differences this to measure how many
    /// screen pixels one unit of iris offset is worth.
    ///
    /// Returns nothing when there is no calibration loaded.
    #[napi]
    pub fn predict_frame(&self, frame: Float64Array) -> Result<Option<Point>> {
        let slots: &[f64] = &frame;
        Ok(self.inner.predict_frame(slots).map_err(err)?.map(Point::from))
    }

    #[napi]
    pub fn take_error(&mut self) -> Option<String> {
        self.inner.take_error()
    }

    /// Resume gaze control after the user took over with a physical pointing
    /// device (ADR-0016). Only needed when `requireManualResume` is set.
    #[napi]
    pub fn resume_from_manual(&mut self) {
        self.inner.resume_from_manual();
    }
}
