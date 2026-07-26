//! The smoothing pipeline (ADR-0007, ADR-0014, ADR-0023):
//! median → One Euro → saccade gate → adaptive fixation clamp.

use super::median::{MedianFilter, SpreadEstimator};
use super::one_euro::OneEuro;
use crate::config::FilterConfig;
use crate::math::Vec2;

/// Hard lower bound on [`FilterConfig::trust_floor`].
///
/// Two of the three modulations *divide* by trust, so a floor at or near zero
/// would send the saccade threshold and the clamp radius to infinity and freeze
/// the cursor permanently. This bound is enforced here rather than at the config
/// boundary because the pipeline is the only thing that can be harmed by a bad
/// value, and it should not depend on every caller having validated it.
const TRUST_FLOOR_MIN: f64 = 0.1;

/// How much to trust this frame, as a bounded monotone function of the
/// confidence the caller handed us.
///
/// Deliberately the identity on confidence, floored — the same map ADR-0021
/// chose for calibration weights, and for the same reason: today's confidence is
/// a heuristic score, not a calibrated measurement of prediction variance, and a
/// bounded monotone map is as much as it can honestly support. `c²` or `1/σ²`
/// would be inventing precision the input does not have.
///
/// `max`/`min` rather than `clamp`, deliberately, for the two reasons clippy's
/// own lint note gives: `clamp` *panics* if a bound is NaN and *propagates* a
/// NaN input. Both are reachable here — `trust_floor` arrives from a live config
/// patch (ADR-0004) and `confidence` is an unvalidated scalar from a source this
/// module is not allowed to know about. `max`/`min` return the non-NaN operand
/// instead, so nonsense lands on the floor. Distrust is the right direction for
/// a confidence value we cannot read: over-smoothing costs lag, over-trusting
/// moves the cursor somewhere wrong.
#[allow(clippy::manual_clamp)]
fn trust(confidence: f64, cfg: &FilterConfig) -> f64 {
    if !cfg.confidence_trust {
        return 1.0;
    }
    let floor = cfg.trust_floor.max(TRUST_FLOOR_MIN).min(1.0);
    confidence.max(floor).min(1.0)
}

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
    ///
    /// `confidence` is how much this particular measurement should be believed,
    /// on 0..1. It is a **plain scalar with no declared source** on purpose: it
    /// is `estimateQuality()`'s heuristic today and is intended to become a
    /// learned per-frame predicted variance later, and that swap must be a
    /// one-line change at the call site rather than a change in here. Nothing in
    /// this file may grow a dependency on where the number came from.
    ///
    /// Pass `1.0` to mean "fully trusted", which is bit-for-bit the pipeline as
    /// it behaved before ADR-0023.
    pub fn update(
        &mut self,
        raw: Vec2,
        t_ms: f64,
        cfg: &FilterConfig,
        saccade_px: f64,
        confidence: f64,
    ) -> Vec2 {
        let window = cfg.median_window as usize;
        self.mx.set_window(window);
        self.my.set_window(window);

        // How far this frame gets to move the cursor. One scalar drives all
        // three modulations below, so there is exactly one thing to reason about
        // when the cursor feels different — and its floor bounds all three at
        // once (ADR-0023).
        let trust = trust(confidence, cfg);

        // Stage 1: median. Removes isolated landmark spikes before they can be
        // averaged into the exponential filter's state.
        let med = Vec2::new(self.mx.push(raw.x), self.my.push(raw.y));

        // Stage 2: saccade gate. A jump large enough to be a real eye movement
        // re-seeds everything so the cursor teleports rather than glides.
        //
        // A distrusted frame has to jump *further* to earn that, because a
        // spurious large jump is the characteristic output of a bad frame — a
        // briefly mislocalized iris looks exactly like a saccade, and the gate
        // is the one stage with no recovery: it throws away the filter state
        // that would otherwise have absorbed the error.
        let saccade = match self.last {
            Some(prev) => med.distance_to(prev) > saccade_px / trust,
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

        // Stage 3: One Euro, with the cutoff scaled by trust. A lower cutoff is
        // more lag and less jitter, which is the correct trade when the
        // measurement is unreliable: the estimate is worth less, so weight it
        // less against the filter's own history.
        //
        // Both terms are scaled, not just `min_cutoff`, so the whole cutoff
        // `min_cutoff + β·|dx̂|` moves together. Scaling only the resting term
        // barely does anything at exactly the noise levels this exists for: with
        // ±14 px of jitter at 60 Hz the β term alone contributes several Hz,
        // swamping a 0.6 Hz resting cutoff. Worse, that speed estimate is
        // computed from the same position we have just declared unreliable —
        // widening the filter on the strength of it is the pathology ADR-0014
        // identified for spikes, arriving by a slower route. Distrust in the
        // measurement is distrust in its derivative.
        let min_cutoff = cfg.min_cutoff * trust;
        let beta = cfg.beta * trust;
        let sx = self.fx.filter(med.x, t_ms, min_cutoff, beta, cfg.d_cutoff);
        let sy = self.fy.filter(med.y, t_ms, min_cutoff, beta, cfg.d_cutoff);
        let smoothed = Vec2::new(sx, sy);

        // Track how much the *pre-smoothing* signal is spreading; that is the
        // user's real noise level, and the smoothed signal would understate it.
        self.spread_x.push(med.x);
        self.spread_y.push(med.y);

        // Stage 4: fixation clamp, sized to measured noise and to trust.
        let radius = self.clamp_radius(cfg, trust);
        let out = self.clamp.apply(smoothed, t_ms, cfg, radius);
        self.last = Some(out);
        out
    }

    /// A constant radius is wrong for everyone: too small for a noisy camera
    /// (the clamp never engages and the cursor never rests) and too large for a
    /// good one (precision is thrown away). Size it to the measured spread, then
    /// to how much the current frame is believed.
    fn clamp_radius(&self, cfg: &FilterConfig, trust: f64) -> f64 {
        let base = self.measured_radius(cfg);

        // Distrust widens the radius on top of the measured spread, so an
        // uncertain signal is more readily treated as resting than chased. The
        // spread estimator answers "how much is this signal moving"; it cannot
        // answer "and is any of that real", which is what confidence adds.
        //
        // Bounded below by `base` so this can only ever widen, and above by the
        // ADR-0014 ceiling so a distrusted patch cannot freeze the cursor across
        // a large region — the exact failure that ceiling exists to prevent, and
        // distrust is when it is most likely. `base` also bounds the ceiling, so
        // a `clamp_radius` floor configured above `clamp_radius_max` keeps
        // behaving as it does today rather than being silently cut down.
        (base / trust).min(cfg.clamp_radius_max.max(base)).max(base)
    }

    /// The pre-ADR-0023 radius: the configured floor, scaled to measured spread.
    fn measured_radius(&self, cfg: &FilterConfig) -> f64 {
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

    /// The pipeline as it behaved before ADR-0023: confidence is ignored.
    fn unmodulated() -> FilterConfig {
        FilterConfig { confidence_trust: false, ..cfg() }
    }

    /// Confidence modulation with the fixation clamp taken out of the way.
    ///
    /// The clamp freezes both outputs once gaze settles, which would hide the
    /// difference under test behind two identical constants. A radius of zero
    /// can never be satisfied (the anchor test is `distance <= radius`), so this
    /// leaves the median → gate → One Euro path running alone.
    fn no_clamp() -> FilterConfig {
        FilterConfig { adaptive_clamp: false, clamp_radius: 0.0, ..cfg() }
    }

    /// Deterministic LCG, so a bit-for-bit comparison has something varied to
    /// compare over without depending on the `rand` crate.
    struct Rng(u64);
    impl Rng {
        fn next_f64(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as f64) / ((1u64 << 31) as f64)
        }
        /// Roughly normal, via the sum of uniforms.
        fn noise(&mut self, sd: f64) -> f64 {
            let s: f64 = (0..6).map(|_| self.next_f64()).sum::<f64>() - 3.0;
            s * sd / 1.414
        }
    }

    /// Peak-to-peak range of a slice — how much the cursor visibly moved.
    fn spread_of(v: &[f64]) -> f64 {
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    }

    /// Feed a constant point for `n` frames at 60 Hz starting at `t0`.
    fn settle(p: &mut FilterPipeline, at: Vec2, t0: f64, n: usize) -> (Vec2, f64) {
        let mut t = t0;
        let mut out = at;
        for _ in 0..n {
            out = p.update(at, t, &cfg(), 120.0, 1.0);
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
            let out = p.update(Vec2::new(500.0 + jitter, 500.0 - jitter), t, &cfg(), 120.0, 1.0);
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
            p.update(Vec2::new(600.0 + nx, 400.0 + ny), t, &cfg(), 200.0, 1.0);
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
            p.update(Vec2::new(600.0 + n, 400.0), t, &cfg(), 200.0, 1.0);
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
            p.update(Vec2::new(900.0 + n, 500.0), t, &cfg(), 5000.0, 1.0);
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
        let out = p.update(Vec2::new(590.0, 500.0), t, &cfg(), 120.0, 1.0);
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
            out = p.update(Vec2::new(900.0, 700.0), t, &cfg(), 120.0, 1.0);
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
            p.update(Vec2::new(600.0, 500.0), t, &cfg(), 300.0, 1.0);
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
            p.update(Vec2::new(500.0, 500.0), t, &c, 120.0, 1.0);
            ever_held |= p.is_clamped();
            t += 16.7;
        }
        assert!(ever_held, "clamp never engaged at all");

        let mut ever_released = false;
        for _ in 0..60 {
            p.update(Vec2::new(504.0, 500.0), t, &c, 120.0, 1.0);
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
            p.update(Vec2::new(500.0 + n, 500.0), t, &cfg(), 200.0, 1.0);
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

    // ---- confidence modulation (ADR-0023) --------------------------------

    /// The regression guard for ADR-0023, and the most important test here.
    ///
    /// A fully-trusted frame must reproduce the pre-ADR-0023 pipeline
    /// *exactly*, not approximately. `x * 1.0` and `x / 1.0` are exact in IEEE
    /// 754, so bit equality is a property of the code rather than luck — and a
    /// tolerance would pass just as happily if the modulated path had introduced
    /// a real-but-small bias, which is the defect that would otherwise surface
    /// months later as "the cursor feels slightly different" with nothing to
    /// point at.
    ///
    /// The disabled pipeline is handed a *low* confidence deliberately, so the
    /// same run also proves the A/B switch ignores confidence entirely rather
    /// than merely damping it.
    #[test]
    fn full_confidence_reproduces_the_unmodulated_pipeline_bit_for_bit() {
        assert!(cfg().confidence_trust, "the default must be the path under test");
        let (on, off) = (cfg(), unmodulated());

        let mut modulated = FilterPipeline::new();
        let mut plain = FilterPipeline::new();
        let mut rng = Rng(0xC0FFEE);
        let mut t = 0.0;

        for i in 0..600 {
            // Fixations with jitter, occasional catastrophic spikes, and target
            // changes large enough to trip the gate: every stage has to be
            // exercised for the comparison to mean anything.
            let cx = 300.0 + 500.0 * ((i / 120) % 3) as f64;
            let cy = 200.0 + 300.0 * ((i / 90) % 4) as f64;
            let spike = if i % 97 == 0 { 140.0 } else { 0.0 };
            let raw = Vec2::new(cx + rng.noise(9.0) + spike, cy + rng.noise(9.0));
            // Non-uniform intervals, because dt drives the speed estimate.
            t += 14.0 + rng.next_f64() * 6.0;

            let a = modulated.update(raw, t, &on, 120.0, 1.0);
            let b = plain.update(raw, t, &off, 120.0, 0.30);

            assert_eq!(a.x.to_bits(), b.x.to_bits(), "frame {i}: x {a:?} vs {b:?}");
            assert_eq!(a.y.to_bits(), b.y.to_bits(), "frame {i}: y {a:?} vs {b:?}");
            assert_eq!(
                modulated.effective_clamp_radius().to_bits(),
                plain.effective_clamp_radius().to_bits(),
                "frame {i}: clamp radius diverged",
            );
            assert_eq!(modulated.is_clamped(), plain.is_clamped(), "frame {i}: clamp state");
            assert_eq!(modulated.was_saccade(), plain.was_saccade(), "frame {i}: gate verdict");
        }
    }

    /// Modulation 1: a distrusted frame is smoothed harder.
    ///
    /// Same noise, same timing, same everything but the scalar — the cursor has
    /// to visibly move less when the estimate behind it is not believed.
    #[test]
    fn a_distrusted_noisy_signal_moves_the_cursor_less_than_a_trusted_one() {
        let run = |confidence: f64| {
            let mut p = FilterPipeline::new();
            let mut rng = Rng(4242);
            let mut out = Vec::new();
            for i in 0..240 {
                let raw = Vec2::new(800.0 + rng.noise(14.0), 400.0 + rng.noise(14.0));
                // A gate wide enough that noise cannot trip it; this test is
                // about the One Euro stage, not the saccade gate.
                let s = p.update(raw, i as f64 * 16.7, &no_clamp(), 400.0, confidence);
                if i >= 120 {
                    out.push(s.x);
                }
            }
            spread_of(&out)
        };

        // At the defaults this measures 6.9 px of residual travel at full
        // confidence against 3.7 px at 0.4 — a 46% reduction. The bound is
        // loose because the exact figure is not the contract; the direction and
        // the order of magnitude are.
        let trusted = run(1.0);
        let distrusted = run(0.4);
        assert!(
            distrusted < trusted * 0.75,
            "distrust barely smoothed at all: trusted {trusted:.2} px, distrusted {distrusted:.2} px",
        );
    }

    /// The other half of that trade, stated explicitly so it cannot regress
    /// silently: trusting a frame fully must cost nothing.
    #[test]
    fn full_confidence_adds_no_lag_to_a_moving_signal() {
        // A steady ramp, well under the saccade threshold so the gate stays out
        // of it and the residual is pure filter lag.
        let lag_on = |cfg: &FilterConfig, confidence: f64| {
            let mut p = FilterPipeline::new();
            let mut out = Vec2::ZERO;
            let mut x = 200.0;
            for i in 0..90 {
                out = p.update(Vec2::new(x, 400.0), i as f64 * 16.7, cfg, 400.0, confidence);
                x += 8.0;
            }
            (x - 8.0) - out.x
        };

        let trusted = lag_on(&no_clamp(), 1.0);
        let unmodulated = lag_on(&FilterConfig { confidence_trust: false, ..no_clamp() }, 1.0);
        assert_eq!(
            trusted.to_bits(),
            unmodulated.to_bits(),
            "confidence 1.0 changed the lag: {trusted} vs {unmodulated}",
        );

        // …and the cost of distrust lands where it should, as lag rather than
        // as error in some less predictable place.
        let distrusted = lag_on(&no_clamp(), 0.4);
        assert!(
            distrusted > trusted,
            "distrust did not trade latency for stability: {distrusted} vs {trusted}",
        );
    }

    /// Modulation 2: distrust widens the fixation clamp.
    ///
    /// The spread estimator answers "how much is this signal moving". It cannot
    /// answer "and is any of that real", which is the part confidence supplies —
    /// so an uncertain signal is treated as resting more readily rather than
    /// chased around.
    #[test]
    fn distrust_widens_the_fixation_clamp() {
        let run = |confidence: f64| {
            let mut p = FilterPipeline::new();
            let mut rng = Rng(99);
            for i in 0..180 {
                let raw = Vec2::new(700.0 + rng.noise(10.0), 500.0 + rng.noise(10.0));
                p.update(raw, i as f64 * 16.7, &cfg(), 400.0, confidence);
            }
            p.effective_clamp_radius()
        };

        let trusted = run(1.0);
        let distrusted = run(0.5);
        assert!(
            distrusted > trusted * 1.5,
            "distrust did not widen the radius: {trusted:.1} px vs {distrusted:.1} px",
        );
        // The ADR-0014 ceiling still holds. It exists precisely so a patch of
        // bad tracking cannot freeze the cursor across a large region, and bad
        // tracking is exactly when this modulation is active.
        assert!(
            distrusted <= cfg().clamp_radius_max,
            "widened past the ceiling: {distrusted:.1} px",
        );
    }

    /// Modulation 3: a distrusted frame must jump further to be believed.
    ///
    /// 200 px against a 120 px threshold is a saccade at full confidence. At 0.5
    /// the threshold is 240 px, so the same jump is filtered instead of
    /// teleported — which is what we want, because a briefly mislocalized iris
    /// produces this exact signature and the gate is the one stage with no
    /// recovery: it discards the filter state that would have absorbed it.
    #[test]
    fn a_distrusted_frame_needs_a_larger_jump_to_count_as_a_saccade() {
        let jumped = |confidence: f64| {
            let mut p = FilterPipeline::new();
            let (_, mut t) = settle(&mut p, Vec2::new(500.0, 500.0), 0.0, 60);
            let mut ever = false;
            // Sustained, so the median follows the move rather than rejecting it
            // as a spike — otherwise this would test the median, not the gate.
            for _ in 0..6 {
                p.update(Vec2::new(700.0, 500.0), t, &cfg(), 120.0, confidence);
                ever |= p.was_saccade();
                t += 16.7;
            }
            ever
        };

        assert!(jumped(1.0), "a 200 px jump should be a saccade when tracking is good");
        assert!(!jumped(0.5), "a 200 px jump was accepted from a half-trusted frame");
    }

    /// The floor is what bounds all three modulations at once, so it is worth
    /// pinning directly — including the values a config patch or a future
    /// confidence source could hand us by accident.
    #[test]
    fn the_trust_floor_bounds_the_modulation_and_absorbs_nonsense_input() {
        let c = cfg();
        assert_eq!(trust(1.0, &c).to_bits(), 1.0f64.to_bits(), "full trust must be exactly 1.0");
        assert_eq!(trust(0.0, &c), c.trust_floor);
        assert_eq!(trust(-5.0, &c), c.trust_floor);
        assert_eq!(trust(9.0, &c), 1.0, "over-confidence cannot buy less smoothing than none");
        // Distrust, not a panic and not a NaN leaking into the cursor position.
        assert_eq!(trust(f64::NAN, &c), c.trust_floor);

        // Two of the modulations divide by trust, so a floor of zero would send
        // the saccade threshold and the clamp radius to infinity.
        assert_eq!(trust(0.0, &FilterConfig { trust_floor: 0.0, ..c }), TRUST_FLOOR_MIN);
        assert_eq!(trust(0.0, &FilterConfig { trust_floor: f64::NAN, ..c }), TRUST_FLOOR_MIN);

        assert_eq!(trust(0.01, &unmodulated()), 1.0, "the switch must mean off, not damped");
    }

    /// The default floor sits below the default `min_quality`, so at stock
    /// settings it never binds: every frame the guard admits is modulated by its
    /// own quality, and the widest possible spread between two admitted frames
    /// is 2.5:1 — the same bound ADR-0021 places on calibration weights.
    #[test]
    fn the_default_floor_is_inert_at_the_default_quality_gate() {
        let gate = crate::config::GuardConfig::default().min_quality;
        assert!(
            cfg().trust_floor < gate,
            "trust floor {} would clip frames the guard admits at {gate}",
            cfg().trust_floor,
        );
        assert_eq!(trust(gate, &cfg()), gate);
    }
}
