//! The fitted gaze→screen map and its feature expansion (ADR-0006).

use crate::frame::GazeFrame;
use crate::math::Vec2;

/// Upper bound on expanded feature count, so the hot path can expand into a
/// stack array and never allocate.
pub const MAX_FEATURES: usize = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureTier {
    /// Gaze terms only. Used for 5-point calibration, where there are too few
    /// distinct fixation locations to identify head-compensation terms.
    Basic,
    /// Gaze terms plus head pose and gaze×head cross terms. The cross terms are
    /// what buy head-movement tolerance.
    Full,
}

impl FeatureTier {
    pub const fn len(self) -> usize {
        match self {
            FeatureTier::Basic => 5,
            FeatureTier::Full => 18,
        }
    }

    pub const fn is_empty(self) -> bool {
        false
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FeatureTier::Basic => "basic",
            FeatureTier::Full => "full",
        }
    }

    /// Choose a tier from what was actually collected. `Full` needs enough
    /// distinct fixation locations *and* enough samples; otherwise the extra
    /// coefficients are fit to noise.
    pub fn select(targets: usize, samples: usize) -> Self {
        if targets >= 9 && samples >= 150 {
            FeatureTier::Full
        } else {
            FeatureTier::Basic
        }
    }
}

/// Expand a frame into the design vector. The constant term is *not* included:
/// the intercept is handled by centering the targets during the fit, which
/// avoids the special case of an unpenalized column in ridge regression.
pub fn expand(f: &GazeFrame, tier: FeatureTier) -> ([f64; MAX_FEATURES], usize) {
    let mut o = [0.0f64; MAX_FEATURES];
    let (gx, gy) = (f.gx, f.gy);

    // Gaze terms. The quadratic terms capture the tangent-like curvature of the
    // iris-offset → screen-angle relationship past ~15° eccentricity.
    o[0] = gx;
    o[1] = gy;
    o[2] = gx * gx;
    o[3] = gy * gy;
    o[4] = gx * gy;

    if tier == FeatureTier::Basic {
        return (o, 5);
    }

    o[5] = f.yaw;
    o[6] = f.pitch;
    o[7] = f.roll;
    o[8] = f.hx;
    o[9] = f.hy;
    o[10] = f.hz;
    // Gaze × head cross terms: the screen position for a given iris offset
    // genuinely depends on head pose, and it does so multiplicatively.
    o[11] = gx * f.yaw;
    o[12] = gy * f.pitch;
    o[13] = gx * f.hx;
    o[14] = gy * f.hy;
    o[15] = gx * f.hz;
    o[16] = gy * f.hz;
    o[17] = f.dgx;

    (o, 18)
}

/// A fitted calibration: standardization parameters plus one coefficient
/// vector per screen axis.
#[derive(Debug, Clone, PartialEq)]
pub struct CalibrationModel {
    pub tier: FeatureTier,
    /// Per-feature mean, from the calibration set.
    pub mean: Vec<f64>,
    /// Per-feature standard deviation. A near-constant feature gets scale 1.0
    /// and a centered value of ~0, so ridge drives its coefficient to zero —
    /// this is how the model degrades gracefully when the user sat perfectly
    /// still during calibration (ADR-0006).
    pub scale: Vec<f64>,
    pub beta_x: Vec<f64>,
    pub beta_y: Vec<f64>,
    /// Mean target coordinate — the intercept.
    pub intercept_x: f64,
    pub intercept_y: f64,
    pub lambda_x: f64,
    pub lambda_y: f64,
    pub report: CalibrationReport,
    /// Identifies the display layout this model was fitted against. Because we
    /// regress directly to screen pixels, the fit is only valid for this
    /// layout (ADR-0006, ADR-0011).
    pub display_fingerprint: String,
    /// Mean head pose during calibration: yaw, pitch, roll, hx, hy, hz.
    pub pose_mean: Vec<f64>,
    /// Head-pose spread during calibration.
    ///
    /// This is what makes the difference between a model that compensates for
    /// head movement and one that cannot: if these are ~0, the user held still
    /// and ridge correctly zeroed the head-compensation coefficients, so the
    /// model is only valid at that one pose (ADR-0015).
    pub pose_std: Vec<f64>,
}

/// Minimum spread we will divide by, per pose feature. Without these floors a
/// user who sat perfectly still would produce a divide-by-almost-zero and every
/// tiny movement would read as enormous drift.
pub const POSE_STD_FLOOR: [f64; 6] = [
    0.035, // yaw, rad (~2°)
    0.035, // pitch
    0.035, // roll
    0.012, // hx, normalized frame units
    0.012, // hy
    0.35,  // hz, inverse interocular
];

impl CalibrationModel {
    /// Map a frame to a screen point. Allocation-free.
    pub fn predict(&self, f: &GazeFrame) -> Vec2 {
        let (phi, n) = expand(f, self.tier);
        let mut x = self.intercept_x;
        let mut y = self.intercept_y;
        for (j, &p) in phi.iter().take(n).enumerate() {
            let z = (p - self.mean[j]) / self.scale[j];
            x += self.beta_x[j] * z;
            y += self.beta_y[j] * z;
        }
        Vec2::new(x, y)
    }

    /// How far the current head pose is from the pose the model was calibrated
    /// at, in standard deviations of the calibration data.
    ///
    /// Above ~3 the prediction is extrapolating and accuracy degrades. Surfaced
    /// in the HUD so "it worked a moment ago" has a visible explanation rather
    /// than being a mystery (ADR-0015).
    pub fn pose_drift(&self, f: &GazeFrame) -> f64 {
        if self.pose_mean.len() < 6 || self.pose_std.len() < 6 {
            return 0.0;
        }
        let pose = f.pose();
        let mut worst = 0.0f64;
        for i in 0..6 {
            let std = self.pose_std[i].max(POSE_STD_FLOOR[i]);
            let z = (pose[i] - self.pose_mean[i]).abs() / std;
            worst = worst.max(z);
        }
        worst
    }

    /// Whether the fit actually contains head compensation. False when the user
    /// held still during calibration, which is the common case and the usual
    /// explanation for "turning my head breaks it".
    pub fn has_head_compensation(&self) -> bool {
        if self.tier != FeatureTier::Full || self.pose_std.len() < 6 {
            return false;
        }
        // Rotation spread of at least ~3° in yaw or pitch means the cross terms
        // had something real to fit.
        self.pose_std[0] > 0.05 || self.pose_std[1] > 0.05
    }
}

/// Held-out accuracy, computed by leave-one-target-out cross-validation.
/// Training error on a ridge fit is not an accuracy estimate, so this is the
/// number shown to the user.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CalibrationReport {
    pub tier_name: String,
    pub samples: usize,
    pub targets: usize,
    pub mean_error_px: f64,
    pub p95_error_px: f64,
    pub mean_error_deg: f64,
    pub per_target_error_px: Vec<f64>,
    pub lambda_x: f64,
    pub lambda_y: f64,
    /// False when there were too few targets to hold one out, in which case the
    /// errors above are training errors and are optimistic.
    pub cross_validated: bool,

    // --- sample weighting (ADR-0021) ---
    /// Whether tracking quality weighted the fit. False means every admitted
    /// sample counted the same, the pre-ADR-0021 behaviour.
    pub quality_weighted: bool,
    /// Mean regression weight. With weighting on this is the mean tracking
    /// quality of the samples that survived the gate and the outlier filter, so
    /// it is the one number that answers "were my samples mostly good?".
    pub mean_weight: f64,
    /// The weight of the worst sample that still made it into the fit. A value
    /// at the floor means at least one frame was scraped in barely above
    /// `min_quality`.
    pub min_weight: f64,
    /// Kish's effective sample size, `(Σw)² / Σw²`.
    ///
    /// How many evenly-weighted frames carry the same information as the
    /// weighted set. Compared against `samples` it is the single number that
    /// says whether the weight spread was material at all: 250 of 253 means the
    /// session was uniformly good and weighting changed nothing; 180 of 253
    /// means a substantial part of the data was being trusted far less than the
    /// rest.
    pub effective_samples: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_tier_expands_only_gaze_terms() {
        let f = GazeFrame { gx: 2.0, gy: 3.0, yaw: 9.0, ..Default::default() };
        let (o, n) = expand(&f, FeatureTier::Basic);
        assert_eq!(n, 5);
        assert_eq!(&o[..5], &[2.0, 3.0, 4.0, 9.0, 6.0]);
        // Head terms must not leak into the basic expansion.
        assert_eq!(o[5], 0.0);
    }

    #[test]
    fn full_tier_includes_cross_terms() {
        let f = GazeFrame { gx: 2.0, gy: 3.0, yaw: 5.0, pitch: 7.0, ..Default::default() };
        let (o, n) = expand(&f, FeatureTier::Full);
        assert_eq!(n, 18);
        assert_eq!(o[11], 2.0 * 5.0); // gx·yaw
        assert_eq!(o[12], 3.0 * 7.0); // gy·pitch
    }

    #[test]
    fn tier_selection_requires_nine_targets_and_enough_samples() {
        assert_eq!(FeatureTier::select(9, 300), FeatureTier::Full);
        assert_eq!(FeatureTier::select(5, 300), FeatureTier::Basic);
        assert_eq!(FeatureTier::select(9, 20), FeatureTier::Basic);
    }

    #[test]
    fn expansion_never_exceeds_max_features() {
        let f = GazeFrame::default();
        let (_, n) = expand(&f, FeatureTier::Full);
        assert!(n <= MAX_FEATURES);
    }
}
