pub mod collector;
pub mod fit;
pub mod model;

pub use collector::{basis_of, Collector, SampleRejection, ScatterPoint};
pub use fit::{fit, fit_with, CalibSample, CalibrationError};
pub use model::{
    CalibrationModel, CalibrationReport, Expansion, FeatureTier, VerticalBasis, MAX_FEATURES,
};

use crate::math::{Rect, Vec2};

/// Standard calibration target layouts, inset from the screen edge.
///
/// Gaze near the physical border is both unreliable and unnecessary, so targets
/// stop short of it (ADR-0006).
pub fn target_grid(bounds: &Rect, points: u32) -> Vec<Vec2> {
    let fractions: &[f64] = if points >= 9 { &[0.10, 0.50, 0.90] } else { &[0.15, 0.50, 0.85] };

    let at = |fx: f64, fy: f64| {
        Vec2::new(bounds.x + bounds.width * fx, bounds.y + bounds.height * fy)
    };

    if points >= 9 {
        let mut out = Vec::with_capacity(9);
        for &fy in fractions {
            for &fx in fractions {
                out.push(at(fx, fy));
            }
        }
        out
    } else {
        // Corners plus center.
        let (lo, mid, hi) = (fractions[0], fractions[1], fractions[2]);
        vec![at(lo, lo), at(hi, lo), at(mid, mid), at(lo, hi), at(hi, hi)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nine_point_grid_is_inset_and_ordered() {
        let b = Rect::new(0.0, 0.0, 1000.0, 1000.0);
        let g = target_grid(&b, 9);
        assert_eq!(g.len(), 9);
        assert_eq!(g[0], Vec2::new(100.0, 100.0));
        assert_eq!(g[4], Vec2::new(500.0, 500.0));
        assert_eq!(g[8], Vec2::new(900.0, 900.0));
    }

    #[test]
    fn five_point_grid_is_corners_plus_center() {
        let b = Rect::new(0.0, 0.0, 1000.0, 1000.0);
        let g = target_grid(&b, 5);
        assert_eq!(g.len(), 5);
        assert_eq!(g[2], Vec2::new(500.0, 500.0));
    }

    #[test]
    fn grid_respects_a_non_zero_origin() {
        let b = Rect::new(-1920.0, 100.0, 1920.0, 1080.0);
        let g = target_grid(&b, 9);
        assert!(g.iter().all(|p| p.x >= -1920.0 && p.x <= 0.0));
        assert!(g.iter().all(|p| p.y >= 100.0 && p.y <= 1180.0));
    }
}
