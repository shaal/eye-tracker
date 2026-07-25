//! Minimal 2-D point type. Screen coordinates are logical (DIP) pixels with a
//! top-left origin over the union of all displays (ADR-0010).

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[inline]
    pub fn distance_to(self, other: Vec2) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }

    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

/// Axis-aligned rectangle, used for the union of display bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    /// Clamp a point into the rectangle. The `max(x, ...)` ordering matters for
    /// degenerate (zero-size) rects: we always return a point inside or on the
    /// origin corner rather than NaN.
    pub fn clamp(&self, p: Vec2) -> Vec2 {
        let max_x = self.x + (self.width - 1.0).max(0.0);
        let max_y = self.y + (self.height - 1.0).max(0.0);
        Vec2::new(p.x.clamp(self.x, max_x), p.y.clamp(self.y, max_y))
    }

    /// Diagonal length — used to scale pixel thresholds to display size
    /// (ADR-0007: the saccade threshold is display-size dependent).
    pub fn diagonal(&self) -> f64 {
        (self.width * self.width + self.height * self.height).sqrt()
    }
}

impl Default for Rect {
    fn default() -> Self {
        Rect::new(0.0, 0.0, 1920.0, 1080.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_into_bounds() {
        let r = Rect::new(0.0, 0.0, 100.0, 50.0);
        assert_eq!(r.clamp(Vec2::new(-10.0, 500.0)), Vec2::new(0.0, 49.0));
        assert_eq!(r.clamp(Vec2::new(50.0, 25.0)), Vec2::new(50.0, 25.0));
    }

    #[test]
    fn clamps_with_negative_origin_multi_display() {
        // A display to the left of the primary gives negative coordinates.
        let r = Rect::new(-1920.0, 0.0, 3840.0, 1080.0);
        assert_eq!(r.clamp(Vec2::new(-5000.0, 10.0)), Vec2::new(-1920.0, 10.0));
    }

    #[test]
    fn degenerate_rect_does_not_produce_nan() {
        let r = Rect::new(10.0, 10.0, 0.0, 0.0);
        let p = r.clamp(Vec2::new(999.0, 999.0));
        assert!(p.is_finite());
    }
}
