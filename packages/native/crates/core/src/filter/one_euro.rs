//! One Euro filter — an exponential moving average whose cutoff frequency
//! rises with the estimated speed of the signal (ADR-0007).
//!
//! Gaze is not a smooth trajectory: it is near-stationary fixations punctuated
//! by ballistic saccades. A fixed-α EMA cannot serve both regimes. This filter
//! smooths hard when the signal is still and gets out of the way when it moves.

use std::f64::consts::PI;

/// Smoothing factor for a first-order low-pass at `cutoff` Hz over `dt` s.
fn alpha(cutoff: f64, dt: f64) -> f64 {
    let tau = 1.0 / (2.0 * PI * cutoff);
    1.0 / (1.0 + tau / dt)
}

#[derive(Debug, Clone, Default)]
pub struct OneEuro {
    /// Previous *filtered* value.
    x_prev: Option<f64>,
    /// Previous smoothed speed estimate.
    dx_prev: f64,
    last_t_ms: Option<f64>,
}

impl OneEuro {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-seed the filter at `x`. Used by the saccade gate so a jump lands
    /// immediately instead of gliding.
    pub fn reset_at(&mut self, x: f64, t_ms: f64) {
        self.x_prev = Some(x);
        self.dx_prev = 0.0;
        self.last_t_ms = Some(t_ms);
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Filter one sample. `min_cutoff` in Hz, `beta` in Hz per unit speed.
    pub fn filter(&mut self, x: f64, t_ms: f64, min_cutoff: f64, beta: f64, d_cutoff: f64) -> f64 {
        let (Some(last_t), Some(x_prev)) = (self.last_t_ms, self.x_prev) else {
            self.reset_at(x, t_ms);
            return x;
        };

        // Measured interval, not a nominal frame rate. Camera intervals are not
        // uniform, and assuming 1/30 s corrupts the speed estimate exactly
        // during the dropped frames where it matters most (ADR-0007).
        // Clamped so a paused stream cannot produce a divide-by-zero or an
        // absurdly small alpha.
        let dt = ((t_ms - last_t) / 1000.0).clamp(1e-4, 1.0);

        let dx = (x - x_prev) / dt;
        let dx_hat = self.dx_prev + alpha(d_cutoff, dt) * (dx - self.dx_prev);

        let cutoff = min_cutoff + beta * dx_hat.abs();
        let x_hat = x_prev + alpha(cutoff, dt) * (x - x_prev);

        self.x_prev = Some(x_hat);
        self.dx_prev = dx_hat;
        self.last_t_ms = Some(t_ms);
        x_hat
    }

    pub fn value(&self) -> Option<f64> {
        self.x_prev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN_CUTOFF: f64 = 1.0;
    const BETA: f64 = 0.007;
    const D_CUTOFF: f64 = 1.0;

    fn run(samples: &[(f64, f64)]) -> Vec<f64> {
        let mut f = OneEuro::new();
        samples.iter().map(|&(t, x)| f.filter(x, t, MIN_CUTOFF, BETA, D_CUTOFF)).collect()
    }

    #[test]
    fn first_sample_passes_through() {
        let mut f = OneEuro::new();
        assert_eq!(f.filter(42.0, 0.0, MIN_CUTOFF, BETA, D_CUTOFF), 42.0);
    }

    #[test]
    fn suppresses_jitter_around_a_constant() {
        // ±10 units of noise around 500, at 60 Hz.
        let samples: Vec<(f64, f64)> = (0..120)
            .map(|i| {
                let t = i as f64 * 16.7;
                let noise = if i % 2 == 0 { 10.0 } else { -10.0 };
                (t, 500.0 + noise)
            })
            .collect();
        let out = run(&samples);
        let tail = &out[60..];
        let spread = tail.iter().cloned().fold(f64::MIN, f64::max)
            - tail.iter().cloned().fold(f64::MAX, f64::min);
        // Input spread is 20; heavy smoothing at rest should cut it drastically.
        assert!(spread < 4.0, "residual jitter spread {spread}");
    }

    #[test]
    fn converges_toward_a_step() {
        let mut samples: Vec<(f64, f64)> = (0..30).map(|i| (i as f64 * 16.7, 100.0)).collect();
        samples.extend((30..120).map(|i| (i as f64 * 16.7, 900.0)));
        let out = run(&samples);
        // It lags — that is the point of the saccade gate in the pipeline — but
        // it must get there.
        assert!(out[119] > 850.0, "did not converge: {}", out[119]);
    }

    #[test]
    fn adapts_faster_when_moving_than_when_still() {
        // A high beta should track a ramp with less lag than a low beta.
        let ramp: Vec<(f64, f64)> = (0..60).map(|i| (i as f64 * 16.7, i as f64 * 20.0)).collect();

        let mut slow = OneEuro::new();
        let mut fast = OneEuro::new();
        let (mut slow_out, mut fast_out) = (0.0, 0.0);
        for &(t, x) in &ramp {
            slow_out = slow.filter(x, t, MIN_CUTOFF, 0.0, D_CUTOFF);
            fast_out = fast.filter(x, t, MIN_CUTOFF, 0.05, D_CUTOFF);
        }
        let target = ramp.last().unwrap().1;
        assert!(
            (target - fast_out).abs() < (target - slow_out).abs(),
            "adaptive cutoff did not reduce lag: fast {fast_out} slow {slow_out} target {target}"
        );
    }

    #[test]
    fn reset_at_jumps_immediately() {
        let mut f = OneEuro::new();
        for i in 0..30 {
            f.filter(100.0, i as f64 * 16.7, MIN_CUTOFF, BETA, D_CUTOFF);
        }
        f.reset_at(900.0, 500.0);
        assert_eq!(f.value(), Some(900.0));
        // And the next sample continues from there rather than from 100.
        let next = f.filter(900.0, 516.7, MIN_CUTOFF, BETA, D_CUTOFF);
        assert!((next - 900.0).abs() < 1.0, "next = {next}");
    }

    #[test]
    fn survives_a_long_gap_without_exploding() {
        let mut f = OneEuro::new();
        f.filter(100.0, 0.0, MIN_CUTOFF, BETA, D_CUTOFF);
        // 30 s gap — dt is clamped, so no divide-by-zero and no NaN.
        let out = f.filter(200.0, 30_000.0, MIN_CUTOFF, BETA, D_CUTOFF);
        assert!(out.is_finite(), "out = {out}");
        assert!((100.0..=200.0).contains(&out), "out = {out}");
    }

    #[test]
    fn identical_timestamps_do_not_produce_nan() {
        let mut f = OneEuro::new();
        f.filter(100.0, 1000.0, MIN_CUTOFF, BETA, D_CUTOFF);
        let out = f.filter(150.0, 1000.0, MIN_CUTOFF, BETA, D_CUTOFF);
        assert!(out.is_finite(), "out = {out}");
    }
}
