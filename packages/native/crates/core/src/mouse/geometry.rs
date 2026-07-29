//! Logical (DIP) ↔ physical pixel mapping for backends that need it.
//!
//! The engine works entirely in Electron's DIP space: a top-left origin over
//! the union of all displays, where each display's logical size is its physical
//! size divided by its scale factor. macOS's `CGEvent` API speaks that same
//! space, so the mac backend needs none of this.
//!
//! Windows does not. `SetCursorPos` — what `enigo` calls — takes *physical*
//! pixels in the virtual-screen space. The conversion is not one multiply,
//! because Windows scales per monitor: a 150% laptop panel beside a 100%
//! external monitor has two different ratios and the physical origin of the
//! second display is not its logical origin. A single scalar is right only when
//! every display shares one scale factor, which on Windows is the exception
//! rather than the rule.
//!
//! So the mapping is piecewise: find the display containing the point, then
//! convert within it. The caller supplies the table, because only the app has
//! it — Electron's `screen` module knows both spaces (`dipToScreenPoint`),
//! Rust knows neither.

use std::sync::RwLock;

/// One display in both coordinate spaces.
///
/// `physical_*` is the top-left of this display in the platform's physical
/// virtual-screen space; it is *not* `dip_* * scale`, because displays left of
/// or above the primary have negative origins that scale independently.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayGeometry {
    pub dip_x: f64,
    pub dip_y: f64,
    pub dip_width: f64,
    pub dip_height: f64,
    pub physical_x: f64,
    pub physical_y: f64,
    /// Physical pixels per DIP. Electron's `Display.scaleFactor`.
    pub scale: f64,
}

impl DisplayGeometry {
    fn valid(&self) -> bool {
        self.scale.is_finite()
            && self.scale > 0.0
            && self.dip_width > 0.0
            && self.dip_height > 0.0
            && self.dip_x.is_finite()
            && self.dip_y.is_finite()
            && self.physical_x.is_finite()
            && self.physical_y.is_finite()
    }

    fn physical_width(&self) -> f64 {
        self.dip_width * self.scale
    }

    fn physical_height(&self) -> f64 {
        self.dip_height * self.scale
    }
}

/// Squared distance from a point to a rectangle; zero when inside.
fn rect_distance_sq(x: f64, y: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> f64 {
    let dx = (rx - x).max(0.0).max(x - (rx + rw));
    let dy = (ry - y).max(0.0).max(y - (ry + rh));
    dx * dx + dy * dy
}

/// The display owning a point, or — if the point is in a gap between displays
/// or outside them all — the nearest one.
///
/// Never returning `None` for a non-empty table matters: the engine clamps gaze
/// to the work area, but rounding at a shared edge can still land a pixel
/// outside every display, and dropping that move would freeze the cursor at the
/// boundary instead of tracking to it.
fn pick(displays: &[DisplayGeometry], x: f64, y: f64, physical: bool) -> Option<&DisplayGeometry> {
    let rect = |d: &DisplayGeometry| {
        if physical {
            (d.physical_x, d.physical_y, d.physical_width(), d.physical_height())
        } else {
            (d.dip_x, d.dip_y, d.dip_width, d.dip_height)
        }
    };

    let mut best: Option<(&DisplayGeometry, f64)> = None;
    for d in displays.iter().filter(|d| d.valid()) {
        let (rx, ry, rw, rh) = rect(d);
        let dist = rect_distance_sq(x, y, rx, ry, rw, rh);
        if dist == 0.0 {
            return Some(d);
        }
        if best.is_none_or(|(_, b)| dist < b) {
            best = Some((d, dist));
        }
    }
    best.map(|(d, _)| d)
}

/// DIP → physical. Identity when no geometry has been supplied, which is the
/// behaviour every caller had before this existed.
pub fn dip_to_physical(displays: &[DisplayGeometry], x: f64, y: f64) -> (f64, f64) {
    match pick(displays, x, y, false) {
        Some(d) => (
            d.physical_x + (x - d.dip_x) * d.scale,
            d.physical_y + (y - d.dip_y) * d.scale,
        ),
        None => (x, y),
    }
}

/// Physical → DIP, the inverse of [`dip_to_physical`].
pub fn physical_to_dip(displays: &[DisplayGeometry], x: f64, y: f64) -> (f64, f64) {
    match pick(displays, x, y, true) {
        Some(d) => (
            d.dip_x + (x - d.physical_x) / d.scale,
            d.dip_y + (y - d.physical_y) / d.scale,
        ),
        None => (x, y),
    }
}

// ---------------------------------------------------------------------------
// Process-wide table
//
// Global because the mouse backend is constructed in several places — the
// engine holds one, and `move_cursor`/`cursor_position` build a throwaway per
// call — and a layout change has to reach all of them. Seeding each instance at
// construction would leave the engine's backend stale the moment a monitor is
// plugged in mid-session, which is exactly when the mapping starts to matter.
// ---------------------------------------------------------------------------

static DISPLAYS: RwLock<Vec<DisplayGeometry>> = RwLock::new(Vec::new());

pub fn set_displays(displays: Vec<DisplayGeometry>) {
    if let Ok(mut guard) = DISPLAYS.write() {
        *guard = displays;
    }
}

/// Run `f` against the current table. Takes a closure rather than returning a
/// clone so the hot path does not allocate once per frame.
pub fn with_displays<T>(f: impl FnOnce(&[DisplayGeometry]) -> T) -> T {
    match DISPLAYS.read() {
        Ok(guard) => f(&guard),
        // A poisoned lock means a panic while the table was being written. The
        // cursor should keep working; identity is the safe reading.
        Err(_) => f(&[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(
        dip_x: f64,
        dip_y: f64,
        dip_width: f64,
        dip_height: f64,
        physical_x: f64,
        physical_y: f64,
        scale: f64,
    ) -> DisplayGeometry {
        DisplayGeometry {
            dip_x,
            dip_y,
            dip_width,
            dip_height,
            physical_x,
            physical_y,
            scale,
        }
    }

    /// A 150% laptop panel with a 100% monitor to its right — the ordinary
    /// Windows desktop, and the case a single scalar cannot express.
    fn mixed_dpi() -> Vec<DisplayGeometry> {
        vec![
            display(0.0, 0.0, 1280.0, 800.0, 0.0, 0.0, 1.5),
            display(1280.0, 0.0, 1920.0, 1080.0, 1920.0, 0.0, 1.0),
        ]
    }

    #[test]
    fn an_empty_table_maps_a_point_to_itself() {
        assert_eq!(dip_to_physical(&[], 100.0, 50.0), (100.0, 50.0));
        assert_eq!(physical_to_dip(&[], 100.0, 50.0), (100.0, 50.0));
    }

    #[test]
    fn a_scaled_display_converts_by_its_own_factor() {
        let d = mixed_dpi();
        assert_eq!(dip_to_physical(&d, 100.0, 200.0), (150.0, 300.0));
    }

    #[test]
    fn the_second_display_uses_its_physical_origin_not_its_logical_one() {
        // The bug a single scalar produces: 1300 DIP is 20 DIP into the second
        // display, whose physical origin is 1920 because the first is 1920
        // physical pixels wide. Scaling 1300 by anything lands nowhere near.
        let d = mixed_dpi();
        assert_eq!(dip_to_physical(&d, 1300.0, 40.0), (1940.0, 40.0));
    }

    #[test]
    fn each_display_keeps_its_own_scale() {
        let d = mixed_dpi();
        let (x1, _) = dip_to_physical(&d, 640.0, 400.0);
        let (x2, _) = dip_to_physical(&d, 2240.0, 400.0);
        assert_eq!(x1, 960.0, "the 150% panel scales");
        assert_eq!(x2, 2880.0, "the 100% monitor does not");
    }

    #[test]
    fn the_round_trip_returns_the_original_point() {
        let d = mixed_dpi();
        for (x, y) in [(0.0, 0.0), (640.0, 400.0), (1300.0, 40.0), (3199.0, 1079.0)] {
            let (px, py) = dip_to_physical(&d, x, y);
            let (bx, by) = physical_to_dip(&d, px, py);
            assert!(
                (bx - x).abs() < 1e-9 && (by - y).abs() < 1e-9,
                "({x}, {y}) -> ({px}, {py}) -> ({bx}, {by})",
            );
        }
    }

    #[test]
    fn a_point_past_the_right_edge_falls_to_the_nearest_display() {
        // One DIP beyond the union. Clamping to the nearest display keeps the
        // cursor tracking to the edge; returning None would strand it.
        let d = mixed_dpi();
        assert_eq!(dip_to_physical(&d, 3200.0, 500.0), (3840.0, 500.0));
    }

    #[test]
    fn a_display_left_of_the_primary_has_a_negative_origin_in_both_spaces() {
        let d = vec![
            display(-1920.0, 0.0, 1920.0, 1080.0, -1920.0, 0.0, 1.0),
            display(0.0, 0.0, 1280.0, 800.0, 0.0, 0.0, 1.5),
        ];
        assert_eq!(dip_to_physical(&d, -960.0, 540.0), (-960.0, 540.0));
        assert_eq!(dip_to_physical(&d, 640.0, 400.0), (960.0, 600.0));
    }

    #[test]
    fn a_nonsense_display_is_ignored_rather_than_dividing_by_zero() {
        let d = vec![
            display(0.0, 0.0, 1280.0, 800.0, 0.0, 0.0, 0.0),
            display(0.0, 0.0, 1280.0, 800.0, 0.0, 0.0, 2.0),
        ];
        assert_eq!(dip_to_physical(&d, 100.0, 100.0), (200.0, 200.0));
    }

    #[test]
    fn a_table_of_only_nonsense_falls_back_to_identity() {
        let d = vec![display(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, f64::NAN)];
        assert_eq!(dip_to_physical(&d, 100.0, 100.0), (100.0, 100.0));
    }

    #[test]
    fn a_uniform_layout_behaves_like_a_single_scalar() {
        // The case the old `set_scale` was written for still has to work.
        let d = vec![
            display(0.0, 0.0, 1920.0, 1080.0, 0.0, 0.0, 2.0),
            display(1920.0, 0.0, 1920.0, 1080.0, 3840.0, 0.0, 2.0),
        ];
        assert_eq!(dip_to_physical(&d, 100.0, 100.0), (200.0, 200.0));
        assert_eq!(dip_to_physical(&d, 2020.0, 100.0), (4040.0, 200.0));
    }
}
