//! Ring buffer of recent cursor positions.
//!
//! Exists for pre-blink anchoring (ADR-0008): when a blink fires a click, the
//! click must land where the user was looking *before* the eyelid started
//! corrupting the gaze estimate, not where the estimate drifted to.

use crate::math::Vec2;

const CAPACITY: usize = 180; // ~3 s at 60 Hz

#[derive(Debug, Clone)]
pub struct History {
    buf: Vec<(f64, Vec2)>,
    /// Index of the next write.
    head: usize,
    len: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

impl History {
    pub fn new() -> Self {
        Self { buf: vec![(0.0, Vec2::ZERO); CAPACITY], head: 0, len: 0 }
    }

    pub fn push(&mut self, t_ms: f64, p: Vec2) {
        self.buf[self.head] = (t_ms, p);
        self.head = (self.head + 1) % CAPACITY;
        self.len = (self.len + 1).min(CAPACITY);
    }

    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    pub fn latest(&self) -> Option<Vec2> {
        if self.len == 0 {
            return None;
        }
        let idx = (self.head + CAPACITY - 1) % CAPACITY;
        Some(self.buf[idx].1)
    }

    /// Most recent position recorded at or before `t_ms`.
    ///
    /// Falls back to the oldest retained entry when `t_ms` predates the buffer,
    /// which is better than returning nothing: an anchor slightly too old still
    /// beats clicking at the blink-corrupted position.
    pub fn at_or_before(&self, t_ms: f64) -> Option<Vec2> {
        if self.len == 0 {
            return None;
        }
        let mut oldest = None;
        for k in 1..=self.len {
            let idx = (self.head + CAPACITY - k) % CAPACITY;
            let (t, p) = self.buf[idx];
            if t <= t_ms {
                return Some(p);
            }
            oldest = Some(p);
        }
        oldest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_when_empty() {
        assert!(History::new().at_or_before(100.0).is_none());
        assert!(History::new().latest().is_none());
    }

    #[test]
    fn finds_position_at_a_past_time() {
        let mut h = History::new();
        for i in 0..10 {
            h.push(i as f64 * 100.0, Vec2::new(i as f64, 0.0));
        }
        // t = 550 → the entry at t = 500, which is x = 5.
        assert_eq!(h.at_or_before(550.0), Some(Vec2::new(5.0, 0.0)));
        assert_eq!(h.at_or_before(500.0), Some(Vec2::new(5.0, 0.0)));
        assert_eq!(h.latest(), Some(Vec2::new(9.0, 0.0)));
    }

    #[test]
    fn falls_back_to_oldest_when_query_predates_buffer() {
        let mut h = History::new();
        for i in 0..5 {
            h.push(1000.0 + i as f64 * 10.0, Vec2::new(i as f64, 0.0));
        }
        assert_eq!(h.at_or_before(0.0), Some(Vec2::new(0.0, 0.0)));
    }

    #[test]
    fn wraps_without_losing_ordering() {
        let mut h = History::new();
        for i in 0..(CAPACITY + 50) {
            h.push(i as f64, Vec2::new(i as f64, 0.0));
        }
        let last = (CAPACITY + 49) as f64;
        assert_eq!(h.latest(), Some(Vec2::new(last, 0.0)));
        // A time inside the retained window resolves exactly.
        let q = last - 10.0;
        assert_eq!(h.at_or_before(q), Some(Vec2::new(q, 0.0)));
    }

    #[test]
    fn anchors_150ms_before_a_blink() {
        // The scenario from ADR-0008: gaze is steady at y=500, then the eyelid
        // drags the estimate down during closure.
        let mut h = History::new();
        let mut t = 0.0;
        while t < 1000.0 {
            h.push(t, Vec2::new(800.0, 500.0));
            t += 16.7;
        }
        let onset = t;
        for k in 0..10 {
            h.push(onset + k as f64 * 16.7, Vec2::new(800.0, 500.0 + k as f64 * 30.0));
        }
        let anchored = h.at_or_before(onset - 150.0).unwrap();
        assert_eq!(anchored.y, 500.0, "anchor picked up blink-corrupted position");
    }
}
