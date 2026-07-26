//! Ridge regression fitting with held-out-target λ selection (ADR-0006,
//! ADR-0019), weighted by per-sample tracking quality (ADR-0021).
//!
//! The whole fit runs off precomputed Gram statistics, which is what makes
//! scanning a λ grid cheap:
//!
//!   G  = Φᵀ W Φ   (p×p)      c = Φᵀ W y   (p)      yy = yᵀ W y
//!
//! `W` is diagonal, one weight per sample. `W = I` recovers ordinary least
//! squares exactly, which is what `CalibrationConfig::quality_weighting = false`
//! does.
//!
//! For a given λ, with A = G + λI:
//!   β      = A⁻¹ c
//!   RSS    = yy − 2 βᵀc + βᵀGβ
//!   tr(H)  = tr(A⁻¹ G)        ← effective degrees of freedom
//!   GCV    = n_eff · RSS / (n_eff − tr(H))²
//!
//! None of those touch the n samples again, so a 41-point λ grid costs 41 small
//! matrix inversions rather than 41 passes over the data.
//!
//! ## Which "n" is which
//!
//! Weighting splits the single `n` of the unweighted formulation into three
//! quantities that used to coincide, and they are *not* interchangeable:
//!
//! - **Σw**, the total weight. Every place `n` meant "how much data is behind
//!   this sum" — the standardizer's moments, the target centering, and the λ
//!   scale — takes Σw. Because standardization makes each column's weighted
//!   variance exactly 1, `diag(G) = Σw`, so `λ = ratio · Σw` keeps `ratio`
//!   meaning the same thing across folds and across sessions, exactly as
//!   `λ = ratio · n` did before. It also makes the fit invariant to a uniform
//!   rescaling of every weight, which is what stops a session where the user
//!   simply tracked worse from being *regularized* differently as well.
//! - **n_eff**, Kish's effective count `(Σw)² / Σw²`. This is an *evidence*
//!   measure, not a scale, so it belongs only where a count of independent
//!   observations is wanted — the GCV denominator. Using it for λ would silently
//!   change the shrinkage the moment weights spread out, in the wrong direction:
//!   less regularization for weaker data.
//! - **n**, the raw sample count. Still the right answer for the structural
//!   checks (`MIN_SAMPLES`) and for anything the user reads as "how many frames
//!   did you collect".

use super::model::{expand, CalibrationModel, CalibrationReport, FeatureTier, MAX_FEATURES};
use crate::config::CalibrationConfig;
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

/// Turn one sample's tracking quality into its regression weight.
///
/// Deliberately the identity on quality rather than something steeper like
/// `quality²`: `quality` is a heuristic confidence, not a measured inverse
/// variance, and a monotone bounded map is as much as it can honestly support.
/// Between the floor and 1.0 the spread stays small — at the default gate no
/// admitted sample can outweigh another by more than 2.5:1 — so this nudges the
/// fit toward the better frames without letting any single one dominate.
fn sample_weight(frame: &GazeFrame, cfg: &CalibrationConfig) -> f64 {
    if !cfg.quality_weighting {
        return 1.0;
    }
    // `clamp` panics if the bounds cross, and `weight_floor` is patchable at
    // runtime, so the floor is sanitized before it is used as one.
    let floor = if cfg.weight_floor.is_finite() { cfg.weight_floor.clamp(0.0, 1.0) } else { 0.0 };
    if !frame.quality.is_finite() {
        // A non-finite quality would poison every Gram entry and fail the whole
        // calibration. Treating it as the worst admissible sample keeps one bad
        // frame from costing the user the entire run.
        return floor;
    }
    frame.quality.clamp(floor, 1.0)
}

fn sample_weights(samples: &[CalibSample], cfg: &CalibrationConfig) -> Vec<f64> {
    samples.iter().map(|s| sample_weight(&s.frame, cfg)).collect()
}

/// Kish's effective sample size, `(Σw)² / Σw²`.
///
/// Reads as "how many equally-weighted observations carry the same information
/// as this weighted set". Equals the element count exactly when the weights are
/// uniform, and falls toward 1 as one weight comes to dominate.
fn kish_n_eff(w: &[f64]) -> f64 {
    let sum: f64 = w.iter().sum();
    let sum_sq: f64 = w.iter().map(|x| x * x).sum();
    if sum_sq <= 0.0 {
        return 0.0;
    }
    sum * sum / sum_sq
}

/// One axis' fitted coefficients.
struct AxisFit {
    beta: Vec<f64>,
    intercept: f64,
    lambda: f64,
}

/// Expand every sample and standardize the resulting design matrix.
///
/// The moments are **weighted**: `mean = Σwx / Σw`, `var = Σw(x−mean)² / Σw`.
/// Standardizing with unweighted moments while fitting with weighted ones would
/// centre the columns on a point the fit does not actually sit at — the centre
/// of the low-quality samples as much as the good ones — and ridge penalizes
/// coefficients relative to that centre, so the bias would not stay cosmetic.
///
/// Dividing by Σw rather than by Σw − Σw²/Σw (the unbiased correction) is
/// deliberate: it makes the weighted variance of every standardized column
/// exactly 1, hence `diag(G) = Σw`, which is the invariant the λ grid rides on.
fn build_design(
    samples: &[CalibSample],
    tier: FeatureTier,
    w: &[f64],
    w_sum: f64,
) -> (Vec<f64>, Standardizer, usize) {
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
            sum += w[i] * rows[i * p + j];
        }
        mean[j] = sum / w_sum;
    }
    for j in 0..p {
        let mut var = 0.0;
        for i in 0..n {
            let d = rows[i * p + j] - mean[j];
            var += w[i] * d * d;
        }
        let std = (var / w_sum).sqrt();
        scale[j] = if std < DEGENERATE_STD { 1.0 } else { std };
    }
    for i in 0..n {
        for j in 0..p {
            rows[i * p + j] = (rows[i * p + j] - mean[j]) / scale[j];
        }
    }

    (rows, Standardizer { mean, scale }, p)
}

/// Candidate ridge strengths, as multipliers on the total sample weight.
///
/// Expressed as a *ratio* rather than an absolute λ so the same shrinkage can be
/// applied to folds of different sizes: with weight-standardized features G's
/// diagonal is exactly Σw, so λ = ratio · Σw means the same thing everywhere.
/// (Unweighted, Σw is the sample count and this is the original λ = ratio · n.)
fn lambda_ratios() -> Vec<f64> {
    const STEPS: usize = 41;
    (0..STEPS)
        .map(|k| 10f64.powf(-8.0 + 10.0 * (k as f64) / (STEPS as f64 - 1.0))) // 1e-8 .. 1e2
        .collect()
}

/// Precomputed normal equations for one set of samples.
struct Normal {
    std: Standardizer,
    g: Vec<f64>,
    cx: Vec<f64>,
    cy: Vec<f64>,
    yy_x: f64,
    yy_y: f64,
    mx: f64,
    my: f64,
    /// Σw. The scale everything statistical divides by, and what λ rides on.
    /// Unweighted this is exactly the sample count, which is what it used to be.
    w_sum: f64,
    p: usize,
}

fn normal_equations(samples: &[CalibSample], tier: FeatureTier, w: &[f64]) -> Normal {
    let n = samples.len();
    debug_assert_eq!(w.len(), n);
    let w_sum: f64 = w.iter().sum();
    let (rows, std, p) = build_design(samples, tier, w, w_sum);

    // Weighted target means. This is the intercept, and it has to be the centre
    // of the *weighted* fit: an unweighted mean would pull the model's origin
    // toward the samples it then goes on to discount.
    let mx = samples.iter().zip(w).map(|(s, wi)| wi * s.target.x).sum::<f64>() / w_sum;
    let my = samples.iter().zip(w).map(|(s, wi)| wi * s.target.y).sum::<f64>() / w_sum;

    let mut g = vec![0.0; p * p];
    let mut cx = vec![0.0; p];
    let mut cy = vec![0.0; p];
    let (mut yy_x, mut yy_y) = (0.0, 0.0);

    for i in 0..n {
        let row = &rows[i * p..i * p + p];
        let wi = w[i];
        let dx = samples[i].target.x - mx;
        let dy = samples[i].target.y - my;
        yy_x += wi * dx * dx;
        yy_y += wi * dy * dy;
        // One multiply per row turns ΦᵀΦ into ΦᵀWΦ and Φᵀy into ΦᵀWy: fold the
        // weight into the row once rather than into every product it appears in.
        for a in 0..p {
            let wr = wi * row[a];
            cx[a] += wr * dx;
            cy[a] += wr * dy;
            for b in a..p {
                g[a * p + b] += wr * row[b];
            }
        }
    }
    // Mirror the upper triangle we accumulated into the lower one.
    for a in 0..p {
        for b in (a + 1)..p {
            g[b * p + a] = g[a * p + b];
        }
    }

    Normal { std, g, cx, cy, yy_x, yy_y, mx, my, w_sum, p }
}

/// Solve (G + λI)β = c.
fn ridge_solve(g: &[f64], c: &[f64], p: usize, lambda: f64) -> Option<Vec<f64>> {
    let mut a = g.to_vec();
    for i in 0..p {
        a[i * p + i] += lambda;
    }
    solve_spd(&a, p, c).ok()
}

/// How λ is chosen for a fit.
enum LambdaChoice {
    /// Scan the grid, scoring by generalized cross-validation.
    ///
    /// `n_eff` is the number of *independent* observations, which is not the
    /// sample count — see `select_lambda_by_target` and `effective_targets`.
    Gcv { n_eff: f64 },
    /// Use these exact ratios (λ = ratio · Σw), already chosen elsewhere.
    Fixed { x: f64, y: f64 },
}

/// Fit one axis by scanning the λ grid and scoring with GCV.
fn fit_axis_gcv(
    g: &[f64],
    c: &[f64],
    yy: f64,
    w_sum: f64,
    n_eff: f64,
    p: usize,
    intercept: f64,
) -> Result<AxisFit, CalibrationError> {
    let mut best: Option<(f64, f64, Vec<f64>)> = None; // (gcv, lambda, beta)

    for &ratio in &lambda_ratios() {
        let lambda = ratio * w_sum;
        let Some(beta) = ridge_solve(g, c, p, lambda) else { continue };
        let mut a = g.to_vec();
        for i in 0..p {
            a[i * p + i] += lambda;
        }
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
        // Scored against the *effective* sample count. Using the raw sample
        // count here is what made GCV under-regularize so badly: it treats 20
        // samples from one fixation as 20 independent observations, so the
        // model can afford far more effective parameters than the data really
        // supports.
        let denom = n_eff - dof;
        if denom <= 1.0 {
            // Effective parameters approach the observation count — this λ
            // cannot be scored meaningfully.
            continue;
        }
        let gcv = n_eff * rss / (denom * denom);
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
    choice: &LambdaChoice,
    cfg: &CalibrationConfig,
) -> Result<(Standardizer, AxisFit, AxisFit), CalibrationError> {
    // The raw count, not Σw: this guards against an underdetermined system,
    // which is a question about how many rows the design matrix has, not about
    // how much each of them is trusted.
    let n = samples.len();
    if n < MIN_SAMPLES {
        return Err(CalibrationError::NotEnoughSamples { got: n, need: MIN_SAMPLES });
    }
    let eq = normal_equations(samples, tier, &sample_weights(samples, cfg));

    let (fx, fy) = match *choice {
        LambdaChoice::Gcv { n_eff } => (
            fit_axis_gcv(&eq.g, &eq.cx, eq.yy_x, eq.w_sum, n_eff, eq.p, eq.mx)?,
            fit_axis_gcv(&eq.g, &eq.cy, eq.yy_y, eq.w_sum, n_eff, eq.p, eq.my)?,
        ),
        LambdaChoice::Fixed { x, y } => {
            let lx = x * eq.w_sum;
            let ly = y * eq.w_sum;
            let bx = ridge_solve(&eq.g, &eq.cx, eq.p, lx).ok_or(CalibrationError::Degenerate)?;
            let by = ridge_solve(&eq.g, &eq.cy, eq.p, ly).ok_or(CalibrationError::Degenerate)?;
            (
                AxisFit { beta: bx, intercept: eq.mx, lambda: lx },
                AxisFit { beta: by, intercept: eq.my, lambda: ly },
            )
        }
    };

    Ok((eq.std, fx, fy))
}

/// Choose λ by leave-one-*target*-out cross-validation.
///
/// ## Why GCV is the wrong criterion here
///
/// GCV assumes independent observations, and a calibration set is emphatically
/// not that: ~20 consecutive frames of one fixation are nearly identical
/// measurements of a single event. Handing GCV `n = 253` when the data really
/// contains 13 independent observations overstates the sample size by ~20×, and
/// it buys the extra apparent evidence by choosing far too little shrinkage.
///
/// Observed on real hardware: λ/n ≈ 5.6e-6 (essentially unregularized) for an
/// 18-feature model, producing coefficients of ±3000 px per standard deviation
/// on a 1329 px-tall screen, with the head-pose terms driving the *horizontal*
/// prediction more strongly than horizontal gaze did. Held-out error was 478 px
/// while the centre target — the best-conditioned one — sat at 89 px. Classic
/// overfitting, and invisible to any criterion scored on the training set.
///
/// Holding out a whole target at a time respects the correlation structure: the
/// held-out fixation shares no frames with the training set, so a λ that only
/// looks good by memorizing fixations scores badly.
///
/// Returns `None` when there are too few targets to hold one out.
fn select_lambda_by_target(
    samples: &[CalibSample],
    tier: FeatureTier,
    target_ids: &[usize],
    cfg: &CalibrationConfig,
) -> Option<(f64, f64)> {
    // Each fold must still leave a usable training set behind.
    if target_ids.len() <= MIN_TARGETS {
        return None;
    }

    // Build every fold's normal equations once, then scan λ over them. This is
    // what keeps the whole search cheap: the O(n·p²) accumulation happens once
    // per fold rather than once per (fold, λ) pair.
    struct Fold {
        eq: Normal,
        test: Vec<CalibSample>,
        /// Weights of the held-out samples, so the score is the same risk the
        /// fit minimizes.
        test_w: Vec<f64>,
    }

    let mut folds: Vec<Fold> = Vec::with_capacity(target_ids.len());
    for &held in target_ids {
        let train: Vec<CalibSample> =
            samples.iter().copied().filter(|s| s.target_index != held).collect();
        let test: Vec<CalibSample> =
            samples.iter().copied().filter(|s| s.target_index == held).collect();
        if train.len() < MIN_SAMPLES || test.is_empty() {
            continue;
        }
        let w = sample_weights(&train, cfg);
        let test_w = sample_weights(&test, cfg);
        folds.push(Fold { eq: normal_equations(&train, tier, &w), test, test_w });
    }
    if folds.len() < 2 {
        return None;
    }

    // Scored per axis, not on 2-D distance. The two axes routinely have very
    // different signal strength — vertical iris travel is roughly half of
    // horizontal, because the eyelids crop the iris exactly as the eye rotates
    // up and down — so the weaker axis genuinely needs more shrinkage than the
    // stronger one, and a shared λ would split the difference badly.
    let mut best_x: Option<(f64, f64)> = None; // (sse, ratio)
    let mut best_y: Option<(f64, f64)> = None;

    for &ratio in &lambda_ratios() {
        let mut sse_x = 0.0;
        let mut sse_y = 0.0;
        let mut ok = true;

        for fold in &folds {
            let lambda = ratio * fold.eq.w_sum;
            let (Some(bx), Some(by)) = (
                ridge_solve(&fold.eq.g, &fold.eq.cx, fold.eq.p, lambda),
                ridge_solve(&fold.eq.g, &fold.eq.cy, fold.eq.p, lambda),
            ) else {
                ok = false;
                break;
            };

            let fx = AxisFit { beta: bx, intercept: fold.eq.mx, lambda };
            let fy = AxisFit { beta: by, intercept: fold.eq.my, lambda };
            // Weighted, unlike the error we report to the user. λ is a
            // parameter of the weighted estimator, so it should be tuned
            // against the weighted risk that estimator minimizes; scoring it
            // unweighted would let the frames the fit deliberately discounts
            // come back and choose its shrinkage. The user-facing accuracy
            // figure below is a different question — "how far off will this be
            // in practice" — and counts every held-out frame equally.
            for (s, &w) in fold.test.iter().zip(&fold.test_w) {
                let p = predict_with(&fold.eq.std, &fx, &fy, tier, &s.frame);
                sse_x += w * (p.x - s.target.x).powi(2);
                sse_y += w * (p.y - s.target.y).powi(2);
            }
        }

        if !ok || !sse_x.is_finite() || !sse_y.is_finite() {
            continue;
        }
        if best_x.as_ref().is_none_or(|(b, _)| sse_x < *b) {
            best_x = Some((sse_x, ratio));
        }
        if best_y.as_ref().is_none_or(|(b, _)| sse_y < *b) {
            best_y = Some((sse_y, ratio));
        }
    }

    Some((best_x?.1, best_y?.1))
}

/// The number of *independent* observations behind a fit, for GCV.
///
/// ADR-0019 established that this is the target count, not the sample count: a
/// fixation is one observation however many frames it contributed, and handing
/// GCV the frame count is what let it under-regularize catastrophically.
///
/// Weights refine that rather than replace it. A target whose every frame was
/// marginal is worth less than a whole observation, so the count becomes Kish's
/// effective size over the per-target *mean* weight. Taking the mean rather than
/// the sum is the point: it keeps the unit "one fixation", so uneven sample
/// counts across targets — which say nothing about evidence — do not change the
/// answer, and uniform weights give back exactly the integer target count.
fn effective_targets(samples: &[CalibSample], w: &[f64], target_ids: &[usize]) -> f64 {
    let mut per_target = Vec::with_capacity(target_ids.len());
    for &id in target_ids {
        let (mut sum, mut count) = (0.0, 0usize);
        for (s, &wi) in samples.iter().zip(w) {
            if s.target_index == id {
                sum += wi;
                count += 1;
            }
        }
        if count > 0 {
            per_target.push(sum / count as f64);
        }
    }
    kish_n_eff(&per_target)
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

/// Fit a calibration model with the default calibration config.
pub fn fit(
    samples: &[CalibSample],
    px_per_degree: f64,
    display_fingerprint: impl Into<String>,
) -> Result<CalibrationModel, CalibrationError> {
    fit_with(samples, &CalibrationConfig::default(), px_per_degree, display_fingerprint)
}

/// Fit a calibration model and cross-validate it.
///
/// `px_per_degree` converts the reported error into degrees of visual angle;
/// `display_fingerprint` binds the model to the display layout it was fitted
/// against (ADR-0011). `cfg` decides whether tracking quality weights the fit
/// (ADR-0021).
pub fn fit_with(
    samples: &[CalibSample],
    cfg: &CalibrationConfig,
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
    let weights = sample_weights(samples, cfg);

    // Prefer held-out-target CV for λ. GCV is the fallback for runs with too
    // few targets to hold one out, and even then it is scored against the
    // target count rather than the sample count — samples from one fixation are
    // not independent observations, and pretending otherwise is what let the
    // model overfit catastrophically.
    let choice = match select_lambda_by_target(samples, tier, &target_ids, cfg) {
        Some((x, y)) => LambdaChoice::Fixed { x, y },
        None => LambdaChoice::Gcv { n_eff: effective_targets(samples, &weights, &target_ids) },
    };

    let (std, fx, fy) = fit_coefficients(samples, tier, &choice, cfg)?;

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
            // Refit with the *same* λ the final model uses. Re-selecting λ per
            // fold would report the accuracy of a model the user never gets.
            let Ok((fstd, ffx, ffy)) = fit_coefficients(&train, tier, &choice, cfg) else {
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
    //
    // Deliberately *unweighted*, unlike the fit. They answer "how much did your
    // head actually move while you calibrated", which is a fact about the
    // session, not about how much the fit trusted each frame — and `pose_drift`
    // compares a live pose against them to decide whether the user has left the
    // region the model saw at all.
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
        quality_weighted: cfg.quality_weighting,
        mean_weight: weights.iter().sum::<f64>() / weights.len().max(1) as f64,
        min_weight: weights.iter().copied().fold(f64::INFINITY, f64::min),
        effective_samples: kish_n_eff(&weights),
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

    /// Build the pathological case seen on real hardware: a weak gaze signal,
    /// many samples per fixation, and head pose that drifts *with* the target.
    ///
    /// The head drift is the trap. People lean toward whatever they are looking
    /// at, so pose correlates with target position across the fixation grid —
    /// which lets an under-regularized model explain the screen position with
    /// head pose instead of gaze. It fits the calibration set beautifully and
    /// generalizes not at all.
    fn head_confounded_samples(rng: &mut Rng, per_target: usize) -> Vec<CalibSample> {
        let mut out = Vec::new();
        let mut idx = 0;
        for iy in 0..3 {
            for ix in 0..3 {
                // A deliberately small gaze excursion — the measured span on
                // the hardware that motivated this was ~0.09, not the ~0.5 the
                // design assumes.
                let gx = (-0.045 + 0.045 * ix as f64) * 1.0;
                let gy = -0.026 + 0.026 * iy as f64;
                let target = ground_truth(gx * 11.0, gy * 19.0);
                for _ in 0..per_target {
                    let frame = GazeFrame {
                        t_ms: 0.0,
                        ok: true,
                        quality: 1.0,
                        // Noise comparable to a third of the whole signal span.
                        gx: gx + rng.noise(0.015),
                        gy: gy + rng.noise(0.012),
                        // Head pose tracks the target, the confound.
                        yaw: 0.15 * (ix as f64 - 1.0) + rng.noise(0.02),
                        pitch: -0.21 + 0.09 * (iy as f64 - 1.0) + rng.noise(0.02),
                        hx: 0.03 * (ix as f64 - 1.0) + rng.noise(0.005),
                        hy: 0.04 * (iy as f64 - 1.0) + rng.noise(0.005),
                        hz: 10.0 + rng.noise(0.5),
                        ..Default::default()
                    };
                    out.push(CalibSample { frame, target, target_index: idx });
                }
                idx += 1;
            }
        }
        out
    }

    /// The regression this whole change exists for.
    ///
    /// Real profile before the fix: λ/n ≈ 5.6e-6 on an 18-feature model, with
    /// coefficients of ±3000 px per standard deviation on a 1329 px screen —
    /// a single standard deviation of head pitch moved the prediction further
    /// than the entire display. GCV could not see it, because it scored 253
    /// correlated samples as 253 independent observations.
    #[test]
    fn a_weak_head_confounded_signal_does_not_produce_runaway_coefficients() {
        let mut rng = Rng(2024);
        let samples = head_confounded_samples(&mut rng, 25);
        let m = fit(&samples, 45.0, "test").unwrap();

        // Coefficients are px per standard deviation of a standardized feature.
        // Anything approaching the screen size means one ordinary movement can
        // fling the cursor across the display.
        let worst = m
            .beta_x
            .iter()
            .chain(m.beta_y.iter())
            .fold(0.0f64, |acc, b| acc.max(b.abs()));
        assert!(
            worst < 2000.0,
            "coefficients exploded: worst |beta| = {worst:.0} px/SD, lambdas {:.3e}/{:.3e}",
            m.lambda_x,
            m.lambda_y,
        );

        // And the chosen shrinkage must be real, not the grid floor.
        let ratio = m.lambda_x / samples.len() as f64;
        assert!(
            ratio > 1e-4,
            "lambda barely above zero ({ratio:.2e}) — this is the under-regularization bug",
        );
    }

    /// Append head-motion targets: gaze pinned to one dot while the head sweeps
    /// through a wide range (ADR-0015).
    ///
    /// This is what breaks the confound. Within these targets the head moves a
    /// long way while the answer does not move at all, which is direct evidence
    /// that head pose alone cannot determine screen position. Without them the
    /// correlation is unbreakable *by any fitter* — the information simply is
    /// not there — which is why the test below needs them and the runaway test
    /// above deliberately does without.
    fn with_head_motion(
        rng: &mut Rng,
        mut out: Vec<CalibSample>,
        per_target: usize,
    ) -> Vec<CalibSample> {
        let steps = [(1usize, 1usize), (0, 1), (2, 1), (1, 0)];
        for (k, &(ix, iy)) in steps.iter().enumerate() {
            let gx = -0.045 + 0.045 * ix as f64;
            let gy = -0.026 + 0.026 * iy as f64;
            let target = ground_truth(gx * 11.0, gy * 19.0);
            for j in 0..per_target {
                let t = (j as f64 / per_target as f64) - 0.5; // sweeps -0.5..0.5
                let frame = GazeFrame {
                    ok: true,
                    quality: 1.0,
                    gx: gx + rng.noise(0.015),
                    gy: gy + rng.noise(0.012),
                    yaw: 0.6 * t + rng.noise(0.02),
                    pitch: -0.21 + 0.35 * t + rng.noise(0.02),
                    hx: 0.12 * t + rng.noise(0.005),
                    hy: 0.10 * t + rng.noise(0.005),
                    hz: 10.0 + 1.5 * t + rng.noise(0.5),
                    ..Default::default()
                };
                out.push(CalibSample { frame, target, target_index: 9 + k });
            }
        }
        out
    }

    /// Head-pose terms must not out-weigh the gaze terms they are meant to
    /// merely correct. When they do, the model has learned "where you are
    /// sitting" instead of "where you are looking", which is exactly why the
    /// cursor stopped following gaze on real hardware.
    ///
    /// Note this requires the head-motion phase. An earlier version of this
    /// test omitted it and failed — correctly. With head pose perfectly
    /// correlated to target across the fixation grid and a gaze SNR of ~3, head
    /// pose really *is* the better predictor in that data, and ridge preferring
    /// it is the right answer to the wrong question. The confound lives in the
    /// collection protocol, not the fitter, which is precisely why ADR-0015
    /// exists.
    #[test]
    fn head_terms_do_not_dominate_when_the_head_motion_phase_runs() {
        let mut rng = Rng(77);
        let grid = head_confounded_samples(&mut rng, 25);
        let samples = with_head_motion(&mut rng, grid, 30);
        let m = fit(&samples, 45.0, "test").unwrap();
        if m.tier != FeatureTier::Full {
            return; // No head terms to compare against.
        }

        // Feature 0 is gx, 1 is gy; 5..=10 are the raw head-pose columns.
        let gaze = m.beta_x[0].abs().max(m.beta_y[1].abs());
        let head = (5..=10)
            .map(|j| m.beta_x[j].abs().max(m.beta_y[j].abs()))
            .fold(0.0f64, f64::max);

        assert!(
            head <= gaze * 2.0,
            "head-pose terms dominate: head {head:.0} vs gaze {gaze:.0} px/SD",
        );
    }

    /// λ must be chosen by holding out whole targets, not by scoring the
    /// training set — otherwise correlated within-fixation samples inflate the
    /// apparent evidence and buy flexibility the data does not support.
    #[test]
    fn more_samples_per_target_does_not_loosen_the_fit() {
        let mut rng = Rng(4242);
        let few = fit(&head_confounded_samples(&mut rng, 8), 45.0, "test").unwrap();
        let mut rng = Rng(4242);
        let many = fit(&head_confounded_samples(&mut rng, 40), 45.0, "test").unwrap();

        // Five times the frames from the same nine fixations is not five times
        // the evidence. The shrinkage should stay in the same neighbourhood
        // rather than collapsing toward zero.
        let r_few = few.lambda_x / (9.0 * 8.0);
        let r_many = many.lambda_x / (9.0 * 40.0);
        assert!(
            r_many > r_few / 100.0,
            "shrinkage collapsed as samples grew: {r_few:.2e} -> {r_many:.2e}",
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

    // -----------------------------------------------------------------------
    // Quality weighting (ADR-0021)
    // -----------------------------------------------------------------------

    fn unweighted() -> CalibrationConfig {
        CalibrationConfig { quality_weighting: false, ..Default::default() }
    }

    fn at_quality(mut samples: Vec<CalibSample>, q: f64) -> Vec<CalibSample> {
        for s in samples.iter_mut() {
            s.frame.quality = q;
        }
        samples
    }

    /// Everything about the fit itself, in the order a mismatch is easiest to
    /// read. Excludes the weight statistics, which are *supposed* to differ, and
    /// λ, which is reported in absolute units (ratio · Σw) and therefore moves
    /// with a uniform weight rescale even when the model does not.
    fn fit_guts(m: &CalibrationModel) -> Vec<f64> {
        let mut v = vec![m.intercept_x, m.intercept_y];
        v.extend(m.mean.iter().chain(&m.scale).chain(&m.beta_x).chain(&m.beta_y));
        v.extend(&m.report.per_target_error_px);
        v.push(m.report.mean_error_px);
        v.push(m.report.p95_error_px);
        v
    }

    /// **The regression guard.** Weighting is a generalization, not a change:
    /// with every weight at 1 the arithmetic must land on the same floating
    /// point numbers as ordinary least squares, not merely close to them.
    ///
    /// This is checked bit-for-bit rather than within a tolerance on purpose. A
    /// tolerance would pass just as happily if the weighted path had introduced
    /// a real but small bias, and a small bias in the fit is exactly the kind of
    /// defect that shows up months later as "calibration feels slightly off"
    /// with nothing to point at. `1.0 * x == x` exactly in IEEE 754 and Σ1.0
    /// over n terms is exactly n, so equality here is a property of the code,
    /// not luck.
    ///
    /// The other half of the guard is the rest of this file: every test above
    /// runs frames at quality 1.0 through the now-weighted path with weighting
    /// on by default, and none of their assertions moved.
    #[test]
    fn uniform_weights_reproduce_the_unweighted_fit_bit_for_bit() {
        let mut rng = Rng(31337);
        let samples = nine_point_samples(&mut rng, 0.006, 22);

        let plain = fit_with(&samples, &unweighted(), 45.0, "test").unwrap();
        let weighted = fit_with(&samples, &CalibrationConfig::default(), 45.0, "test").unwrap();

        assert_eq!(weighted.tier, plain.tier);
        assert_eq!(weighted.lambda_x.to_bits(), plain.lambda_x.to_bits());
        assert_eq!(weighted.lambda_y.to_bits(), plain.lambda_y.to_bits());
        for (i, (a, b)) in fit_guts(&weighted).iter().zip(fit_guts(&plain)).enumerate() {
            assert_eq!(
                a.to_bits(),
                b.to_bits(),
                "fit value {i} differs: weighted {a:?} vs unweighted {b:?}",
            );
        }
        // …and the report says which one the user got.
        assert!(weighted.report.quality_weighted);
        assert!(!plain.report.quality_weighted);
    }

    /// A session that simply tracked worse *overall* must be fitted the same
    /// way, not regularized differently.
    ///
    /// This is the reason λ is scaled by Σw rather than by the sample count: a
    /// uniform weight w scales G, c and yy by w together, so it cancels out of
    /// β entirely — but only if λ scales with it too. Scaling λ by n (or by
    /// n_eff, which is also n under uniform weights) would leave the shrinkage
    /// fixed while the data term shrank, and a user whose quality sat at 0.5 all
    /// session would silently get twice the regularization of one at 1.0 for no
    /// reason connected to their data.
    ///
    /// Not bit-exact, unlike the test above: Σ of n copies of 0.62 is not
    /// exactly 0.62n in floating point. The residual is at rounding level.
    #[test]
    fn a_uniformly_lower_quality_session_is_fitted_the_same_way() {
        let mut rng = Rng(31337);
        let samples = nine_point_samples(&mut rng, 0.006, 22);

        let plain = fit_with(&samples, &unweighted(), 45.0, "test").unwrap();
        let dimmer = fit_with(
            &at_quality(samples, 0.62),
            &CalibrationConfig::default(),
            45.0,
            "test",
        )
        .unwrap();

        for (i, (a, b)) in fit_guts(&dimmer).iter().zip(fit_guts(&plain)).enumerate() {
            let scale = a.abs().max(b.abs()).max(1.0);
            assert!(
                (a - b).abs() / scale < 1e-9,
                "fit value {i} moved under a uniform quality rescale: {a:?} vs {b:?}",
            );
        }
        // λ moved with Σw, so the *reported* λ is 0.62× the unweighted one even
        // though the model is identical. That is the ratio, not the shrinkage.
        assert!(dimmer.lambda_x < plain.lambda_x);
    }

    /// Mislabel part of one fixation — the user glanced away but the collector
    /// still tagged those frames with the target they were supposed to be
    /// looking at. This is the failure quality is a proxy for, and the whole
    /// point of the change is that it should hurt less when the tracker already
    /// said those frames were poor.
    ///
    /// Measured as the distance the *predictions* move, over a grid of probe
    /// points, rather than as coefficient norms: coefficients live in
    /// standardized units and a change in λ moves all of them at once, whereas
    /// what the user experiences is where the cursor lands.
    #[test]
    fn a_mislabelled_sample_perturbs_the_fit_less_when_its_quality_is_low() {
        let corrupt = |quality: f64| {
            let mut rng = Rng(808);
            let mut s = nine_point_samples(&mut rng, 0.004, 25);
            // The centre target's last 8 frames: gaze is off at a corner while
            // the label still says centre.
            for sample in s.iter_mut().filter(|s| s.target_index == 4).skip(17) {
                sample.frame.gx = 0.30;
                sample.frame.gy = -0.30;
                sample.frame.quality = quality;
            }
            s
        };

        let mut rng = Rng(808);
        let clean = fit(&nine_point_samples(&mut rng, 0.004, 25), 45.0, "test").unwrap();
        let trusted = fit(&corrupt(1.0), 45.0, "test").unwrap();
        let doubted = fit(&corrupt(0.4), 45.0, "test").unwrap();

        // How far each corrupted fit drags the cursor away from the clean one.
        let drift = |m: &CalibrationModel| {
            let mut sum = 0.0;
            let mut n = 0.0;
            for iy in 0..5 {
                for ix in 0..5 {
                    let f = GazeFrame {
                        ok: true,
                        quality: 1.0,
                        gx: -0.25 + 0.125 * ix as f64,
                        gy: -0.25 + 0.125 * iy as f64,
                        ..Default::default()
                    };
                    sum += m.predict(&f).distance_to(clean.predict(&f));
                    n += 1.0;
                }
            }
            sum / n
        };

        let (bad_trusted, bad_doubted) = (drift(&trusted), drift(&doubted));
        // The corruption has to actually matter, or the comparison is vacuous.
        assert!(
            bad_trusted > 20.0,
            "the mislabelled frames barely moved the fit: {bad_trusted:.1} px",
        );
        // Measured at ~61 px trusted vs ~29 px doubted — close to the 2.5:1 the
        // weights imply. The margin here is loose because λ is chosen from a
        // discrete grid and can step between the two fits.
        assert!(
            bad_doubted < 0.75 * bad_trusted,
            "low-quality mislabelled frames did not hurt materially less: \
             {bad_doubted:.1} px vs {bad_trusted:.1} px",
        );
    }

    /// The floor is what makes this a discount rather than a deletion. A sample
    /// that cleared the admission gate has been judged usable; if the fit then
    /// gave it a weight of ~0 we would be silently overruling that decision, and
    /// at a low enough gate a whole target could vanish and take the fit's
    /// ability to identify that region of the screen with it.
    #[test]
    fn the_weight_floor_bounds_how_far_a_marginal_sample_is_discounted() {
        let mut rng = Rng(64);
        let mut samples = nine_point_samples(&mut rng, 0.004, 22);
        for s in samples.iter_mut().filter(|s| s.target_index == 0) {
            s.frame.quality = 0.02; // far below the floor
        }
        let m = fit(&samples, 45.0, "test").unwrap();
        assert_eq!(m.report.min_weight, CalibrationConfig::default().weight_floor);
        assert!(m.report.mean_error_px.is_finite());
    }

    /// The report has to be able to answer "were my samples any good?", because
    /// the alternative diagnosis for a mediocre held-out error — bad fit, bad
    /// data, or bad session — is otherwise invisible to the user.
    #[test]
    fn the_report_surfaces_the_weight_distribution() {
        let mut rng = Rng(1717);
        let mut samples = nine_point_samples(&mut rng, 0.004, 20);
        for (i, s) in samples.iter_mut().enumerate() {
            s.frame.quality = if i % 4 == 0 { 0.45 } else { 0.95 };
        }
        let m = fit(&samples, 45.0, "test").unwrap();

        assert!(m.report.quality_weighted);
        assert_eq!(m.report.min_weight, 0.45);
        assert!((m.report.mean_weight - 0.825).abs() < 1e-12);
        // Uneven weights, so the set is worth fewer than its frame count…
        assert!(m.report.effective_samples < m.report.samples as f64);
        // …but not dramatically fewer, since the spread is bounded.
        assert!(m.report.effective_samples > 0.9 * m.report.samples as f64);

        // A uniform session is worth exactly what it collected.
        let even = fit(&at_quality(samples, 0.7), 45.0, "test").unwrap();
        assert!(
            (even.report.effective_samples - even.report.samples as f64).abs() < 1e-9,
            "uniform weights should give back the sample count, got {}",
            even.report.effective_samples,
        );
    }

    /// GCV's denominator counts *independent observations*, which ADR-0019
    /// established is the target count rather than the frame count. Weighting
    /// refines that count without changing what it counts: a target collected
    /// entirely at poor quality is less than a whole observation, but a target
    /// that merely contributed more frames is not more than one.
    #[test]
    fn the_effective_observation_count_is_targets_not_frames() {
        let mut rng = Rng(5150);
        let mut samples = nine_point_samples(&mut rng, 0.004, 20);
        // Target 7 gets twice the frames of everyone else, at the same quality.
        let extra: Vec<CalibSample> =
            samples.iter().copied().filter(|s| s.target_index == 7).collect();
        samples.extend(extra);
        let ids: Vec<usize> = (0..9).collect();

        let cfg = CalibrationConfig::default();
        let w = sample_weights(&samples, &cfg);
        assert!(
            (effective_targets(&samples, &w, &ids) - 9.0).abs() < 1e-12,
            "extra frames from one fixation must not buy extra observations",
        );

        // Now make target 3 marginal throughout. It should count as a fraction
        // of an observation, and the fit should therefore be told it has less
        // evidence than nine clean fixations would give it.
        for s in samples.iter_mut().filter(|s| s.target_index == 3) {
            s.frame.quality = 0.4;
        }
        let w = sample_weights(&samples, &cfg);
        let n_eff = effective_targets(&samples, &w, &ids);
        assert!(n_eff < 9.0 && n_eff > 8.0, "n_eff {n_eff} left the sensible range");
    }

    /// The GCV fallback path — too few targets to hold one out — still has to
    /// produce a usable model once its observation count is a fraction.
    #[test]
    fn the_gcv_fallback_still_fits_when_weights_are_uneven() {
        let mut rng = Rng(2718);
        let mut samples = nine_point_samples(&mut rng, 0.004, 30);
        samples.retain(|s| s.target_index < 3);
        for s in samples.iter_mut().filter(|s| s.target_index == 1) {
            s.frame.quality = 0.4;
        }
        let m = fit(&samples, 45.0, "test").unwrap();
        assert!(!m.report.cross_validated, "3 targets cannot be cross-validated");
        assert!(m.report.mean_error_px.is_finite());
        assert!(m.lambda_x > 0.0 && m.lambda_y > 0.0);
    }
}
