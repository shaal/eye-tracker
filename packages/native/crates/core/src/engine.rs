//! The engine facade: one call per camera frame runs mapping → filter → blink
//! → mouse and returns a snapshot for the UI (ADR-0004).

use crate::blink::arbiter::{ClickArbiter, ClickKind};
use crate::blink::fsm::BlinkPhase;
use crate::blink::gesture::GestureDetector;
use crate::calibration::{
    CalibrationError, CalibrationModel, Collector, SampleRejection, ScatterPoint,
};
use crate::config::EngineConfig;
use crate::filter::history::History;
use crate::filter::pipeline::FilterPipeline;
use crate::frame::{FrameError, GazeFrame};
use crate::math::{Rect, Vec2};
use crate::mouse::{Button, MouseBackend, MouseError};

/// Diagonal of a 1080p display. Pixel thresholds are authored against this and
/// scaled to the actual work area (ADR-0007).
const NOMINAL_DIAGONAL: f64 = 2202.9;

/// Why the cursor is not being driven.
///
/// The HUD names the specific guard rather than showing a single boolean,
/// because "why is it not moving?" is otherwise an unanswerable support
/// question (ADR-0011).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guard {
    Ok,
    ControlDisabled,
    Calibrating,
    NoCalibration,
    NoFace,
    LowQuality,
    StaleFrame,
    Blinking,
    /// Control was enabled very recently; a blink in flight must not click.
    Arming,
    /// Face not yet tracked continuously for long enough.
    Settling,
    /// The user touched a physical mouse or trackpad; gaze has yielded to them
    /// (ADR-0016).
    ManualOverride,
}

impl Guard {
    pub fn as_u8(self) -> u8 {
        match self {
            Guard::Ok => 0,
            Guard::ControlDisabled => 1,
            Guard::Calibrating => 2,
            Guard::NoCalibration => 3,
            Guard::NoFace => 4,
            Guard::LowQuality => 5,
            Guard::StaleFrame => 6,
            Guard::Blinking => 7,
            Guard::Arming => 8,
            Guard::Settling => 9,
            Guard::ManualOverride => 10,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Guard::Ok => "ok",
            Guard::ControlDisabled => "control disabled",
            Guard::Calibrating => "calibrating",
            Guard::NoCalibration => "not calibrated",
            Guard::NoFace => "no face detected",
            Guard::LowQuality => "tracking quality too low",
            Guard::StaleFrame => "frame gap too large",
            Guard::Blinking => "blink in progress",
            Guard::Arming => "arming",
            Guard::Settling => "waiting for stable tracking",
            Guard::ManualOverride => "yielded to mouse/trackpad",
        }
    }
}

/// Per-frame snapshot returned to the UI.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameOutput {
    /// False when no calibration is loaded or no face was found.
    pub has_gaze: bool,
    /// This frame's tracking confidence, passed straight through.
    ///
    /// The guard already refuses to move the cursor below the quality
    /// threshold, but it reports only its *first* reason — so while control is
    /// off it says "control disabled" and hides a quality problem entirely.
    /// Validation and the debug HUD need the number itself, not the verdict.
    pub quality: f64,
    /// Smoothed cursor position (screen DIP).
    pub x: f64,
    pub y: f64,
    /// Pre-filter mapped point, for the debug overlay.
    pub raw_x: f64,
    pub raw_y: f64,
    pub moved: bool,
    /// 0 none, 1 single, 2 double.
    pub click: u8,
    /// 0 left, 1 right, 2 middle.
    pub click_button: u8,
    pub click_x: f64,
    pub click_y: f64,
    /// 0 open, 1 closed, 2 long-close.
    pub blink_phase: u8,
    /// Both-eye closure (the minimum of the two).
    pub closure: f64,
    pub closure_left: f64,
    pub closure_right: f64,
    /// Head-pose distance from the calibration pose, in standard deviations.
    /// Above ~3 the model is extrapolating (ADR-0015).
    pub pose_drift: f64,
    /// Whether the loaded model actually contains head compensation.
    pub head_compensated: bool,
    /// Fixation clamp radius currently in use, after adaptation.
    pub clamp_radius: f64,
    /// Measured gaze spread in px — distinguishes tracking noise from filter
    /// settings when diagnosing a shaky cursor.
    pub gaze_spread: f64,
    /// Gaze has yielded to a physical mouse or trackpad (ADR-0016).
    pub manual_override: bool,
    pub guard: u8,
    pub guard_reason: String,
    pub control_enabled: bool,
    pub calibrated: bool,
    pub clamped: bool,
    pub saccade: bool,
    /// Frames per second, smoothed.
    pub fps: f64,
    /// Set when the frame arrived out of order and was dropped.
    pub stale: bool,
    pub calibrating: bool,
    pub calibration_samples: u32,
    /// Last non-fatal backend error, if any.
    pub error: Option<String>,
}

impl Default for FrameOutput {
    fn default() -> Self {
        Self {
            has_gaze: false,
            quality: 0.0,
            x: 0.0,
            y: 0.0,
            raw_x: 0.0,
            raw_y: 0.0,
            moved: false,
            click: 0,
            click_button: 0,
            click_x: 0.0,
            click_y: 0.0,
            blink_phase: 0,
            closure: 0.0,
            closure_left: 0.0,
            closure_right: 0.0,
            pose_drift: 0.0,
            head_compensated: false,
            clamp_radius: 0.0,
            gaze_spread: 0.0,
            manual_override: false,
            guard: Guard::ControlDisabled.as_u8(),
            guard_reason: Guard::ControlDisabled.as_str().to_string(),
            control_enabled: false,
            calibrated: false,
            clamped: false,
            saccade: false,
            fps: 0.0,
            stale: false,
            calibrating: false,
            calibration_samples: 0,
            error: None,
        }
    }
}

#[derive(Debug)]
pub enum EngineError {
    Frame(FrameError),
    Calibration(CalibrationError),
    Mouse(MouseError),
    NoCalibrationInProgress,
}

impl core::fmt::Display for EngineError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            EngineError::Frame(e) => write!(f, "{e}"),
            EngineError::Calibration(e) => write!(f, "{e}"),
            EngineError::Mouse(e) => write!(f, "{e}"),
            EngineError::NoCalibrationInProgress => write!(f, "no calibration in progress"),
        }
    }
}

pub struct Engine {
    cfg: EngineConfig,
    bounds: Rect,
    model: Option<CalibrationModel>,
    filter: FilterPipeline,
    history: History,
    gestures: GestureDetector,
    arbiter: ClickArbiter,
    mouse: Box<dyn MouseBackend>,

    control_enabled: bool,
    enabled_at_ms: f64,
    last_frame_ms: Option<f64>,
    tracked_since_ms: Option<f64>,
    last_dispatched: Option<(i64, i64)>,
    collector: Option<Collector>,
    /// Gaze-feature scatter from the most recent calibration run, retained for
    /// the debug panel. `finish_calibration` consumes the collector, so without
    /// this the samples would be gone exactly when they become interesting.
    last_scatter: Vec<ScatterPoint>,
    armed_target: Option<usize>,
    fps: f64,
    last_error: Option<String>,
    /// Gaze is yielded to a physical pointing device until this timestamp
    /// (ADR-0016).
    manual_until_ms: Option<f64>,
    /// Latched when `require_manual_resume` is set.
    manual_latched: bool,
}

impl Engine {
    pub fn new(cfg: EngineConfig, bounds: Rect, mouse: Box<dyn MouseBackend>) -> Self {
        Self {
            cfg,
            bounds,
            model: None,
            filter: FilterPipeline::new(),
            history: History::new(),
            gestures: GestureDetector::new(),
            arbiter: ClickArbiter::new(),
            mouse,
            control_enabled: false,
            enabled_at_ms: 0.0,
            last_frame_ms: None,
            tracked_since_ms: None,
            last_dispatched: None,
            collector: None,
            last_scatter: Vec::new(),
            armed_target: None,
            fps: 0.0,
            last_error: None,
            manual_until_ms: None,
            manual_latched: false,
        }
    }

    // ---- configuration -------------------------------------------------

    pub fn config(&self) -> &EngineConfig {
        &self.cfg
    }

    pub fn set_config(&mut self, cfg: EngineConfig) {
        self.cfg = cfg;
    }

    pub fn set_bounds(&mut self, bounds: Rect) {
        self.bounds = bounds;
    }

    pub fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn backend_name(&self) -> &'static str {
        self.mouse.name()
    }

    /// Enabling is deliberately not idempotent-free: it re-stamps the arming
    /// clock so a blink in flight cannot click (ADR-0011).
    pub fn set_control_enabled(&mut self, on: bool, now_ms: f64) {
        if on && !self.control_enabled {
            self.enabled_at_ms = now_ms;
            self.arbiter.reset();
            // Explicitly turning control on is an unambiguous request for gaze
            // control, so it clears any manual override.
            self.resume_from_manual();
        }
        self.control_enabled = on;
        if !on {
            self.last_dispatched = None;
        }
    }

    pub fn control_enabled(&self) -> bool {
        self.control_enabled
    }

    pub fn is_calibrated(&self) -> bool {
        self.model.is_some()
    }

    pub fn calibration(&self) -> Option<&CalibrationModel> {
        self.model.as_ref()
    }

    pub fn load_calibration(&mut self, model: CalibrationModel) {
        self.model = Some(model);
        self.filter.reset();
        self.history.clear();
    }

    pub fn clear_calibration(&mut self) {
        self.model = None;
        self.filter.reset();
        self.history.clear();
        // A cursor driven by an invalid model is worse than no cursor.
        self.control_enabled = false;
    }

    // ---- calibration ---------------------------------------------------

    pub fn begin_calibration(&mut self, targets: Vec<Vec2>) {
        self.collector = Some(Collector::new(targets));
        // Stale scatter from a previous run would be read as belonging to this
        // one, which is worse than showing nothing.
        self.last_scatter.clear();
        self.armed_target = None;
        // Never drive the cursor while the user is fixating calibration dots.
        self.control_enabled = false;
    }

    /// Arm or disarm sample collection. While armed, every pushed frame is
    /// offered to the collector for `target_index`.
    pub fn set_calibration_target(&mut self, target_index: Option<usize>) {
        self.armed_target = target_index;
    }

    pub fn cancel_calibration(&mut self) {
        self.collector = None;
        self.armed_target = None;
    }

    pub fn is_calibrating(&self) -> bool {
        self.collector.is_some()
    }

    pub fn calibration_progress(&self, target_index: usize) -> usize {
        self.collector.as_ref().map_or(0, |c| c.count_for(target_index))
    }

    pub fn finish_calibration(
        &mut self,
        display_fingerprint: impl Into<String>,
    ) -> Result<CalibrationModel, EngineError> {
        let collector = self.collector.take().ok_or(EngineError::NoCalibrationInProgress)?;
        self.armed_target = None;
        // Captured before the fit can fail: a *failed* calibration is precisely
        // when you want to look at what was collected.
        self.last_scatter = collector.scatter();
        let model = collector
            .finish_with(&self.cfg.calibration, self.cfg.px_per_degree, display_fingerprint)
            .map_err(EngineError::Calibration)?;
        self.model = Some(model.clone());
        self.filter.reset();
        self.history.clear();
        Ok(model)
    }

    /// Gaze-feature scatter from the last calibration run (debug panel).
    pub fn calibration_scatter(&self) -> &[ScatterPoint] {
        &self.last_scatter
    }

    /// Run the calibration model on an arbitrary frame without touching any
    /// engine state — no filtering, no cursor, no blink FSM.
    ///
    /// This is what lets the debug panel measure the model's local gain
    /// (screen px per unit of `gx`) by finite differences, instead of
    /// reimplementing `expand()` in TypeScript and letting the two drift.
    pub fn predict_frame(&self, slots: &[f64]) -> Result<Option<Vec2>, EngineError> {
        let frame = GazeFrame::decode(slots).map_err(EngineError::Frame)?;
        Ok(self.model.as_ref().map(|m| m.predict(&frame)))
    }

    // ---- hot path ------------------------------------------------------

    pub fn push_frame(&mut self, slots: &[f64]) -> Result<FrameOutput, EngineError> {
        let frame = GazeFrame::decode(slots).map_err(EngineError::Frame)?;

        // Reject out-of-order frames rather than integrating them. A late frame
        // would corrupt the One Euro speed estimate and could rewind the blink
        // FSM's clock (ADR-0009).
        if let Some(last) = self.last_frame_ms {
            if frame.t_ms <= last {
                let mut out = self.snapshot(Guard::StaleFrame, &frame);
                out.stale = true;
                return Ok(out);
            }
        }

        let gap_ms = self.last_frame_ms.map(|last| frame.t_ms - last);
        if let Some(dt) = gap_ms {
            if dt > 0.0 {
                let instant_fps = 1000.0 / dt;
                self.fps = if self.fps == 0.0 {
                    instant_fps
                } else {
                    self.fps * 0.9 + instant_fps * 0.1
                };
            }
        }
        self.last_frame_ms = Some(frame.t_ms);

        // Tracking continuity, for the settle guard.
        let tracking_ok = frame.ok && frame.quality >= self.cfg.guard.min_quality;
        if tracking_ok {
            if self.tracked_since_ms.is_none() {
                self.tracked_since_ms = Some(frame.t_ms);
            }
        } else {
            self.tracked_since_ms = None;
        }

        // Gesture detection runs unconditionally so the HUD stays live even
        // when control is off.
        let closure = if self.cfg.blink.use_geometric_fallback {
            frame.geometric_closure(self.cfg.blink.rest_open_ratio)
        } else {
            frame.closure()
        };
        let gesture = self.gestures.update(closure, frame.t_ms, &self.cfg.blink);
        // Any eyelid down freezes the cursor — a wink occludes one iris, and
        // that eye still contributes to the averaged gaze signal.
        let blinking = self.gestures.is_closing();

        // A gap longer than the freshness budget means the stream stalled; the
        // filter's speed estimate is meaningless across it.
        let stale_gap = gap_ms.is_some_and(|dt| dt > self.cfg.guard.max_frame_age_ms);
        if stale_gap {
            self.filter.reset();
        }

        // Map and filter. During a blink the eyelid corrupts the estimate, so
        // the pipeline is frozen and simply holds its last output (ADR-0007).
        let mut raw = Vec2::ZERO;
        let mut has_gaze = false;
        if let Some(model) = self.model.as_ref() {
            if frame.ok {
                raw = model.predict(&frame);
                has_gaze = raw.is_finite();
            }
        }

        let smoothed = if has_gaze && !blinking && !stale_gap {
            let saccade_px =
                self.cfg.filter.saccade_px * (self.bounds.diagonal() / NOMINAL_DIAGONAL);
            let clamped_raw = self.bounds.clamp(raw);
            let s = self.filter.update(clamped_raw, frame.t_ms, &self.cfg.filter, saccade_px);
            self.history.push(frame.t_ms, s);
            Some(s)
        } else {
            self.filter.hold()
        };

        // Has a physical mouse or trackpad moved the cursor? Checked *before*
        // this frame's dispatch, so we are comparing against a position the
        // window server has already applied (ADR-0016).
        self.detect_manual_takeover(frame.t_ms);

        // Calibration sampling shares the hot path so the frame is decoded once.
        if let (Some(idx), Some(collector)) = (self.armed_target, self.collector.as_mut()) {
            collector.add(idx, frame, blinking, self.cfg.guard.min_quality);
        }

        let guard = self.evaluate_guard(&frame, blinking, stale_gap, has_gaze);

        // Movement.
        let mut moved = false;
        if guard == Guard::Ok {
            if let Some(s) = smoothed {
                moved = self.dispatch_move(s);
            }
        }

        // Clicks.
        let click_event = self.arbiter.step(gesture, frame.t_ms, &self.cfg.blink);

        let mut click_kind = ClickKind::None;
        let mut click_button = Button::Left;
        let mut click_at = Vec2::ZERO;
        if click_event.kind != ClickKind::None && guard == Guard::Ok {
            // Pre-blink anchoring: click where the user was looking before the
            // eyelid started corrupting the estimate (ADR-0008).
            let anchor_t = click_event.onset_ms - self.cfg.blink.pre_blink_lookback_ms;
            let anchor = self
                .history
                .at_or_before(anchor_t)
                .or(smoothed)
                .or_else(|| self.history.latest());

            if let Some(p) = anchor {
                let target = self.bounds.clamp(p);
                self.dispatch_move(target);
                match self.mouse.click(click_event.button, click_event.kind.count()) {
                    Ok(()) => {
                        click_kind = click_event.kind;
                        click_button = click_event.button;
                        click_at = target;
                    }
                    Err(e) => self.last_error = Some(e.to_string()),
                }
            }
        }

        let mut out = self.snapshot(guard, &frame);
        out.has_gaze = has_gaze;
        if let Some(s) = smoothed {
            out.x = s.x;
            out.y = s.y;
        }
        out.raw_x = raw.x;
        out.raw_y = raw.y;
        out.moved = moved;
        out.click = click_kind.as_u8();
        out.click_button = match click_button {
            Button::Left => 0,
            Button::Right => 1,
            Button::Middle => 2,
        };
        out.click_x = click_at.x;
        out.click_y = click_at.y;
        out.closure = closure.both();
        out.closure_left = closure.left;
        out.closure_right = closure.right;
        out.pose_drift = self.model.as_ref().map_or(0.0, |m| m.pose_drift(&frame));
        out.manual_override = self.manual_override_active(frame.t_ms);
        Ok(out)
    }

    /// Notice when something other than us moved the cursor.
    ///
    /// We know exactly where we last commanded the pointer. If the OS reports
    /// it somewhere else, a physical device moved it — no event tap and no
    /// extra permission required.
    fn detect_manual_takeover(&mut self, t_ms: f64) {
        if !self.cfg.takeover.enabled {
            return;
        }
        // Nothing to compare against until we have driven the cursor at least
        // once, and no point checking when we are not driving it.
        let Some((lx, ly)) = self.last_dispatched else { return };
        if !self.control_enabled {
            return;
        }

        let Ok((ax, ay)) = self.mouse.cursor_position() else { return };
        let drift = Vec2::new(ax, ay).distance_to(Vec2::new(lx as f64, ly as f64));
        if drift <= self.cfg.takeover.epsilon_px {
            return;
        }

        self.manual_until_ms = Some(t_ms + self.cfg.takeover.resume_after_ms);
        if self.cfg.takeover.require_manual_resume {
            self.manual_latched = true;
        }
        // Forget our commanded position: the user's is now the truth, and
        // keeping ours would re-trigger detection on every subsequent frame.
        self.last_dispatched = None;
        // Drop filter state so gaze does not glide from a stale position when
        // it resumes.
        self.filter.reset();
    }

    /// True while gaze has yielded to a physical pointing device.
    pub fn manual_override_active(&self, t_ms: f64) -> bool {
        if self.manual_latched {
            return true;
        }
        self.manual_until_ms.is_some_and(|until| t_ms < until)
    }

    /// Clear a latched manual override, resuming gaze control.
    pub fn resume_from_manual(&mut self) {
        self.manual_latched = false;
        self.manual_until_ms = None;
    }

    fn dispatch_move(&mut self, p: Vec2) -> bool {
        let target = self.bounds.clamp(p);
        let key = (target.x.round() as i64, target.y.round() as i64);
        // Suppress no-op moves so a fixation does not flood the window server.
        if self.last_dispatched == Some(key) {
            return false;
        }
        match self.mouse.move_to(key.0 as f64, key.1 as f64) {
            Ok(()) => {
                self.last_dispatched = Some(key);
                true
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    /// Ordered most-fundamental-first, so the reason surfaced to the user is
    /// the one they can act on.
    fn evaluate_guard(
        &self,
        frame: &GazeFrame,
        blinking: bool,
        stale_gap: bool,
        has_gaze: bool,
    ) -> Guard {
        if self.collector.is_some() {
            return Guard::Calibrating;
        }
        if !self.control_enabled {
            return Guard::ControlDisabled;
        }
        if self.model.is_none() {
            return Guard::NoCalibration;
        }
        // Checked early and above tracking quality: if the user has taken the
        // trackpad, why gaze *also* is not driving the cursor is irrelevant.
        if self.manual_override_active(frame.t_ms) {
            return Guard::ManualOverride;
        }
        if !frame.ok || !has_gaze {
            return Guard::NoFace;
        }
        if frame.quality < self.cfg.guard.min_quality {
            return Guard::LowQuality;
        }
        if stale_gap {
            return Guard::StaleFrame;
        }
        if blinking {
            return Guard::Blinking;
        }
        if frame.t_ms - self.enabled_at_ms < self.cfg.guard.arming_ms {
            return Guard::Arming;
        }
        match self.tracked_since_ms {
            Some(since) if frame.t_ms - since >= self.cfg.guard.track_settle_ms => Guard::Ok,
            _ => Guard::Settling,
        }
    }

    fn snapshot(&self, guard: Guard, frame: &GazeFrame) -> FrameOutput {
        FrameOutput {
            quality: frame.quality,
            guard: guard.as_u8(),
            guard_reason: guard.as_str().to_string(),
            control_enabled: self.control_enabled,
            calibrated: self.model.is_some(),
            clamped: self.filter.is_clamped(),
            saccade: self.filter.was_saccade(),
            blink_phase: self.gestures.phase().as_u8(),
            head_compensated: self.model.as_ref().is_some_and(|m| m.has_head_compensation()),
            clamp_radius: self.filter.effective_clamp_radius(),
            gaze_spread: self.filter.measured_spread().unwrap_or(0.0),
            fps: self.fps,
            calibrating: self.collector.is_some(),
            calibration_samples: self
                .collector
                .as_ref()
                .map_or(0, |c| c.accepted_count() as u32),
            error: self.last_error.clone(),
            x: self.filter.hold().map_or(0.0, |p| p.x),
            y: self.filter.hold().map_or(0.0, |p| p.y),
            ..Default::default()
        }
    }

    pub fn take_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    pub fn blink_phase(&self) -> BlinkPhase {
        self.gestures.phase()
    }

    /// Explicit sample submission, for callers that drive calibration outside
    /// the frame loop.
    pub fn add_calibration_sample(
        &mut self,
        target_index: usize,
        slots: &[f64],
    ) -> Result<SampleRejection, EngineError> {
        let frame = GazeFrame::decode(slots).map_err(EngineError::Frame)?;
        let blinking = self.gestures.is_closing();
        let min_quality = self.cfg.guard.min_quality;
        let collector = self.collector.as_mut().ok_or(EngineError::NoCalibrationInProgress)?;
        Ok(collector.add(target_index, frame, blinking, min_quality))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::target_grid;
    use crate::config::{BlinkConfig, ClickMode, EngineConfig, TakeoverConfig};
    use crate::frame::{slot, FRAME_WIDTH};
    use crate::mouse::null::{MouseLog, NullMouse};

    const BOUNDS: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };

    fn engine() -> (Engine, MouseLog) {
        let (mouse, log) = NullMouse::new();
        (Engine::new(EngineConfig::default(), BOUNDS, Box::new(mouse)), log)
    }

    /// Pack a frame the way the renderer would, with both eyes equal.
    fn pack(t_ms: f64, gx: f64, gy: f64, closure: f64) -> Vec<f64> {
        pack_eyes(t_ms, gx, gy, closure, closure)
    }

    /// Pack with independent per-eye closure, for wink tests.
    fn pack_eyes(t_ms: f64, gx: f64, gy: f64, left: f64, right: f64) -> Vec<f64> {
        let mut v = vec![0.0; FRAME_WIDTH];
        v[slot::TIMESTAMP] = t_ms;
        v[slot::OK] = 1.0;
        v[slot::QUALITY] = 1.0;
        v[slot::GX] = gx;
        v[slot::GY] = gy;
        v[slot::BLINK_LEFT] = left;
        v[slot::BLINK_RIGHT] = right;
        v
    }

    /// A linear-ish synthetic gaze→screen relationship for tests.
    fn gaze_for(p: Vec2) -> (f64, f64) {
        ((p.x - 960.0) / 3000.0, (p.y - 540.0) / 2400.0)
    }

    /// Run a full 9-point calibration against the synthetic relationship.
    fn calibrate(e: &mut Engine) {
        let targets = target_grid(&BOUNDS, 9);
        e.begin_calibration(targets.clone());
        let mut t = 0.0;
        for (i, target) in targets.iter().enumerate() {
            e.set_calibration_target(Some(i));
            let (gx, gy) = gaze_for(*target);
            for k in 0..25 {
                let j = (k as f64 % 5.0 - 2.0) * 0.0006;
                e.push_frame(&pack(t, gx + j, gy - j, 0.0)).unwrap();
                t += 16.7;
            }
        }
        e.set_calibration_target(None);
        e.finish_calibration("test-display").expect("calibration should fit");
    }

    /// Feed steady frames at 60 Hz.
    fn feed(e: &mut Engine, t0: f64, n: usize, gx: f64, gy: f64, closure: f64) -> f64 {
        feed_out(e, t0, n, gx, gy, closure).0
    }

    /// Same, but keeps every frame's output so a test can inspect click events.
    fn feed_out(
        e: &mut Engine,
        t0: f64,
        n: usize,
        gx: f64,
        gy: f64,
        closure: f64,
    ) -> (f64, Vec<FrameOutput>) {
        let mut t = t0;
        let mut outs = Vec::with_capacity(n);
        for _ in 0..n {
            outs.push(e.push_frame(&pack(t, gx, gy, closure)).unwrap());
            t += 16.7;
        }
        (t, outs)
    }

    fn clicks_in(outs: &[FrameOutput]) -> Vec<&FrameOutput> {
        outs.iter().filter(|o| o.click != 0).collect()
    }

    #[test]
    fn rejects_a_malformed_frame() {
        let (mut e, _) = engine();
        assert!(matches!(e.push_frame(&[0.0; 4]), Err(EngineError::Frame(_))));
    }

    #[test]
    fn does_not_move_the_cursor_before_calibration() {
        let (mut e, log) = engine();
        e.set_control_enabled(true, 0.0);
        feed(&mut e, 0.0, 60, 0.1, 0.1, 0.0);
        assert!(log.is_empty(), "moved without a calibration");
    }

    #[test]
    fn does_not_move_the_cursor_while_control_is_disabled() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        log.clear();
        feed(&mut e, 10_000.0, 60, 0.1, 0.1, 0.0);
        assert!(log.is_empty(), "moved while disabled");
        assert!(!e.control_enabled());
    }

    #[test]
    fn moves_the_cursor_after_calibration_when_enabled() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        log.clear();

        let target = Vec2::new(1400.0, 800.0);
        let (gx, gy) = gaze_for(target);
        feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        let moves = log.moves();
        assert!(!moves.is_empty(), "cursor never moved");
        let (lx, ly) = *moves.last().unwrap();
        assert!(
            (lx - target.x).abs() < 60.0 && (ly - target.y).abs() < 60.0,
            "cursor at ({lx}, {ly}), expected near {target:?}"
        );
    }

    #[test]
    fn guard_reports_the_specific_blocking_reason() {
        let (mut e, _) = engine();
        let out = e.push_frame(&pack(0.0, 0.0, 0.0, 0.0)).unwrap();
        assert_eq!(out.guard, Guard::ControlDisabled.as_u8());

        e.set_control_enabled(true, 100.0);
        let out = e.push_frame(&pack(100.0, 0.0, 0.0, 0.0)).unwrap();
        assert_eq!(out.guard, Guard::NoCalibration.as_u8(), "{}", out.guard_reason);
    }

    #[test]
    fn no_face_suspends_movement_instead_of_extrapolating() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let t = feed(&mut e, 10_000.0, 60, 0.05, 0.05, 0.0);
        log.clear();

        let mut v = pack(t, 0.05, 0.05, 0.0);
        v[slot::OK] = 0.0;
        let out = e.push_frame(&v).unwrap();
        assert_eq!(out.guard, Guard::NoFace.as_u8());
        assert!(log.is_empty(), "moved with no face present");
    }

    #[test]
    fn out_of_order_frames_are_dropped() {
        let (mut e, _) = engine();
        e.push_frame(&pack(1000.0, 0.0, 0.0, 0.0)).unwrap();
        let out = e.push_frame(&pack(900.0, 0.0, 0.0, 0.0)).unwrap();
        assert!(out.stale, "late frame was not rejected");
    }

    #[test]
    fn repeated_identical_positions_do_not_flood_the_backend() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        log.clear();
        feed(&mut e, 10_000.0, 200, 0.05, 0.05, 0.0);
        // 200 frames at a fixed gaze must not produce 200 moves.
        assert!(log.moves().len() < 40, "no-op moves not suppressed: {}", log.moves().len());
    }

    #[test]
    fn deliberate_blink_produces_a_single_click() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 60, gx, gy, 0.0);
        log.clear();

        t = feed(&mut e, t, 15, gx, gy, 0.9); // ~250 ms closure
        t = feed(&mut e, t, 60, gx, gy, 0.0); // past the double-click window

        let clicks = log.clicks();
        assert_eq!(clicks.len(), 1, "expected one click, got {clicks:?}");
        assert_eq!(clicks[0], (Button::Left, 1));
        let _ = t;
    }

    #[test]
    fn natural_short_blink_does_not_click() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 60, gx, gy, 0.0);
        log.clear();

        t = feed(&mut e, t, 6, gx, gy, 0.9); // ~100 ms — involuntary
        feed(&mut e, t, 60, gx, gy, 0.0);

        assert!(log.clicks().is_empty(), "involuntary blink clicked: {:?}", log.clicks());
    }

    #[test]
    fn double_blink_produces_a_real_double_click() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 60, gx, gy, 0.0);
        log.clear();

        t = feed(&mut e, t, 15, gx, gy, 0.9); // blink 1
        t = feed(&mut e, t, 10, gx, gy, 0.0); // ~170 ms gap
        t = feed(&mut e, t, 15, gx, gy, 0.9); // blink 2
        feed(&mut e, t, 60, gx, gy, 0.0);

        let clicks = log.clicks();
        assert_eq!(clicks.len(), 1, "expected exactly one click event, got {clicks:?}");
        // count = 2 is what makes this a real double-click rather than two
        // singles (ADR-0010).
        assert_eq!(clicks[0], (Button::Left, 2));
    }

    /// The regression ADR-0007/0008 exist to prevent: the eyelid drags the gaze
    /// estimate downward during a blink, so a click must not land there.
    #[test]
    fn click_lands_at_the_pre_blink_position_not_the_corrupted_one() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);

        let target = Vec2::new(1000.0, 600.0);
        let (gx, gy) = gaze_for(target);
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);
        log.clear();

        // During closure the estimate slides far down the screen.
        let (bad_gx, bad_gy) = gaze_for(Vec2::new(1000.0, 1050.0));
        let (t2, during) = feed_out(&mut e, t, 15, bad_gx, bad_gy, 0.9);
        t = t2;
        let (_, after) = feed_out(&mut e, t, 60, gx, gy, 0.0);

        let mut all = during;
        all.extend(after);
        let clicks = clicks_in(&all);
        assert_eq!(clicks.len(), 1, "expected one click, got {}", clicks.len());

        // The engine reports where it clicked. Note we assert on this rather
        // than on a preceding Move call: when the cursor is already at the
        // anchor (because the filter froze during the blink), the redundant
        // move is correctly suppressed and never reaches the backend.
        let c = clicks[0];
        assert!(
            (c.click_y - target.y).abs() < 60.0,
            "click landed at y={}, expected near {} (blink corruption leaked through)",
            c.click_y,
            target.y
        );
        assert!(
            (c.click_x - target.x).abs() < 60.0,
            "click x={} expected near {}",
            c.click_x,
            target.x
        );
        assert_eq!(log.clicks().len(), 1, "backend should have received exactly one click");
    }

    #[test]
    fn cursor_does_not_move_during_a_blink() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let target = Vec2::new(1000.0, 600.0);
        let (gx, gy) = gaze_for(target);
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);
        log.clear();

        let (bad_gx, bad_gy) = gaze_for(Vec2::new(200.0, 1050.0));
        t = feed(&mut e, t, 12, bad_gx, bad_gy, 0.9);
        let _ = t;

        // Any moves during the closure must not have chased the corrupted point.
        for (x, y) in log.moves() {
            assert!(
                (y - target.y).abs() < 80.0 && (x - target.x).abs() < 80.0,
                "cursor chased blink-corrupted gaze to ({x}, {y})"
            );
        }
    }

    #[test]
    fn arming_delay_prevents_an_immediate_click_on_enable() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 60, gx, gy, 0.0);

        // Enable, then blink immediately.
        e.set_control_enabled(true, t);
        log.clear();
        t = feed(&mut e, t, 15, gx, gy, 0.9);
        feed(&mut e, t, 20, gx, gy, 0.0);

        assert!(log.clicks().is_empty(), "clicked during the arming window");
    }

    #[test]
    fn disabling_control_stops_movement_immediately() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let t = feed(&mut e, 10_000.0, 90, 0.05, 0.05, 0.0);

        e.set_control_enabled(false, t);
        log.clear();
        feed(&mut e, t, 60, 0.2, -0.2, 0.0);
        assert!(log.is_empty(), "kept moving after disable");
    }

    #[test]
    fn clears_calibration_and_disables_control() {
        let (mut e, _) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        e.clear_calibration();
        assert!(!e.is_calibrated());
        assert!(!e.control_enabled(), "control must not survive calibration loss");
    }

    #[test]
    fn cursor_is_clamped_to_display_bounds() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        log.clear();
        // Gaze far outside anything seen during calibration.
        feed(&mut e, 10_000.0, 90, 2.0, 2.0, 0.0);
        for (x, y) in log.moves() {
            assert!((0.0..=1919.0).contains(&x), "x={x} outside bounds");
            assert!((0.0..=1079.0).contains(&y), "y={y} outside bounds");
        }
    }

    // ---- wink mode (ADR-0013) ----

    fn wink_engine() -> (Engine, MouseLog) {
        let (mouse, log) = NullMouse::new();
        let cfg = EngineConfig {
            blink: BlinkConfig { mode: ClickMode::Wink, ..Default::default() },
            ..Default::default()
        };
        (Engine::new(cfg, BOUNDS, Box::new(mouse)), log)
    }

    fn feed_eyes(
        e: &mut Engine,
        t0: f64,
        n: usize,
        gx: f64,
        gy: f64,
        left: f64,
        right: f64,
    ) -> f64 {
        let mut t = t0;
        for _ in 0..n {
            e.push_frame(&pack_eyes(t, gx, gy, left, right)).unwrap();
            t += 16.7;
        }
        t
    }

    #[test]
    fn left_wink_produces_a_left_click() {
        let (mut e, log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);
        log.clear();

        t = feed_eyes(&mut e, t, 15, gx, gy, 0.9, 0.0);
        feed_eyes(&mut e, t, 60, gx, gy, 0.0, 0.0);

        assert_eq!(log.clicks(), vec![(Button::Left, 1)]);
    }

    #[test]
    fn right_wink_produces_a_right_click() {
        let (mut e, log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);
        log.clear();

        t = feed_eyes(&mut e, t, 15, gx, gy, 0.0, 0.9);
        feed_eyes(&mut e, t, 20, gx, gy, 0.0, 0.0);

        assert_eq!(log.clicks(), vec![(Button::Right, 1)]);
    }

    #[test]
    fn double_left_wink_produces_a_double_click() {
        let (mut e, log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);
        log.clear();

        t = feed_eyes(&mut e, t, 12, gx, gy, 0.9, 0.0);
        t = feed_eyes(&mut e, t, 10, gx, gy, 0.0, 0.0);
        t = feed_eyes(&mut e, t, 12, gx, gy, 0.9, 0.0);
        feed_eyes(&mut e, t, 60, gx, gy, 0.0, 0.0);

        assert_eq!(log.clicks(), vec![(Button::Left, 2)]);
    }

    /// The reason wink mode exists: involuntary two-eye blinks cannot click at
    /// all, rather than being filtered out by a duration threshold.
    #[test]
    fn natural_blinks_never_click_in_wink_mode() {
        let (mut e, log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);
        log.clear();

        for _ in 0..6 {
            t = feed_eyes(&mut e, t, 9, gx, gy, 0.92, 0.90); // natural blink
            t = feed_eyes(&mut e, t, 24, gx, gy, 0.0, 0.0);
        }
        // Even a long deliberate two-eye blink does nothing here.
        t = feed_eyes(&mut e, t, 18, gx, gy, 0.95, 0.95);
        feed_eyes(&mut e, t, 40, gx, gy, 0.0, 0.0);

        assert!(log.clicks().is_empty(), "blinks clicked in wink mode: {:?}", log.clicks());
    }

    #[test]
    fn wink_click_lands_at_the_pre_wink_position() {
        let (mut e, log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);

        let target = Vec2::new(1000.0, 600.0);
        let (gx, gy) = gaze_for(target);
        let mut t = feed_eyes(&mut e, 10_000.0, 90, gx, gy, 0.0, 0.0);
        log.clear();

        // The occluded eye drags the averaged gaze estimate downward.
        let (bad_gx, bad_gy) = gaze_for(Vec2::new(1000.0, 1050.0));
        let (t2, during) = {
            let mut outs = Vec::new();
            let mut tt = t;
            for _ in 0..15 {
                outs.push(e.push_frame(&pack_eyes(tt, bad_gx, bad_gy, 0.9, 0.0)).unwrap());
                tt += 16.7;
            }
            (tt, outs)
        };
        t = t2;
        let (_, after) = feed_out(&mut e, t, 60, gx, gy, 0.0);

        let mut all = during;
        all.extend(after);
        let clicks = clicks_in(&all);
        assert_eq!(clicks.len(), 1);
        assert!(
            (clicks[0].click_y - target.y).abs() < 60.0,
            "wink click landed at y={}, expected near {}",
            clicks[0].click_y,
            target.y
        );
    }

    #[test]
    fn blink_mode_ignores_winks() {
        let (mut e, log) = engine(); // default = blink mode
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);
        log.clear();

        t = feed_eyes(&mut e, t, 20, gx, gy, 0.95, 0.0);
        feed_eyes(&mut e, t, 60, gx, gy, 0.0, 0.0);
        assert!(log.clicks().is_empty(), "wink clicked in blink mode");
    }

    #[test]
    fn output_reports_which_button_was_clicked() {
        let (mut e, _log) = wink_engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed_eyes(&mut e, 10_000.0, 60, gx, gy, 0.0, 0.0);

        let mut outs = Vec::new();
        for _ in 0..15 {
            outs.push(e.push_frame(&pack_eyes(t, gx, gy, 0.0, 0.9)).unwrap());
            t += 16.7;
        }
        for _ in 0..20 {
            outs.push(e.push_frame(&pack_eyes(t, gx, gy, 0.0, 0.0)).unwrap());
            t += 16.7;
        }
        let clicks = clicks_in(&outs);
        assert_eq!(clicks.len(), 1);
        assert_eq!(clicks[0].click_button, 1, "right click should report button 1");
    }

    // ---- manual takeover (ADR-0016) ----

    #[test]
    fn touching_the_trackpad_suspends_gaze_control() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);
        assert!(!log.moves().is_empty(), "gaze was not driving the cursor to begin with");

        // The user grabs the trackpad and moves the cursor somewhere we did not
        // put it.
        log.simulate_physical_move(200.0, 200.0);
        log.clear();

        let (gx2, gy2) = gaze_for(Vec2::new(1500.0, 900.0));
        let out = e.push_frame(&pack(t, gx2, gy2, 0.0)).unwrap();
        t += 16.7;
        assert_eq!(out.guard, Guard::ManualOverride.as_u8(), "{}", out.guard_reason);
        assert!(out.manual_override);

        // And it must stay yielded while they keep working.
        feed(&mut e, t, 30, gx2, gy2, 0.0);
        assert!(log.is_empty(), "gaze fought the user for the cursor: {:?}", log.moves());
    }

    #[test]
    fn no_clicks_while_yielded_to_the_trackpad() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        log.simulate_physical_move(200.0, 200.0);
        log.clear();

        t = feed(&mut e, t, 15, gx, gy, 0.9); // a deliberate blink
        feed(&mut e, t, 30, gx, gy, 0.0);
        assert!(log.clicks().is_empty(), "clicked while yielded: {:?}", log.clicks());
    }

    #[test]
    fn gaze_resumes_after_the_user_stops_moving_the_mouse() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        log.simulate_physical_move(200.0, 200.0);
        // Default resume_after_ms is 1500; wait it out with no further physical
        // movement.
        t = feed(&mut e, t, 120, gx, gy, 0.0);
        log.clear();

        // Look somewhere new. A *constant* gaze would produce no moves here even
        // on success, because redundant dispatches are correctly suppressed.
        let (gx2, gy2) = gaze_for(Vec2::new(1500.0, 900.0));
        let (_, outs) = feed_out(&mut e, t, 60, gx2, gy2, 0.0);

        assert!(!outs.last().unwrap().manual_override, "still yielded after the quiet period");
        assert!(!log.moves().is_empty(), "gaze did not resume driving the cursor");
    }

    #[test]
    fn tiny_cursor_discrepancies_do_not_trigger_takeover() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        // A couple of pixels — rounding, not a human.
        let (cx, cy) = log.position();
        log.simulate_physical_move(cx + 3.0, cy + 2.0);

        let out = e.push_frame(&pack(t, gx, gy, 0.0)).unwrap();
        assert!(!out.manual_override, "rounding was mistaken for physical input");
    }

    #[test]
    fn takeover_can_be_disabled() {
        let (mouse, log) = NullMouse::new();
        let cfg = EngineConfig {
            takeover: TakeoverConfig { enabled: false, ..Default::default() },
            ..Default::default()
        };
        let mut e = Engine::new(cfg, BOUNDS, Box::new(mouse));
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        log.simulate_physical_move(200.0, 200.0);
        let out = e.push_frame(&pack(t, gx, gy, 0.0)).unwrap();
        assert!(!out.manual_override);
    }

    #[test]
    fn latched_mode_requires_explicit_resume() {
        let (mouse, log) = NullMouse::new();
        let cfg = EngineConfig {
            takeover: TakeoverConfig { require_manual_resume: true, ..Default::default() },
            ..Default::default()
        };
        let mut e = Engine::new(cfg, BOUNDS, Box::new(mouse));
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let mut t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        log.simulate_physical_move(200.0, 200.0);
        t = feed(&mut e, t, 200, gx, gy, 0.0); // long past resume_after_ms

        let out = e.push_frame(&pack(t, gx, gy, 0.0)).unwrap();
        assert!(out.manual_override, "latched override resumed on its own");

        e.resume_from_manual();
        let out = e.push_frame(&pack(t + 16.7, gx, gy, 0.0)).unwrap();
        assert!(!out.manual_override);
    }

    /// Re-enabling control is an unambiguous request for gaze, so it should
    /// clear a takeover rather than leaving the user wondering why nothing
    /// happens.
    #[test]
    fn re_enabling_control_clears_a_takeover() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let (gx, gy) = gaze_for(Vec2::new(1000.0, 600.0));
        let t = feed(&mut e, 10_000.0, 90, gx, gy, 0.0);

        log.simulate_physical_move(200.0, 200.0);
        e.push_frame(&pack(t, gx, gy, 0.0)).unwrap();

        e.set_control_enabled(false, t);
        e.set_control_enabled(true, t + 16.7);
        let out = e.push_frame(&pack(t + 33.4, gx, gy, 0.0)).unwrap();
        assert!(!out.manual_override);
    }

    // ---- head pose drift (ADR-0015) ----

    #[test]
    fn reports_low_drift_at_the_calibration_pose() {
        let (mut e, _) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let out = e.push_frame(&pack(11_000.0, 0.05, 0.05, 0.0)).unwrap();
        assert!(out.pose_drift < 3.0, "drift {} at calibration pose", out.pose_drift);
    }

    #[test]
    fn reports_high_drift_after_a_large_head_turn() {
        let (mut e, _) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);

        let mut v = pack(11_000.0, 0.05, 0.05, 0.0);
        v[slot::YAW] = 0.6; // ~34° turn, far outside a still calibration
        let out = e.push_frame(&v).unwrap();
        assert!(out.pose_drift > 3.0, "drift {} should flag extrapolation", out.pose_drift);
    }

    /// Calibrating while holding still means the fit contains no head
    /// compensation — the user needs to be told that, not left guessing.
    #[test]
    fn flags_a_calibration_with_no_head_compensation() {
        let (mut e, _) = engine();
        calibrate(&mut e); // synthetic samples hold pose constant
        let out = e.push_frame(&pack(11_000.0, 0.0, 0.0, 0.0)).unwrap();
        assert!(!out.head_compensated, "still calibration should not claim head compensation");
    }

    #[test]
    fn head_motion_during_calibration_enables_compensation() {
        let (mut e, _) = engine();
        let targets = target_grid(&BOUNDS, 9);
        e.begin_calibration(targets.clone());
        let mut t = 0.0;
        for (i, target) in targets.iter().enumerate() {
            e.set_calibration_target(Some(i));
            let (gx, gy) = gaze_for(*target);
            for k in 0..25 {
                // Vary head pose across the collection, as the head-motion
                // calibration phase asks the user to do.
                let yaw = ((k as f64 / 25.0) - 0.5) * 0.4;
                let mut v = pack(t, gx, gy, 0.0);
                v[slot::YAW] = yaw;
                v[slot::HX] = yaw * 0.1;
                e.push_frame(&v).unwrap();
                t += 16.7;
            }
        }
        e.set_calibration_target(None);
        e.finish_calibration("test-display").unwrap();

        let out = e.push_frame(&pack(t + 100.0, 0.0, 0.0, 0.0)).unwrap();
        assert!(out.head_compensated, "head-motion calibration should enable compensation");
    }

    /// The scatter has to outlive the collector, because the debug panel only
    /// asks for it *after* the fit has finished.
    #[test]
    fn scatter_survives_finish_calibration() {
        let (mut e, _) = engine();
        assert!(e.calibration_scatter().is_empty(), "nothing collected yet");
        calibrate(&mut e);

        let scatter = e.calibration_scatter();
        assert!(!scatter.is_empty(), "scatter must persist past finish_calibration");
        assert_eq!(scatter.iter().map(|p| p.target_index).max(), Some(8));
        assert!(scatter.iter().all(|p| p.gx.is_finite() && p.gy.is_finite()));
    }

    #[test]
    fn begin_calibration_clears_the_previous_scatter() {
        let (mut e, _) = engine();
        calibrate(&mut e);
        assert!(!e.calibration_scatter().is_empty());
        e.begin_calibration(target_grid(&BOUNDS, 9));
        assert!(e.calibration_scatter().is_empty(), "stale scatter would be read as current");
    }

    /// `predict_frame` must agree with what the hot path maps, but without
    /// disturbing the filter, the blink FSM, or the cursor.
    #[test]
    fn predict_frame_is_stateless_and_matches_the_model() {
        let (mut e, log) = engine();
        assert!(e.predict_frame(&pack(0.0, 0.0, 0.0, 0.0)).unwrap().is_none(), "no model yet");

        calibrate(&mut e);
        let v = pack(11_000.0, 0.06, -0.04, 0.0);
        let want = e.calibration().unwrap().predict(&GazeFrame::decode(&v).unwrap());

        let before = log.calls().len();
        let got = e.predict_frame(&v).unwrap().expect("calibrated");
        assert!(got.distance_to(want) < 1e-9);
        assert_eq!(log.calls().len(), before, "predict_frame must not touch the mouse");
    }

    #[test]
    fn calibration_reports_accuracy() {
        let (mut e, _) = engine();
        calibrate(&mut e);
        let report = &e.calibration().unwrap().report;
        assert_eq!(report.targets, 9);
        assert!(report.cross_validated);
        assert!(report.mean_error_px.is_finite());
        assert!(report.mean_error_deg > 0.0);
    }

    #[test]
    fn no_movement_while_calibrating() {
        let (mut e, log) = engine();
        let targets = target_grid(&BOUNDS, 9);
        e.begin_calibration(targets);
        log.clear();
        feed(&mut e, 0.0, 60, 0.1, 0.1, 0.0);
        assert!(log.is_empty(), "moved the cursor during calibration");
    }

    #[test]
    fn large_frame_gap_suspends_movement() {
        let (mut e, log) = engine();
        calibrate(&mut e);
        e.set_control_enabled(true, 10_000.0);
        let t = feed(&mut e, 10_000.0, 90, 0.05, 0.05, 0.0);
        log.clear();

        // A 1 s gap — well past max_frame_age_ms.
        let out = e.push_frame(&pack(t + 1000.0, 0.2, 0.2, 0.0)).unwrap();
        assert_eq!(out.guard, Guard::StaleFrame.as_u8(), "{}", out.guard_reason);
        assert!(log.is_empty());
    }
}
