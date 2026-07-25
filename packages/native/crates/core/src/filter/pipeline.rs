//! The smoothing pipeline (ADR-0007, ADR-0014):
//! median → One Euro → saccade gate → adaptive fixation clamp.

use super::median::{MedianFilter, SpreadEstimator};
use super::one_euro::OneEuro;
use crate::config::FilterConfig;
use crate::math::Vec2;

/// Freezes the output once gaze has settled, so sub-pixel jitter does not make
/// small targets hard to click.
#[derive(Debug, Clone, Default)]
struct FixationClamp {
    /// Where the candidate fixation started, and when.
    anchor: Option<Vec2>,
    entered_ms: f64,
    /// Once engaged: the frozen output and when it engaged.
    held: Option<(Vec2, f64)>,
    /// Radius actually in use, after adaptation.
    effective_radius: f64,
}

impl FixationClamp {
    fn apply(&mut self, p: Vec2, t_ms: f64, cfg: &FilterConfig, radius: f64) -> Vec2 {
        self.effective_radius = radius;

        if let Some((held_pos, since)) = self.held {
            let escaped = p.distance_to(held_pos) > radius;
            // The hard timeout exists because a stuck cursor reads to the user
            // as a crashed app (risk R10).
            let timed_out = t_ms - since > cfg.clamp_max_hold_ms;
            if escaped || timed_out {
                self.held = None;
                self.anchor = Some(p);
                self.entered_ms = t_ms;
                return p;
            }
            return held_pos;
        }

        match self.anchor {
            Some(a) if p.distance_to(a) <= radius => {
                if t_ms - self.entered_ms >= cfg.clamp_ms {
                    // Engage at the *current* position, not the anchor, so
                    // clamping never produces a visible jump.
                    self.held = Some((p, t_ms));
                }
                p
            }
            _ => {
                self.anchor = Some(p);
                self.entered_ms = t_ms;
                p
            }
        }
    }

    fn reset(&mut self) {
        let radius = self.effective_radius;
        *self = Self::default();
        self.effective_radius = radius;
    }

    fn is_held(&self) -> bool {
        self.held.is_some()
    }
}

#[derive(Debug, Clone, Default)]
pub struct FilterPipeline {
    mx: MedianFilter,
    my: MedianFilter,
    fx: OneEuro,
    fy: OneEuro,
    spread_x: SpreadEstimator,
    spread_y: SpreadEstimator,
    clamp: FixationClamp,
    last: Option<Vec2>,
    last_saccade: bool,
}

impl FilterPipeline {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one raw mapped point. `saccade_px` is already scaled to the display.
    pub fn update(&mut self, raw: Vec2, t_ms: f64, cfg: &FilterConfig, saccade_px: f64) -> Vec2 {
        let window = cfg.median_window as usize;
        self.mx.set_window(window);
        self.my.set_window(window);

        // Stage 1: median. Removes isolated landmark spikes before they can be
        // averaged into the exponential filter's state.
        let med = Vec2::new(self.mx.push(raw.x), self.my.push(raw.y));

        // Stage 2: saccade gate. A jump large enough to be a real eye movement
        // re-seeds everything so the cursor teleports rather than glides.
        let saccade = match self.last {
            Some(prev) => med.distance_to(prev) > saccade_px,
            None => false,
        };
        if saccade {
            self.fx.reset_at(med.x, t_ms);
            self.fy.reset_at(med.y, t_ms);
            self.clamp.reset();
            self.spread_x.reset();
            self.spread_y.reset();
        }
        self.last_saccade = saccade;

        // Stage 3: One Euro.
        let sx = self.fx.filter(med.x, t_ms, cfg.min_cutoff, cfg.beta, cfg.d_cutoff);
        let sy = self.fy.filter(med.y, t_ms, cfg.min_cutoff, cfg.beta, cfg.d_cutoff);
        let smoothed = Vec2::new(sx, sy);

        // Track how much the *pre-smoothing* signal is spreading; that is the
        // user's real noise level, and the smoothed signal would understate it.
        self.spread_x.push(med.x);
        self.spread_y.push(med.y);

        // Stage 4: fixation clamp, sized to measured noise.
        let radius = self.clamp_radius(cfg);
        let out = self.clamp.apply(smoothed, t_ms, cfg, radius);
        self.last = Some(out);
        out
    }

    /// A constant radius is wrong for everyone: too small for a noisy camera
    /// (the clamp never engages and the cursor never rests) and too large for a
    /// good one (precision is thrown away). Size it to the measured spread.
    fn clamp_radius(&self, cfg: &FilterConfig) -> f64 {
        if !cfg.adaptive_clamp {
            return cfg.clamp_radius;
        }
        let mad = match (self.spread_x.spread(), self.spread_y.spread()) {
            (Some(a), Some(b)) => a.max(b),
            _ => return cfg.clamp_radius,
        };
        (cfg.clamp_noise_scale * mad)
            .max(cfg.clamp_radius)
            .min(cfg.clamp_radius_max)
    }

    /// Last emitted position. Used while the pipeline is frozen during a blink.
    pub fn hold(&self) -> Option<Vec2> {
        self.last
    }

    pub fn is_clamped(&self) -> bool {
        self.clamp.is_held()
    }

    pub fn was_saccade(&self) -> bool {
        self.last_saccade
    }

    /// Radius currently in use, for the HUD.
    pub fn effective_clamp_radius(&self) -> f64 {
        self.clamp.effective_radius
    }

    /// Measured gaze spread in px, for the HUD. Tells the user whether jitter
    /// is a tracking problem or a filtering problem.
    pub fn measured_spread(&self) -> Option<f64> {
        match (self.spread_x.spread(), self.spread_y.spread()) {
            (Some(a), Some(b)) => Some(a.max(b)),
            _ => None,
        }
    }

    pub fn reset(&mut self) {
        self.mx.reset();
        self.my.reset();
        self.fx.reset();
        self.fy.reset();
        self.spread_x.reset();
        self.spread_y.reset();
        self.clamp.reset();
        self.last = None;
        self.last_saccade = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> FilterConfig {
        FilterConfig::default()
    }

    /// Feed a constant point for `n` frames at 60 Hz starting at `t0`.
    fn settle(p: &mut FilterPipeline, at: Vec2, t0: f64, n: usize) -> (Vec2, f64) {
        let mut t = t0;
        let mut out = at;
        for _ in 0..n {
            out = p.update(at, t, &cfg(), 120.0);
            t += 16.7;
        }
        (out, t)
    }

    #[test]
    fn small_jitter_is_frozen_by_the_clamp() {
        let mut p = FilterPipeline::new();
        let (_, mut t) = settle(&mut p, Vec2::new(500.0, 500.0), 0.0, 60);
        assert!(p.is_clamped(), "clamp should engage after dwell");

        let held = p.hold().unwrap();
        for k in 0..20 {
            let jitter = if k % 2 == 0 { 4.0 } else { -4.0 };
            let out = p.update(Vec2::new(500.0 + jitter, 500.0 - jitter), t, &cfg(), 120.0);
            assert_eq!(out, held, "clamp let jitter through");
            t += 16.7;
        }
    }

    /// The regression this whole change exists for: with realistic webcam noise
    /// the fixed 14 px clamp never engaged, so the cursor never came to rest.
    #[test]
    fn clamp_engages_even_with_large_gaze_noise() {
        let mut p = FilterPipeline::new();
        let mut t = 0.0;
        // ±25 px of noise around a fixation — bigger than the static radius.
        for k in 0..120 {
            let nx = if k % 2 == 0 { 25.0 } else { -25.0 };
            let ny = if k % 3 == 0 { 18.0 } else { -18.0 };
            p.update(Vec2::new(600.0 + nx, 400.0 + ny), t, &cfg(), 200.0);
            t += 16.7;
        }
        assert!(
            p.is_clamped(),
            "adaptive clamp failed to engage; radius was {}",
            p.effective_clamp_radius(),
        );
        assert!(p.effective_clamp_radius() > cfg().clamp_radius);
    }

    #[test]
    fn adaptive_radius_stays_small_for_a_clean_signal() {
        let mut p = FilterPipeline::new();
        let mut t = 0.0;
        for k in 0..120 {
            let n = if k % 2 == 0 { 1.0 } else { -1.0 };
            p.update(Vec2::new(600.0 + n, 400.0), t, &cfg(), 200.0);
            t += 16.7;
        }
        // A quiet signal must not inflate the radius and throw away precision.
        assert!(
            p.effective_clamp_radius() <= cfg().clamp_radius + 1.0,
            "radius inflated to {} on a clean signal",
            p.effective_clamp_radius()
        );
    }

    #[test]
    fn adaptive_radius_is_capped() {
        let mut p = FilterPipeline::new();
        let mut t = 0.0;
        for k in 0..200 {
            let n = if k % 2 == 0 { 400.0 } else { -400.0 };
            p.update(Vec2::new(900.0 + n, 500.0), t, &cfg(), 5000.0);
            t += 16.7;
        }
        assert!(p.effective_clamp_radius() <= cfg().clamp_radius_max);
    }

    #[test]
    fn median_rejects_a_single_bad_frame() {
        let mut p = FilterPipeline::new();
        let (_, t) = settle(&mut p, Vec2::new(500.0, 500.0), 0.0, 60);
        let before = p.hold().unwrap();
        // One catastrophically wrong frame, below the saccade threshold so the
        // gate does not catch it — the median must.
        let out = p.update(Vec2::new(590.0, 500.0), t, &cfg(), 120.0);
        assert!(
            (out.x - before.x).abs() < 5.0,
            "spike leaked through: {out:?} vs {before:?}"
        );
    }

    #[test]
    fn large_jump_bypasses_the_filter() {
        let mut p = FilterPipeline::new();
        let (_, mut t) = settle(&mut p, Vec2::new(100.0, 100.0), 0.0, 60);

        // Sustained move, so the median follows it rather than rejecting it.
        let mut out = Vec2::ZERO;
        for _ in 0..3 {
            out = p.update(Vec2::new(900.0, 700.0), t, &cfg(), 120.0);
            t += 16.7;
        }
        assert!(
            out.distance_to(Vec2::new(900.0, 700.0)) < 2.0,
            "saccade gate did not teleport: {out:?}"
        );
    }

    #[test]
    fn clamp_releases_when_gaze_leaves_the_radius() {
        let mut p = FilterPipeline::new();
        let (_, mut t) = settle(&mut p, Vec2::new(500.0, 500.0), 0.0, 60);
        assert!(p.is_clamped());

        for _ in 0..40 {
            p.update(Vec2::new(600.0, 500.0), t, &cfg(), 300.0);
            t += 16.7;
        }
        let out = p.hold().unwrap();
        assert!(out.x > 570.0, "clamp did not release: {out:?}");
    }

    #[test]
    fn clamp_times_out_rather_than_sticking_forever() {
        let mut c = cfg();
        c.clamp_max_hold_ms = 200.0;
        c.adaptive_clamp = false;
        let mut p = FilterPipeline::new();

        // With a short hold timeout the clamp legitimately *cycles* — engage,
        // time out, re-engage — so sampling `is_clamped()` at one arbitrary
        // instant proves nothing. Assert the property instead: it holds at some
        // point, releases at some point, and the output still tracks the input.
        let mut t = 0.0;
        let mut ever_held = false;
        for _ in 0..60 {
            p.update(Vec2::new(500.0, 500.0), t, &c, 120.0);
            ever_held |= p.is_clamped();
            t += 16.7;
        }
        assert!(ever_held, "clamp never engaged at all");

        let mut ever_released = false;
        for _ in 0..60 {
            p.update(Vec2::new(504.0, 500.0), t, &c, 120.0);
            ever_released |= !p.is_clamped();
            t += 16.7;
        }
        assert!(ever_released, "clamp held forever — the timeout never fired");

        let out = p.hold().unwrap();
        assert!((out.x - 504.0).abs() < 6.0, "output stuck at the old position: {out:?}");
    }

    #[test]
    fn reports_measured_spread_for_the_hud() {
        let mut p = FilterPipeline::new();
        let mut t = 0.0;
        for k in 0..60 {
            let n = if k % 2 == 0 { 12.0 } else { -12.0 };
            p.update(Vec2::new(500.0 + n, 500.0), t, &cfg(), 200.0);
            t += 16.7;
        }
        let spread = p.measured_spread().expect("spread should be available");
        assert!(spread > 5.0, "spread {spread} understates a ±12 px signal");
    }

    #[test]
    fn reset_clears_all_stages() {
        let mut p = FilterPipeline::new();
        settle(&mut p, Vec2::new(500.0, 500.0), 0.0, 60);
        p.reset();
        assert!(p.hold().is_none());
        assert!(!p.is_clamped());
        assert!(p.measured_spread().is_none());
    }
}
