//! Ridge regression fitting with GCV-selected regularization (ADR-0006).
//!
//! The whole fit runs off precomputed Gram statistics, which is what makes
//! scanning a λ grid cheap:
//!
//!   G  = Φᵀ Φ   (p×p)      c = Φᵀ y   (p)      yy = yᵀ y
//!
//! For a given λ, with A = G + λI:
//!   β      = A⁻¹ c
//!   RSS    = yy − 2 βᵀc + βᵀGβ
//!   tr(H)  = tr(A⁻¹ G)        ← effective degrees of freedom
//!   GCV    = n · RSS / (n − tr(H))²
//!
//! None of those touch the n samples again, so a 41-point λ grid costs 41 small
//! matrix inversions rather than 41 passes over the data.

use super::model::{expand, CalibrationModel, CalibrationReport, FeatureTier, MAX_FEATURES};
use crate::frame::GazeFrame;
use crate::math::linalg::{invert_spd, solve_spd, trace_of_product};
use crate::math::Vec2;

/// One accepted calibration observation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibSample {
    pub frame: GazeFrame,
    pub target: Vec2,
    pub target_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalibrationError {
    NotEnoughSamples { got: usize, need: usize },
    NotEnoughTargets { got: usize, need: usize },
    /// The normal equations could not be factored even with regularization,
    /// which in practice means the collected features were degenerate.
    Degenerate,
}

impl core::fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CalibrationError::NotEnoughSamples { got, need } => {
                write!(f, "calibration needs at least {need} samples, got {got}")
            }
            CalibrationError::NotEnoughTargets { got, need } => {
                write!(f, "calibration needs at least {need} distinct targets, got {got}")
            }
            CalibrationError::Degenerate => {
                write!(f, "calibration data was degenerate; the fit could not be solved")
            }
        }
    }
}

const MIN_SAMPLES: usize = 20;
const MIN_TARGETS: usize = 3;
/// Below this standard deviation a feature counts as constant. Centering then
/// makes the column ~0 and ridge drives its coefficient to zero.
const DEGENERATE_STD: f64 = 1e-9;

struct Standardizer {
    mean: Vec<f64>,
    scale: Vec<f64>,
}

/// One axis' fitted coefficients.
struct AxisFit {
    beta: Vec<f64>,
    intercept: f64,
    lambda: f64,
}

/// Expand every sample and standardize the resulting design matrix.
fn build_design(samples: &[CalibSample], tier: FeatureTier) -> (Vec<f64>, Standardizer, usize) {
    let p = tier.len();
    let n = samples.len();
    let mut rows = vec![0.0; n * p];
    for (i, s) in samples.iter().enumerate() {
        let (phi, len) = expand(&s.frame, tier);
        debug_assert_eq!(len, p);
        rows[i * p..i * p + p].copy_from_slice(&phi[..p]);
    }

    let mut mean = vec![0.0; p];
    let mut scale = vec![1.0; p];
    for j in 0..p {
        let mut sum = 0.0;
        for i in 0..n {
            sum += rows[i * p + j];
        }
        mean[j] = sum / n as f64;
    }
    for j in 0..p {
        let mut var = 0.0;
        for i in 0..n {
            let d = rows[i * p + j] - mean[j];
            var += d * d;
        }
        let std = (var / n as f64).sqrt();
        scale[j] = if std < DEGENERATE_STD { 1.0 } else { std };
    }
    for i in 0..n {
        for j in 0..p {
            rows[i * p + j] = (rows[i * p + j] - mean[j]) / scale[j];
        }
    }

    (rows, Standardizer { mean, scale }, p)
}

/// λ grid, scaled by n so the shrinkage is comparable across sample counts.
/// With standardized features, G's diagonal is ≈ n.
fn lambda_grid(n: usize) -> Vec<f64> {
    const STEPS: usize = 41;
    (0..STEPS)
        .map(|k| {
            let exp = -8.0 + 10.0 * (k as f64) / (STEPS as f64 - 1.0); // 1e-8 .. 1e2
            n as f64 * 10f64.powf(exp)
        })
        .collect()
}

/// Fit one axis, selecting λ by generalized cross-validation.
fn fit_axis(
    g: &[f64],
    c: &[f64],
    yy: f64,
    n: usize,
    p: usize,
    intercept: f64,
) -> Result<AxisFit, CalibrationError> {
    let mut best: Option<(f64, f64, Vec<f64>)> = None; // (gcv, lambda, beta)

    for &lambda in &lambda_grid(n) {
        let mut a = g.to_vec();
        for i in 0..p {
            a[i * p + i] += lambda;
        }

        let Ok(beta) = solve_spd(&a, p, c) else { continue };
        let Ok(a_inv) = invert_spd(&a, p) else { continue };

        // RSS = yy - 2βᵀc + βᵀGβ
        let bc: f64 = beta.iter().zip(c).map(|(b, ci)| b * ci).sum();
        let mut bgb = 0.0;
        for i in 0..p {
            let mut row = 0.0;
            for j in 0..p {
                row += g[i * p + j] * beta[j];
            }
            bgb += beta[i] * row;
        }
        let rss = (yy - 2.0 * bc + bgb).max(0.0);

        let dof = trace_of_product(&a_inv, g, p);
        let denom = n as f64 - dof;
        if denom <= 1.0 {
            // Effective parameters approach the sample count — this λ cannot be
            // scored meaningfully.
            continue;
        }
        let gcv = (n as f64) * rss / (denom * denom);
        if !gcv.is_finite() {
            continue;
        }

        if best.as_ref().is_none_or(|(b, _, _)| gcv < *b) {
            best = Some((gcv, lambda, beta));
        }
    }

    let (_, lambda, beta) = best.ok_or(CalibrationError::Degenerate)?;
    Ok(AxisFit { beta, intercept, lambda })
}

/// Fit both axes from a set of samples. Shared by the main fit and by each
/// leave-one-target-out fold.
fn fit_coefficients(
    samples: &[CalibSample],
    tier: FeatureTier,
) -> Result<(Standardizer, AxisFit, AxisFit), CalibrationError> {
    let n = samples.len();
    if n < MIN_SAMPLES {
        return Err(CalibrationError::NotEnoughSamples { got: n, need: MIN_SAMPLES });
    }
    let (rows, std, p) = build_design(samples, tier);

    let mx = samples.iter().map(|s| s.target.x).sum::<f64>() / n as f64;
    let my = samples.iter().map(|s| s.target.y).sum::<f64>() / n as f64;

    // Gram matrix and cross-products, in one pass.
    let mut g = vec![0.0; p * p];
    let mut cx = vec![0.0; p];
    let mut cy = vec![0.0; p];
    let (mut yy_x, mut yy_y) = (0.0, 0.0);

    for i in 0..n {
        let row = &rows[i * p..i * p + p];
        let dx = samples[i].target.x - mx;
        let dy = samples[i].target.y - my;
        yy_x += dx * dx;
        yy_y += dy * dy;
        for a in 0..p {
            cx[a] += row[a] * dx;
            cy[a] += row[a] * dy;
            for b in a..p {
                g[a * p + b] += row[a] * row[b];
            }
        }
    }
    // Mirror the upper triangle we accumulated into the lower one.
    for a in 0..p {
        for b in (a + 1)..p {
            g[b * p + a] = g[a * p + b];
        }
    }

    let fx = fit_axis(&g, &cx, yy_x, n, p, mx)?;
    let fy = fit_axis(&g, &cy, yy_y, n, p, my)?;
    Ok((std, fx, fy))
}

fn predict_with(
    std: &Standardizer,
    fx: &AxisFit,
    fy: &AxisFit,
    tier: FeatureTier,
    frame: &GazeFrame,
) -> Vec2 {
    let (phi, p) = expand(frame, tier);
    let mut x = fx.intercept;
    let mut y = fy.intercept;
    for (j, &v) in phi.iter().take(p.min(MAX_FEATURES)).enumerate() {
        let z = (v - std.mean[j]) / std.scale[j];
        x += fx.beta[j] * z;
        y += fy.beta[j] * z;
    }
    Vec2::new(x, y)
}

/// Fit a calibration model and cross-validate it.
///
/// `px_per_degree` converts the reported error into degrees of visual angle;
/// `display_fingerprint` binds the model to the display layout it was fitted
/// against (ADR-0011).
pub fn fit(
    samples: &[CalibSample],
    px_per_degree: f64,
    display_fingerprint: impl Into<String>,
) -> Result<CalibrationModel, CalibrationError> {
    let mut target_ids: Vec<usize> = samples.iter().map(|s| s.target_index).collect();
    target_ids.sort_unstable();
    target_ids.dedup();
    let n_targets = target_ids.len();

    if n_targets < MIN_TARGETS {
        return Err(CalibrationError::NotEnoughTargets { got: n_targets, need: MIN_TARGETS });
    }

    let tier = FeatureTier::select(n_targets, samples.len());
    let (std, fx, fy) = fit_coefficients(samples, tier)?;

    // Leave-one-target-out cross-validation. Training error on a ridge fit is
    // not an accuracy estimate, so this is what we report.
    let mut errors: Vec<f64> = Vec::new();
    let mut per_target = vec![f64::NAN; n_targets];
    let mut cross_validated = true;

    if n_targets > MIN_TARGETS {
        for (slot, &held) in target_ids.iter().enumerate() {
            let train: Vec<CalibSample> =
                samples.iter().copied().filter(|s| s.target_index != held).collect();
            let test: Vec<&CalibSample> =
                samples.iter().filter(|s| s.target_index == held).collect();
            if train.len() < MIN_SAMPLES || test.is_empty() {
                cross_validated = false;
                continue;
            }
            let Ok((fstd, ffx, ffy)) = fit_coefficients(&train, tier) else {
                cross_validated = false;
                continue;
            };
            let mut sum = 0.0;
            for s in &test {
                let p = predict_with(&fstd, &ffx, &ffy, tier, &s.frame);
                let e = p.distance_to(s.target);
                errors.push(e);
                sum += e;
            }
            per_target[slot] = sum / test.len() as f64;
        }
    } else {
        cross_validated = false;
    }

    if errors.is_empty() {
        // Fall back to training error, flagged as not cross-validated so the UI
        // can say so rather than quietly reporting an optimistic number.
        cross_validated = false;
        for (slot, &held) in target_ids.iter().enumerate() {
            let mut sum = 0.0;
            let mut count = 0usize;
            for s in samples.iter().filter(|s| s.target_index == held) {
                let e = predict_with(&std, &fx, &fy, tier, &s.frame).distance_to(s.target);
                errors.push(e);
                sum += e;
                count += 1;
            }
            if count > 0 {
                per_target[slot] = sum / count as f64;
            }
        }
    }

    let mean_error_px = errors.iter().sum::<f64>() / errors.len().max(1) as f64;
    let mut sorted = errors.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let p95 = if sorted.is_empty() {
        f64::NAN
    } else {
        let idx = (((sorted.len() - 1) as f64) * 0.95).round() as usize;
        sorted[idx.min(sorted.len() - 1)]
    };

    // Head-pose statistics over the calibration set. These are what tell the
    // user whether the fit contains any head compensation at all (ADR-0015).
    let n = samples.len() as f64;
    let mut pose_mean = vec![0.0; 6];
    let mut pose_std = vec![0.0; 6];
    for s in samples {
        let p = s.frame.pose();
        for i in 0..6 {
            pose_mean[i] += p[i];
        }
    }
    for v in pose_mean.iter_mut() {
        *v /= n;
    }
    for s in samples {
        let p = s.frame.pose();
        for i in 0..6 {
            let d = p[i] - pose_mean[i];
            pose_std[i] += d * d;
        }
    }
    for v in pose_std.iter_mut() {
        *v = (*v / n).sqrt();
    }

    let report = CalibrationReport {
        tier_name: tier.as_str().to_string(),
        samples: samples.len(),
        targets: n_targets,
        mean_error_px,
        p95_error_px: p95,
        mean_error_deg: if px_per_degree > 0.0 { mean_error_px / px_per_degree } else { f64::NAN },
        per_target_error_px: per_target,
        lambda_x: fx.lambda,
        lambda_y: fy.lambda,
        cross_validated,
    };

    Ok(CalibrationModel {
        tier,
        mean: std.mean,
        scale: std.scale,
        beta_x: fx.beta,
        beta_y: fy.beta,
        intercept_x: fx.intercept,
        intercept_y: fy.intercept,
        lambda_x: fx.lambda,
        lambda_y: fy.lambda,
        report,
        display_fingerprint: display_fingerprint.into(),
        pose_mean,
        pose_std,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic LCG — no rand dependency, and reproducible failures.
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

    /// A synthetic user whose true gaze→screen map is quadratic — the model
    /// family the fitter assumes.
    fn ground_truth(gx: f64, gy: f64) -> Vec2 {
        Vec2::new(
            960.0 + 2400.0 * gx + 300.0 * gx * gx + 120.0 * gx * gy,
            540.0 + 1800.0 * gy - 260.0 * gy * gy,
        )
    }

    fn nine_point_samples(rng: &mut Rng, noise_sd: f64, per_target: usize) -> Vec<CalibSample> {
        let mut out = Vec::new();
        let mut idx = 0;
        for iy in 0..3 {
            for ix in 0..3 {
                // Iris offsets that would produce these screen positions.
                let gx = -0.25 + 0.25 * ix as f64;
                let gy = -0.25 + 0.25 * iy as f64;
                let target = ground_truth(gx, gy);
                for _ in 0..per_target {
                    let frame = GazeFrame {
                        t_ms: 0.0,
                        ok: true,
                        quality: 1.0,
                        gx: gx + rng.noise(noise_sd),
                        gy: gy + rng.noise(noise_sd),
                        ..Default::default()
                    };
                    out.push(CalibSample { frame, target, target_index: idx });
                }
                idx += 1;
            }
        }
        out
    }

    #[test]
    fn recovers_a_noiseless_quadratic_map() {
        let mut rng = Rng(42);
        let samples = nine_point_samples(&mut rng, 0.0, 20);
        let m = fit(&samples, 45.0, "test").unwrap();
        // With no noise the held-out error should be small relative to a 1080p
        // screen — a few pixels, not a few hundred.
        assert!(
            m.report.mean_error_px < 15.0,
            "mean error {} px, report {:?}",
            m.report.mean_error_px,
            m.report
        );
    }

    #[test]
    fn predicts_close_to_ground_truth_at_a_new_point() {
        let mut rng = Rng(7);
        let samples = nine_point_samples(&mut rng, 0.0, 20);
        let m = fit(&samples, 45.0, "test").unwrap();
        // An interpolation point that was not a calibration target.
        let gx = -0.125;
        let gy = 0.125;
        let f = GazeFrame { ok: true, quality: 1.0, gx, gy, ..Default::default() };
        let got = m.predict(&f);
        let want = ground_truth(gx, gy);
        assert!(got.distance_to(want) < 20.0, "got {got:?} want {want:?}");
    }

    #[test]
    fn degrades_gracefully_with_noise() {
        let mut rng = Rng(99);
        let samples = nine_point_samples(&mut rng, 0.01, 30);
        let m = fit(&samples, 45.0, "test").unwrap();
        assert!(m.report.mean_error_px.is_finite());
        assert!(m.report.cross_validated);
        // Should still be usable: well under a quarter of the screen.
        assert!(m.report.mean_error_px < 120.0, "error {}", m.report.mean_error_px);
    }

    /// The case that motivates ridge in ADR-0006: the head never moved during
    /// calibration, so the head-pose columns are constant. An unregularized fit
    /// would assign them arbitrary coefficients that explode the moment the
    /// user shifts. Here they must be driven to ~0.
    #[test]
    fn constant_head_pose_columns_get_zero_coefficients() {
        let mut rng = Rng(5);
        let mut samples = nine_point_samples(&mut rng, 0.002, 25);
        for s in samples.iter_mut() {
            s.frame.yaw = 0.3; // perfectly constant across the whole set
            s.frame.pitch = -0.1;
            s.frame.hx = 0.02;
        }
        let m = fit(&samples, 45.0, "test").unwrap();
        assert_eq!(m.tier, FeatureTier::Full);

        // Feature indices 5 (yaw), 6 (pitch), 8 (hx) were constant.
        for &j in &[5usize, 6, 8] {
            assert!(
                m.beta_x[j].abs() < 1e-6 && m.beta_y[j].abs() < 1e-6,
                "constant feature {j} got non-zero coefficients ({}, {})",
                m.beta_x[j],
                m.beta_y[j]
            );
        }

        // And the model must not blow up when the head then does move.
        let moved = GazeFrame {
            ok: true,
            quality: 1.0,
            gx: 0.0,
            gy: 0.0,
            yaw: 0.5,
            pitch: -0.4,
            hx: 0.2,
            ..Default::default()
        };
        let p = m.predict(&moved);
        assert!(p.is_finite());
        assert!(p.x.abs() < 10_000.0 && p.y.abs() < 10_000.0, "prediction exploded: {p:?}");
    }

    #[test]
    fn five_point_calibration_selects_basic_tier() {
        let mut rng = Rng(3);
        let mut out = Vec::new();
        let pts = [(-0.2, -0.2), (0.2, -0.2), (0.0, 0.0), (-0.2, 0.2), (0.2, 0.2)];
        for (idx, &(gx, gy)) in pts.iter().enumerate() {
            let target = ground_truth(gx, gy);
            for _ in 0..25 {
                out.push(CalibSample {
                    frame: GazeFrame {
                        ok: true,
                        quality: 1.0,
                        gx: gx + rng.noise(0.004),
                        gy: gy + rng.noise(0.004),
                        ..Default::default()
                    },
                    target,
                    target_index: idx,
                });
            }
        }
        let m = fit(&out, 45.0, "test").unwrap();
        assert_eq!(m.tier, FeatureTier::Basic);
        assert_eq!(m.beta_x.len(), 5);
    }

    #[test]
    fn rejects_too_few_targets() {
        let mut rng = Rng(1);
        let mut s = nine_point_samples(&mut rng, 0.0, 20);
        s.retain(|x| x.target_index < 2);
        assert!(matches!(
            fit(&s, 45.0, "test"),
            Err(CalibrationError::NotEnoughTargets { .. })
        ));
    }

    #[test]
    fn rejects_too_few_samples() {
        let mut rng = Rng(1);
        let mut s = nine_point_samples(&mut rng, 0.0, 1);
        s.truncate(9);
        assert!(matches!(
            fit(&s, 45.0, "test"),
            Err(CalibrationError::NotEnoughSamples { .. })
        ));
    }

    /// A bad calibration — the user looked somewhere unrelated to the targets —
    /// must produce a *large* reported error. The report has to be able to say
    /// "this calibration is bad" (milestone M3).
    #[test]
    fn garbage_calibration_reports_large_error() {
        let mut rng = Rng(1234);
        let mut samples = nine_point_samples(&mut rng, 0.0, 25);
        for s in samples.iter_mut() {
            s.frame.gx = rng.next_f64() - 0.5;
            s.frame.gy = rng.next_f64() - 0.5;
        }
        let m = fit(&samples, 45.0, "test").unwrap();
        assert!(
            m.report.mean_error_px > 150.0,
            "uncorrelated data should report large error, got {}",
            m.report.mean_error_px
        );
    }

    #[test]
    fn report_includes_per_target_errors() {
        let mut rng = Rng(11);
        let samples = nine_point_samples(&mut rng, 0.005, 20);
        let m = fit(&samples, 45.0, "test").unwrap();
        assert_eq!(m.report.per_target_error_px.len(), 9);
        assert!(m.report.per_target_error_px.iter().all(|e| e.is_finite()));
        assert!(m.report.mean_error_deg > 0.0);
    }
}
