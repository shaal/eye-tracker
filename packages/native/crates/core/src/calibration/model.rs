//! The fitted gaze→screen map and its feature expansion (ADR-0006).

use crate::frame::GazeFrame;
use crate::math::Vec2;

/// Upper bound on expanded feature count, so the hot path can expand into a
/// stack array and never allocate.
pub const MAX_FEATURES: usize = 20;

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

/// Which reference the `gy` column is measured against (ADR-0025).
///
/// This is a property of the *data*, not of the fit, which is why a fitted
/// model carries it: a profile fitted on corner-relative `gy` predicts nonsense
/// if replayed against aperture-relative frames, and the two are numerically
/// similar enough that the failure would look like drift rather than like a
/// mismatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerticalBasis {
    /// The eye-corner midpoint — ADR-0005's original definition. Anchored to
    /// the socket, so it does not move when the lid drops.
    Corner,
    /// The midpoint of the upper- and lower-lid margins. Moves with the lid, so
    /// lid-driven displacement of the iris estimate cancels out.
    Aperture,
}

impl VerticalBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            VerticalBasis::Corner => "corner",
            VerticalBasis::Aperture => "aperture",
        }
    }

    /// Not `from_str`: that would shadow `std::str::FromStr::from_str` at call
    /// sites without implementing the trait.
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "corner" => Some(VerticalBasis::Corner),
            "aperture" => Some(VerticalBasis::Aperture),
            _ => None,
        }
    }
}

/// Openness below which the normalizer is treated as unusable.
///
/// `open_ref` is a high percentile of the eye-aspect ratio over the calibration
/// set, which for an ordinary session lands near 0.3. A value at or under this
/// floor means the user's eyes were effectively shut throughout, and dividing by
/// it would turn ordinary lid noise into a feature with enormous leverage.
const OPEN_REF_FLOOR: f64 = 0.02;

/// Ceiling on the normalized openness `o`.
///
/// `open_ref` is the 90th percentile, so a live frame can legitimately exceed it
/// and `o` slightly over 1 is normal and wanted. The clamp only stops a
/// pathological `open_ref` — one target's worth of usable frames in an otherwise
/// squinting session — from letting a single wide-eyed frame dominate a column
/// the fit has standardized to unit variance.
const OPEN_MAX: f64 = 2.0;

/// The exact feature semantics a model was fitted under (ADR-0025).
///
/// Bundled into one value rather than passed as three arguments because every
/// caller of `expand` — the fit, each cross-validation fold, and `predict` —
/// must use *identical* semantics, and a bundle makes that a type-level
/// obligation instead of a convention.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Expansion {
    pub tier: FeatureTier,
    /// Which frame field the `gy` column reads.
    pub basis: VerticalBasis,
    /// Calibration-time openness normalizer, or `None` for no openness terms.
    ///
    /// Carrying the value rather than a bool is what makes a stored profile
    /// self-describing: `o` is meaningless without the scale it was divided by,
    /// and that scale is a fact about the calibration session.
    pub open_ref: Option<f64>,
}

impl Expansion {
    /// The pre-ADR-0025 semantics, and what an unversioned stored profile means.
    pub const fn legacy(tier: FeatureTier) -> Self {
        Self { tier, basis: VerticalBasis::Corner, open_ref: None }
    }

    /// Whether the openness terms are present. Only ever true for `Full`: the
    /// `Basic` tier exists precisely because a 5-point run has too few distinct
    /// fixations to identify extra coefficients, and spending two of them on
    /// openness would be the same mistake in a new place.
    pub fn has_openness(&self) -> bool {
        self.tier == FeatureTier::Full && self.open_ref.is_some()
    }

    pub fn len(&self) -> usize {
        self.tier.len() + if self.has_openness() { 2 } else { 0 }
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// The vertical iris offset this expansion reads.
    #[inline]
    pub fn gy_of(&self, f: &GazeFrame) -> f64 {
        match self.basis {
            VerticalBasis::Corner => f.gy,
            VerticalBasis::Aperture => f.gy_aperture,
        }
    }
}

/// Normalized openness: the worse eye's aspect ratio over the calibration-time
/// reference.
///
/// `min` rather than the mean because occlusion risk is set by the *more*
/// occluded eye — the vertical estimate is already the average of two eyes, so
/// one lid covering an iris corrupts half the signal regardless of how open the
/// other eye is. Raw EAR is deliberately not used: it varies by roughly a factor
/// of two across people and with camera distance, so a coefficient fitted on it
/// would be partly a coefficient on face shape.
#[inline]
pub fn normalized_openness(f: &GazeFrame, open_ref: f64) -> f64 {
    let worst = f.open_left.min(f.open_right);
    (worst / open_ref.max(OPEN_REF_FLOOR)).clamp(0.0, OPEN_MAX)
}

/// Expand a frame into the design vector. The constant term is *not* included:
/// the intercept is handled by centering the targets during the fit, which
/// avoids the special case of an unpenalized column in ridge regression.
///
/// The openness terms are appended at the end rather than inserted next to the
/// gaze terms they modify. That is deliberate: every other column keeps the
/// index it had before ADR-0025, so a coefficient vector is still readable
/// against the same table and a stored profile's leading 18 entries still mean
/// what they meant.
pub fn expand(f: &GazeFrame, e: &Expansion) -> ([f64; MAX_FEATURES], usize) {
    let mut o = [0.0f64; MAX_FEATURES];
    let gx = f.gx;
    let gy = e.gy_of(f);

    // Gaze terms. The quadratic terms capture the tangent-like curvature of the
    // iris-offset → screen-angle relationship past ~15° eccentricity.
    o[0] = gx;
    o[1] = gy;
    o[2] = gx * gx;
    o[3] = gy * gy;
    o[4] = gx * gy;

    if e.tier == FeatureTier::Basic {
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

    if !e.has_openness() {
        return (o, 18);
    }

    // Stage 1 of ADR-0025, and at most two columns because the effective sample
    // size is ~9 targets, not the ~180 frames they were collected over.
    //
    // The interaction is the point. An additive `o` alone only says "a more
    // closed eye shifts the cursor by a constant", which cannot undo a
    // non-monotonic mapping; `gy·o` says openness changes what `gy` *means*,
    // which is the actual claim about lid occlusion.
    let op = normalized_openness(f, e.open_ref.unwrap_or(1.0));
    o[18] = op;
    o[19] = gy * op;

    (o, 20)
}

/// Columns dropped from the *vertical* fit under an axis-specific expansion
/// (ADR-0025).
///
/// All four carry horizontal information that has little to say about screen y:
/// `gx` and `gx·yaw` are odd in horizontal gaze, `dgx` is a vergence proxy, and
/// `roll` is already compensated for by construction in ADR-0005's eye-local
/// basis. With ~9 effective observations against 18 columns, a column that
/// cannot help can still hurt — it is one more direction for the fit to spend
/// evidence on.
///
/// `gx²` and `gx·gy` are deliberately *kept*: they are even and mixed in
/// horizontal gaze respectively, and both encode real geometric coupling
/// between where you look horizontally and where the screen point is
/// vertically.
pub const VERTICAL_DROPPED: [usize; 4] = [
    0,  // gx
    7,  // roll
    11, // gx·yaw
    17, // dgx
];

/// The column indices one axis is fitted on, ascending.
///
/// `drop_horizontal` is only honoured for the `Full` tier: in `Basic` the
/// dropped indices either do not exist or are most of the model.
pub fn active_columns(e: &Expansion, drop_horizontal: bool) -> Vec<usize> {
    let n = e.len();
    if !drop_horizontal || e.tier != FeatureTier::Full {
        return (0..n).collect();
    }
    (0..n).filter(|j| !VERTICAL_DROPPED.contains(j)).collect()
}

/// A fitted calibration: standardization parameters plus one coefficient
/// vector per screen axis.
#[derive(Debug, Clone, PartialEq)]
pub struct CalibrationModel {
    /// The feature semantics this model was fitted under (ADR-0025). Carried on
    /// the model, not read from the live config, so that changing the switch
    /// cannot silently reinterpret an already-fitted profile.
    pub expansion: Expansion,
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
    pub fn tier(&self) -> FeatureTier {
        self.expansion.tier
    }

    /// Map a frame to a screen point. Allocation-free.
    pub fn predict(&self, f: &GazeFrame) -> Vec2 {
        let (phi, n) = expand(f, &self.expansion);
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
        if self.expansion.tier != FeatureTier::Full || self.pose_std.len() < 6 {
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

    // --- vertical feature semantics (ADR-0025) ---
    /// Which reference the `gy` column was measured against.
    pub vertical_basis: String,
    /// Whether the openness terms `o` and `gy·o` were in the expansion.
    pub openness_terms: bool,
    /// Whether the vertical axis was fitted on a reduced column set.
    pub axis_specific: bool,
    /// The openness normalizer, or NaN when the openness terms were off. A
    /// value far from the usual ~0.3 says the session was squinting throughout,
    /// which makes every openness coefficient suspect.
    pub open_ref: f64,
    /// Predicted vertical spread over the calibration targets, as a fraction of
    /// the targets' own vertical spread.
    ///
    /// **The diagnostic #57 asked for.** A working vertical channel returns
    /// something in the region of 0.6–1.0; the session that motivated ADR-0025
    /// returned 0.03, meaning the model answered with a constant however far the
    /// user looked. Mean error cannot distinguish that from an ordinary bad fit,
    /// and this can.
    pub vertical_range_fraction: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_tier_expands_only_gaze_terms() {
        let f = GazeFrame { gx: 2.0, gy: 3.0, yaw: 9.0, ..Default::default() };
        let (o, n) = expand(&f, &Expansion::legacy(FeatureTier::Basic));
        assert_eq!(n, 5);
        assert_eq!(&o[..5], &[2.0, 3.0, 4.0, 9.0, 6.0]);
        // Head terms must not leak into the basic expansion.
        assert_eq!(o[5], 0.0);
    }

    #[test]
    fn full_tier_includes_cross_terms() {
        let f = GazeFrame { gx: 2.0, gy: 3.0, yaw: 5.0, pitch: 7.0, ..Default::default() };
        let (o, n) = expand(&f, &Expansion::legacy(FeatureTier::Full));
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
        let e = Expansion {
            tier: FeatureTier::Full,
            basis: VerticalBasis::Aperture,
            open_ref: Some(0.3),
        };
        let (_, n) = expand(&f, &e);
        assert_eq!(n, e.len());
        assert!(n <= MAX_FEATURES);
    }

    // -----------------------------------------------------------------------
    // Vertical feature semantics (ADR-0025)
    // -----------------------------------------------------------------------

    /// The vertical basis selects which *frame field* the `gy` column reads, and
    /// it must reach every derived term too — `gy²`, `gx·gy` and the head cross
    /// terms are all built from it. A switch that only reached `o[1]` would
    /// leave two thirds of the vertical model on the old reference.
    #[test]
    fn the_aperture_basis_reaches_every_column_derived_from_gy() {
        let f = GazeFrame {
            gx: 2.0,
            gy: 3.0,
            gy_aperture: 5.0,
            pitch: 7.0,
            hy: 11.0,
            hz: 13.0,
            ..Default::default()
        };
        let corner = expand(&f, &Expansion::legacy(FeatureTier::Full)).0;
        let aperture = expand(
            &f,
            &Expansion { tier: FeatureTier::Full, basis: VerticalBasis::Aperture, open_ref: None },
        )
        .0;

        assert_eq!(corner[1], 3.0);
        assert_eq!(aperture[1], 5.0);
        assert_eq!(aperture[3], 25.0); // gy²
        assert_eq!(aperture[4], 2.0 * 5.0); // gx·gy
        assert_eq!(aperture[12], 5.0 * 7.0); // gy·pitch
        assert_eq!(aperture[14], 5.0 * 11.0); // gy·hy
        assert_eq!(aperture[16], 5.0 * 13.0); // gy·hz
        // Columns that do not involve gy are untouched by the basis.
        assert_eq!(corner[0], aperture[0]);
        assert_eq!(corner[11], aperture[11]);
    }

    /// The openness pair is exactly two columns, appended, and the interaction —
    /// not the additive term — is what carries the claim.
    #[test]
    fn the_openness_terms_add_two_columns_and_leave_the_others_in_place() {
        let f = GazeFrame {
            gx: 2.0,
            gy: 3.0,
            open_left: 0.15,
            open_right: 0.30,
            ..Default::default()
        };
        let e = Expansion {
            tier: FeatureTier::Full,
            basis: VerticalBasis::Corner,
            open_ref: Some(0.30),
        };
        let (with, n) = expand(&f, &e);
        let (without, m) = expand(&f, &Expansion::legacy(FeatureTier::Full));

        assert_eq!(n, 20);
        assert_eq!(m, 18);
        assert_eq!(&with[..18], &without[..18]);
        // The worse eye sets it: 0.15 / 0.30, not the mean 0.225 / 0.30.
        assert_eq!(with[18], 0.5);
        assert_eq!(with[19], 3.0 * 0.5);
    }

    /// A 5-point run has too few distinct fixations to identify the terms
    /// `Basic` already omits, so it must not acquire two more.
    #[test]
    fn the_basic_tier_never_takes_the_openness_terms() {
        let e = Expansion {
            tier: FeatureTier::Basic,
            basis: VerticalBasis::Corner,
            open_ref: Some(0.3),
        };
        assert!(!e.has_openness());
        assert_eq!(e.len(), 5);
        assert_eq!(expand(&GazeFrame::default(), &e).1, 5);
    }

    /// A session where the eyes never opened would otherwise divide by ~0 and
    /// hand a standardized column enormous leverage.
    #[test]
    fn normalized_openness_is_bounded_at_both_ends() {
        let shut = GazeFrame { open_left: 0.0, open_right: 0.4, ..Default::default() };
        assert_eq!(normalized_openness(&shut, 0.3), 0.0);

        let wide = GazeFrame { open_left: 0.9, open_right: 0.9, ..Default::default() };
        assert_eq!(normalized_openness(&wide, 1e-9), OPEN_MAX);

        // A frame slightly wider open than the 90th percentile is normal and is
        // deliberately *not* clamped to 1.
        let ordinary = GazeFrame { open_left: 0.33, open_right: 0.36, ..Default::default() };
        assert!((normalized_openness(&ordinary, 0.30) - 1.1).abs() < 1e-12);
    }

    #[test]
    fn the_vertical_column_set_drops_only_the_horizontal_nuisance_terms() {
        let e = Expansion::legacy(FeatureTier::Full);
        assert_eq!(active_columns(&e, false), (0..18).collect::<Vec<_>>());

        let reduced = active_columns(&e, true);
        assert_eq!(reduced.len(), 14);
        for j in VERTICAL_DROPPED {
            assert!(!reduced.contains(&j), "column {j} should have been dropped");
        }
        // The gaze terms that genuinely couple the two axes stay.
        for j in [1usize, 2, 3, 4, 12, 14, 16] {
            assert!(reduced.contains(&j), "column {j} should have been kept");
        }

        // Inert for the basic tier, where three of the four indices do not
        // exist and the fourth is a fifth of the model.
        assert_eq!(
            active_columns(&Expansion::legacy(FeatureTier::Basic), true),
            (0..5).collect::<Vec<_>>()
        );
    }

    /// The two switches are independently toggleable, so the reduction has to be
    /// defined on whatever width the expansion actually has. The openness pair
    /// is appended past every dropped index, which makes it easy to write a
    /// reduction that silently truncates them instead — and the loss would look
    /// like ridge deciding openness did not matter.
    #[test]
    fn the_vertical_column_set_keeps_the_openness_pair_when_both_switches_are_on() {
        let e = Expansion {
            tier: FeatureTier::Full,
            basis: VerticalBasis::Aperture,
            open_ref: Some(0.3),
        };
        assert_eq!(e.len(), 20);

        let reduced = active_columns(&e, true);
        assert_eq!(reduced.len(), 16, "20 columns less the 4 horizontal ones");
        assert!(reduced.contains(&18), "the openness term must survive the reduction");
        assert!(reduced.contains(&19), "and so must its interaction with gy");
        for j in VERTICAL_DROPPED {
            assert!(!reduced.contains(&j), "column {j} should still have been dropped");
        }
    }
}
