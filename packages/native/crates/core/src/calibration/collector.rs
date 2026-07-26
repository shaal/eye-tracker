//! Calibration sample collection and outlier rejection (ADR-0006).

use super::fit::{fit_with, CalibSample, CalibrationError};
use super::model::CalibrationModel;
use crate::config::CalibrationConfig;
use crate::frame::GazeFrame;
use crate::math::Vec2;

/// Samples further than this many MADs from the per-target median are dropped.
const MAD_REJECT: f64 = 3.0;
/// Floor on the MAD so a very consistent target does not reject everything on
/// floating-point noise.
const MAD_FLOOR: f64 = 1e-4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRejection {
    Accepted,
    /// A blink was in progress; the eyelid corrupts the gaze estimate.
    Blinking,
    /// Tracking confidence too low.
    LowQuality,
    /// No face in the frame.
    NoFace,
    UnknownTarget,
}

/// One collected sample, reduced to what the debug scatter plot needs.
///
/// The point of exposing this is diagnostic: if the per-target clusters overlap
/// in (gx, gy) space, no regression can separate them and the calibration was
/// doomed before `fit()` ran. That is a completely different message to the
/// user than "poor calibration, try again".
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScatterPoint {
    pub gx: f64,
    pub gy: f64,
    pub target_index: usize,
    /// False when the MAD filter dropped this sample as an outlier.
    pub kept: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Collector {
    targets: Vec<Vec2>,
    samples: Vec<CalibSample>,
    rejected: usize,
}

impl Collector {
    pub fn new(targets: Vec<Vec2>) -> Self {
        Self { targets, samples: Vec::new(), rejected: 0 }
    }

    pub fn targets(&self) -> &[Vec2] {
        &self.targets
    }

    pub fn accepted_count(&self) -> usize {
        self.samples.len()
    }

    pub fn rejected_count(&self) -> usize {
        self.rejected
    }

    pub fn count_for(&self, target_index: usize) -> usize {
        self.samples.iter().filter(|s| s.target_index == target_index).count()
    }

    /// Offer one frame as a sample for `target_index`.
    pub fn add(
        &mut self,
        target_index: usize,
        frame: GazeFrame,
        blinking: bool,
        min_quality: f64,
    ) -> SampleRejection {
        let Some(&target) = self.targets.get(target_index) else {
            return SampleRejection::UnknownTarget;
        };
        // Rejection order matters only for the reason reported back to the UI.
        let reason = if !frame.ok {
            SampleRejection::NoFace
        } else if blinking {
            SampleRejection::Blinking
        } else if frame.quality < min_quality {
            SampleRejection::LowQuality
        } else {
            SampleRejection::Accepted
        };

        if reason != SampleRejection::Accepted {
            self.rejected += 1;
            return reason;
        }

        self.samples.push(CalibSample { frame, target, target_index });
        SampleRejection::Accepted
    }

    /// Tag every sample with whether the MAD filter keeps it.
    ///
    /// The keep/drop decision and the scatter plot must agree exactly, so both
    /// are derived from this one pass rather than from two copies of the same
    /// threshold logic.
    fn partition(&self) -> Vec<(CalibSample, bool)> {
        let mut out = Vec::with_capacity(self.samples.len());

        for (idx, _) in self.targets.iter().enumerate() {
            let group: Vec<&CalibSample> =
                self.samples.iter().filter(|s| s.target_index == idx).collect();
            if group.len() < 5 {
                // Too few to estimate a spread; keep them all.
                out.extend(group.iter().map(|s| (**s, true)));
                continue;
            }

            let med_x = median(&mut group.iter().map(|s| s.frame.gx).collect::<Vec<_>>());
            let med_y = median(&mut group.iter().map(|s| s.frame.gy).collect::<Vec<_>>());
            let mad_x = median(
                &mut group.iter().map(|s| (s.frame.gx - med_x).abs()).collect::<Vec<_>>(),
            )
            .max(MAD_FLOOR);
            let mad_y = median(
                &mut group.iter().map(|s| (s.frame.gy - med_y).abs()).collect::<Vec<_>>(),
            )
            .max(MAD_FLOOR);

            for s in group {
                let dx = (s.frame.gx - med_x).abs() / mad_x;
                let dy = (s.frame.gy - med_y).abs() / mad_y;
                out.push((*s, dx <= MAD_REJECT && dy <= MAD_REJECT));
            }
        }

        out
    }

    /// Drop per-target outliers by median absolute deviation on the gaze
    /// features. A user glancing away mid-target produces samples that would
    /// otherwise drag the whole fit.
    fn filtered_samples(&self) -> Vec<CalibSample> {
        self.partition().into_iter().filter(|(_, kept)| *kept).map(|(s, _)| s).collect()
    }

    /// Every collected sample in gaze-feature space, for the debug scatter.
    pub fn scatter(&self) -> Vec<ScatterPoint> {
        self.partition()
            .into_iter()
            .map(|(s, kept)| ScatterPoint {
                gx: s.frame.gx,
                gy: s.frame.gy,
                target_index: s.target_index,
                kept,
            })
            .collect()
    }

    /// Fit the model from everything collected, with the default fit config.
    pub fn finish(
        &self,
        px_per_degree: f64,
        display_fingerprint: impl Into<String>,
    ) -> Result<CalibrationModel, CalibrationError> {
        self.finish_with(&CalibrationConfig::default(), px_per_degree, display_fingerprint)
    }

    /// Fit the model from everything collected.
    ///
    /// `min_quality` decided which samples got in here; `cfg` decides how much
    /// each of them then counts for (ADR-0021).
    pub fn finish_with(
        &self,
        cfg: &CalibrationConfig,
        px_per_degree: f64,
        display_fingerprint: impl Into<String>,
    ) -> Result<CalibrationModel, CalibrationError> {
        let samples = self.filtered_samples();
        fit_with(&samples, cfg, px_per_degree, display_fingerprint)
    }
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(gx: f64, gy: f64) -> GazeFrame {
        GazeFrame { ok: true, quality: 1.0, gx, gy, ..Default::default() }
    }

    fn nine_targets() -> Vec<Vec2> {
        let mut t = Vec::new();
        for iy in 0..3 {
            for ix in 0..3 {
                t.push(Vec2::new(200.0 + 700.0 * ix as f64, 150.0 + 400.0 * iy as f64));
            }
        }
        t
    }

    #[test]
    fn rejects_blinking_and_low_quality_samples() {
        let mut c = Collector::new(nine_targets());
        assert_eq!(c.add(0, frame(0.1, 0.1), true, 0.4), SampleRejection::Blinking);
        let mut low = frame(0.1, 0.1);
        low.quality = 0.1;
        assert_eq!(c.add(0, low, false, 0.4), SampleRejection::LowQuality);
        let mut noface = frame(0.1, 0.1);
        noface.ok = false;
        assert_eq!(c.add(0, noface, false, 0.4), SampleRejection::NoFace);
        assert_eq!(c.add(0, frame(0.1, 0.1), false, 0.4), SampleRejection::Accepted);

        assert_eq!(c.accepted_count(), 1);
        assert_eq!(c.rejected_count(), 3);
    }

    #[test]
    fn rejects_unknown_target_index() {
        let mut c = Collector::new(nine_targets());
        assert_eq!(c.add(99, frame(0.0, 0.0), false, 0.4), SampleRejection::UnknownTarget);
    }

    #[test]
    fn mad_filter_drops_a_glance_away() {
        let mut c = Collector::new(nine_targets());
        for _ in 0..30 {
            c.add(0, frame(0.10, 0.10), false, 0.4);
        }
        // The user glanced elsewhere for two frames.
        c.add(0, frame(0.90, -0.80), false, 0.4);
        c.add(0, frame(0.85, -0.75), false, 0.4);

        let kept = c.filtered_samples();
        assert_eq!(kept.len(), 30, "outliers were not rejected");
        assert!(kept.iter().all(|s| s.frame.gx < 0.5));
    }

    /// The scatter must report every sample, including the ones the fit threw
    /// away — seeing *which* points were rejected is half of its diagnostic
    /// value — and its keep flags must match what `filtered_samples` did.
    #[test]
    fn scatter_reports_every_sample_and_agrees_with_the_filter() {
        let mut c = Collector::new(nine_targets());
        for _ in 0..30 {
            c.add(0, frame(0.10, 0.10), false, 0.4);
        }
        c.add(0, frame(0.90, -0.80), false, 0.4);

        let scatter = c.scatter();
        assert_eq!(scatter.len(), 31, "scatter must include rejected samples");
        assert_eq!(scatter.iter().filter(|p| p.kept).count(), c.filtered_samples().len());
        assert!(scatter.iter().any(|p| !p.kept && p.gx > 0.5), "the glance-away must be flagged");
        assert!(scatter.iter().all(|p| p.target_index == 0));
    }

    #[test]
    fn mad_filter_keeps_small_groups_intact() {
        let mut c = Collector::new(nine_targets());
        for i in 0..4 {
            c.add(0, frame(0.1 * i as f64, 0.0), false, 0.4);
        }
        assert_eq!(c.filtered_samples().len(), 4);
    }

    #[test]
    fn end_to_end_collection_produces_a_model() {
        let targets = nine_targets();
        let mut c = Collector::new(targets.clone());
        for (idx, t) in targets.iter().enumerate() {
            // Invert the screen geometry into plausible gaze features.
            let gx = (t.x - 900.0) / 3000.0;
            let gy = (t.y - 550.0) / 2400.0;
            for k in 0..25 {
                let jitter = (k as f64 % 5.0 - 2.0) * 0.0008;
                c.add(idx, frame(gx + jitter, gy - jitter), false, 0.4);
            }
        }
        let model = c.finish(45.0, "fingerprint").expect("fit should succeed");
        assert_eq!(model.report.targets, 9);
        assert!(model.report.cross_validated);
        assert!(model.report.mean_error_px.is_finite());
        assert_eq!(model.display_fingerprint, "fingerprint");
    }

    /// Quality has two distinct jobs and they must not be confused: the gate
    /// decides *whether* a frame is used, the weight decides *how much*. A
    /// frame at 0.5 with the gate at 0.4 is admitted — and then carries half
    /// the say of a clean one, rather than the same say (ADR-0021).
    #[test]
    fn admitted_but_marginal_samples_reach_the_fit_discounted() {
        let targets = nine_targets();
        let mut c = Collector::new(targets.clone());
        for (idx, t) in targets.iter().enumerate() {
            let gx = (t.x - 900.0) / 3000.0;
            let gy = (t.y - 550.0) / 2400.0;
            for k in 0..25 {
                let jitter = (k as f64 % 5.0 - 2.0) * 0.0008;
                let mut f = frame(gx + jitter, gy - jitter);
                // One target was collected while the user sat badly.
                f.quality = if idx == 6 { 0.5 } else { 1.0 };
                c.add(idx, f, false, 0.4);
            }
        }

        let cfg = CalibrationConfig::default();
        let weighted = c.finish_with(&cfg, 45.0, "fp").expect("fit should succeed");
        assert_eq!(weighted.report.min_weight, 0.5);
        assert!(weighted.report.effective_samples < weighted.report.samples as f64);

        let off = CalibrationConfig { quality_weighting: false, ..cfg };
        let plain = c.finish_with(&off, 45.0, "fp").expect("fit should succeed");
        assert_eq!(plain.report.min_weight, 1.0);
        assert_ne!(plain.beta_x, weighted.beta_x, "the weights should have moved the fit");
    }

    #[test]
    fn counts_per_target() {
        let mut c = Collector::new(nine_targets());
        for _ in 0..7 {
            c.add(3, frame(0.0, 0.0), false, 0.4);
        }
        assert_eq!(c.count_for(3), 7);
        assert_eq!(c.count_for(4), 0);
    }
}
