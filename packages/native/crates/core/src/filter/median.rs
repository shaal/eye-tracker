//! Small fixed-width median filter and a spread estimator.
//!
//! ## Why a median before the exponential filter
//!
//! Iris landmark noise is not purely Gaussian — it contains isolated spikes
//! where the refinement model briefly mislocalizes the pupil by tens of pixels.
//! An exponential filter cannot reject those: it *averages them in*, so a
//! single bad frame smears across the next several. A median discards them
//! outright at a cost of (n−1)/2 frames of latency.
//!
//! At the default width of 3 that is one frame (~33 ms at 30 fps), which is a
//! good trade for removing the jumps that make a cursor look broken.

pub const MAX_MEDIAN: usize = 5;

#[derive(Debug, Clone)]
pub struct MedianFilter {
    buf: [f64; MAX_MEDIAN],
    len: usize,
    next: usize,
    window: usize,
}

impl Default for MedianFilter {
    fn default() -> Self {
        Self::new(3)
    }
}

impl MedianFilter {
    pub fn new(window: usize) -> Self {
        Self {
            buf: [0.0; MAX_MEDIAN],
            len: 0,
            next: 0,
            // Even widths have no unique middle element; clamp to an odd width.
            window: window.clamp(1, MAX_MEDIAN) | 1,
        }
    }

    pub fn set_window(&mut self, window: usize) {
        let w = window.clamp(1, MAX_MEDIAN) | 1;
        if w != self.window {
            self.window = w;
            self.reset();
        }
    }

    pub fn window(&self) -> usize {
        self.window
    }

    pub fn reset(&mut self) {
        self.len = 0;
        self.next = 0;
    }

    pub fn push(&mut self, x: f64) -> f64 {
        if self.window == 1 {
            return x;
        }
        self.buf[self.next] = x;
        self.next = (self.next + 1) % self.window;
        self.len = (self.len + 1).min(self.window);

        // Until the window fills, return the newest sample rather than a median
        // of mostly-empty slots — otherwise the filter emits a stale value for
        // the first few frames after a saccade reset.
        if self.len < self.window {
            return x;
        }

        let mut sorted = [0.0f64; MAX_MEDIAN];
        sorted[..self.window].copy_from_slice(&self.buf[..self.window]);
        let slice = &mut sorted[..self.window];
        slice.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        slice[self.window / 2]
    }
}

/// Rolling estimate of how much the signal is spreading out.
///
/// Used to size the fixation clamp to the user's actual noise level rather than
/// a constant that is too small for a noisy camera and too large for a good one
/// (ADR-0014).
///
/// Measured as a **trimmed percentile half-spread** (15th to 85th), not a
/// median absolute deviation. MAD is the more obvious choice but has a
/// degenerate case that matters here: for a signal oscillating between two
/// values, most samples sit exactly at the median, so MAD reports 0 — "no
/// noise" for a signal that is entirely noise. Trimming the tails keeps the
/// outlier robustness that motivated MAD without that failure.
#[derive(Debug, Clone)]
pub struct SpreadEstimator {
    buf: Vec<f64>,
    next: usize,
    len: usize,
}

impl Default for SpreadEstimator {
    fn default() -> Self {
        Self::new(15)
    }
}

impl SpreadEstimator {
    pub fn new(capacity: usize) -> Self {
        Self { buf: vec![0.0; capacity.max(3)], next: 0, len: 0 }
    }

    pub fn reset(&mut self) {
        self.next = 0;
        self.len = 0;
    }

    pub fn push(&mut self, v: f64) {
        let cap = self.buf.len();
        self.buf[self.next] = v;
        self.next = (self.next + 1) % cap;
        self.len = (self.len + 1).min(cap);
    }

    /// Half the 15th-to-85th percentile range of the retained samples, or
    /// `None` until the window is full.
    pub fn spread(&self) -> Option<f64> {
        if self.len < self.buf.len() {
            return None;
        }
        let mut v: Vec<f64> = self.buf[..self.len].to_vec();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let n = v.len();
        let lo_i = ((n as f64) * 0.15) as usize;
        let hi_i = (((n as f64) * 0.85) as usize).min(n - 1);
        Some(((v[hi_i] - v[lo_i]) / 2.0).max(0.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_of_one_is_a_passthrough() {
        let mut m = MedianFilter::new(1);
        assert_eq!(m.push(5.0), 5.0);
        assert_eq!(m.push(-99.0), -99.0);
    }

    #[test]
    fn even_windows_are_rounded_up_to_odd() {
        assert_eq!(MedianFilter::new(4).window(), 5);
        assert_eq!(MedianFilter::new(2).window(), 3);
    }

    #[test]
    fn rejects_an_isolated_spike() {
        let mut m = MedianFilter::new(3);
        m.push(100.0);
        m.push(100.0);
        // A single wildly wrong frame must not reach the output at all.
        assert_eq!(m.push(900.0), 100.0);
        assert_eq!(m.push(100.0), 100.0);
    }

    #[test]
    fn follows_a_sustained_change() {
        let mut m = MedianFilter::new(3);
        for _ in 0..3 {
            m.push(100.0);
        }
        m.push(500.0);
        m.push(500.0);
        // Two consecutive samples at the new value is a real move, not a spike.
        assert_eq!(m.push(500.0), 500.0);
    }

    #[test]
    fn passes_through_until_the_window_fills() {
        let mut m = MedianFilter::new(5);
        assert_eq!(m.push(7.0), 7.0);
        assert_eq!(m.push(8.0), 8.0);
    }

    #[test]
    fn spread_is_none_until_full() {
        let mut s = SpreadEstimator::new(5);
        s.push(1.0);
        assert!(s.spread().is_none());
    }

    /// The case that a median-absolute-deviation estimator gets wrong: for a
    /// pure oscillation most samples sit exactly at the median, so MAD reports
    /// zero noise for a signal that is entirely noise.
    #[test]
    fn spread_measures_noise_amplitude() {
        let mut quiet = SpreadEstimator::new(9);
        let mut noisy = SpreadEstimator::new(9);
        for i in 0..9 {
            let alt = if i % 2 == 0 { 1.0 } else { -1.0 };
            quiet.push(500.0 + alt * 1.0);
            noisy.push(500.0 + alt * 30.0);
        }
        let q = quiet.spread().unwrap();
        let n = noisy.spread().unwrap();
        assert!(q > 0.0, "oscillating signal reported zero spread");
        assert!(n > q * 5.0, "quiet {q} noisy {n}");
    }

    #[test]
    fn spread_is_robust_to_a_single_outlier() {
        let mut s = SpreadEstimator::new(11);
        for _ in 0..10 {
            s.push(500.0);
        }
        s.push(5000.0); // one catastrophic frame
        let sp = s.spread().unwrap();
        assert!(sp < 50.0, "one outlier inflated spread to {sp}");
    }
}
