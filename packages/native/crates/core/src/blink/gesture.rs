//! Eyelid gesture detection: both-eye blinks and single-eye winks (ADR-0013).
//!
//! ## Why wink mode is structurally safer than blink mode
//!
//! The central problem with blink-as-click is that humans blink involuntarily
//! 15–20 times a minute, and blink mode can only separate deliberate from
//! involuntary by *duration* — two overlapping distributions.
//!
//! A wink is different in kind. Involuntary blinks close **both** eyes, so
//! requiring one eye shut *and the other open* rejects them on a structural
//! property rather than a threshold. That is a much stronger discriminator, and
//! it is why wink mode can use a shorter minimum closure than blink mode.
//!
//! The catch is that most people cannot wink cleanly — the other eye squints
//! too. So the test is not "one shut, one open" but "one shut, the other
//! meaningfully more open", governed by `wink_asymmetry`.

use super::fsm::{BlinkEvent, BlinkFsm, BlinkPhase};
use crate::config::{BlinkConfig, ClickMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GestureKind {
    /// Both eyes closed together.
    Blink,
    LeftWink,
    RightWink,
}

impl GestureKind {
    pub fn as_u8(self) -> u8 {
        match self {
            GestureKind::Blink => 0,
            GestureKind::LeftWink => 1,
            GestureKind::RightWink => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GestureEvent {
    pub kind: GestureKind,
    pub onset_ms: f64,
    pub duration_ms: f64,
}

/// Per-frame eyelid input, already resolved to the subject's own left and right
/// (ADR-0013).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Closure {
    pub left: f64,
    pub right: f64,
}

impl Closure {
    /// Both-eye signal: the minimum, so one eye alone can never register.
    pub fn both(self) -> f64 {
        self.left.min(self.right)
    }

    /// Any-eyelid-moving signal, used to freeze the cursor. A wink corrupts the
    /// gaze estimate too — the closed eye's iris is occluded and it contributes
    /// to the averaged gaze signal.
    pub fn any(self) -> f64 {
        self.left.max(self.right)
    }

    /// Wink signal for one eye: the closure of the winking eye, but only when
    /// the other eye is clearly more open. Returning 0 otherwise lets the same
    /// threshold/hysteresis state machine handle winks unchanged.
    fn wink_signal(closed: f64, other: f64, cfg: &BlinkConfig) -> f64 {
        if other >= cfg.open_thresh {
            return 0.0;
        }
        if closed - other < cfg.wink_asymmetry {
            return 0.0;
        }
        closed
    }
}

/// Runs the per-channel state machines and emits gestures for the active mode.
#[derive(Debug, Clone)]
pub struct GestureDetector {
    blink: BlinkFsm,
    left: BlinkFsm,
    right: BlinkFsm,
    /// Separate machine on `any()`, purely for the cursor freeze.
    freeze: BlinkFsm,
    last_closure: Closure,
    last_mode: Option<ClickMode>,
}

impl Default for GestureDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl GestureDetector {
    pub fn new() -> Self {
        Self {
            blink: BlinkFsm::new(),
            left: BlinkFsm::new(),
            right: BlinkFsm::new(),
            freeze: BlinkFsm::new(),
            last_closure: Closure::default(),
            last_mode: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// True whenever any eyelid is down, so the filter can freeze.
    pub fn is_closing(&self) -> bool {
        self.freeze.is_closing()
    }

    pub fn phase(&self) -> BlinkPhase {
        self.freeze.phase()
    }

    pub fn closure(&self) -> Closure {
        self.last_closure
    }

    pub fn update(&mut self, c: Closure, t_ms: f64, cfg: &BlinkConfig) -> Option<GestureEvent> {
        // A closure that began under the old mode must not resolve into a click
        // under the new one — switching modes mid-wink would otherwise fire
        // immediately and inexplicably.
        if self.last_mode != Some(cfg.mode) {
            let had_mode = self.last_mode.is_some();
            if had_mode {
                self.blink = BlinkFsm::new();
                self.left = BlinkFsm::new();
                self.right = BlinkFsm::new();
                self.freeze = BlinkFsm::new();
            }
            self.last_mode = Some(cfg.mode);
        }

        self.last_closure = c;

        // Freeze channel always runs, in both modes.
        self.freeze.update(c.any(), t_ms, cfg);

        match cfg.mode {
            ClickMode::Blink => {
                // Wink channels are kept warm so switching modes mid-session
                // does not emit a spurious gesture from stale state.
                let wcfg = wink_cfg(cfg);
                self.left.update(Closure::wink_signal(c.left, c.right, cfg), t_ms, &wcfg);
                self.right.update(Closure::wink_signal(c.right, c.left, cfg), t_ms, &wcfg);

                match self.blink.update(c.both(), t_ms, cfg) {
                    BlinkEvent::Blink { onset_ms, duration_ms } => Some(GestureEvent {
                        kind: GestureKind::Blink,
                        onset_ms,
                        duration_ms,
                    }),
                    _ => None,
                }
            }
            ClickMode::Wink => {
                // A natural blink drives `both` high but leaves both wink
                // signals at zero, so it produces nothing at all here.
                self.blink.update(c.both(), t_ms, cfg);

                let wcfg = wink_cfg(cfg);
                let l = self.left.update(Closure::wink_signal(c.left, c.right, cfg), t_ms, &wcfg);
                let r = self.right.update(Closure::wink_signal(c.right, c.left, cfg), t_ms, &wcfg);

                if let BlinkEvent::Blink { onset_ms, duration_ms } = l {
                    return Some(GestureEvent {
                        kind: GestureKind::LeftWink,
                        onset_ms,
                        duration_ms,
                    });
                }
                if let BlinkEvent::Blink { onset_ms, duration_ms } = r {
                    return Some(GestureEvent {
                        kind: GestureKind::RightWink,
                        onset_ms,
                        duration_ms,
                    });
                }
                None
            }
        }
    }
}

/// Winks use their own duration window: the asymmetry test already rejects
/// involuntary blinks, so the minimum can be shorter, and winks are commonly
/// held longer than blinks so the maximum is more generous.
fn wink_cfg(cfg: &BlinkConfig) -> BlinkConfig {
    BlinkConfig {
        min_close_ms: cfg.wink_min_close_ms,
        max_close_ms: cfg.wink_max_close_ms,
        ..*cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Driver {
        d: GestureDetector,
        cfg: BlinkConfig,
        t: f64,
        events: Vec<GestureEvent>,
    }

    impl Driver {
        fn new(mode: ClickMode) -> Self {
            Self {
                d: GestureDetector::new(),
                cfg: BlinkConfig { mode, ..Default::default() },
                t: 0.0,
                events: Vec::new(),
            }
        }

        fn hold(&mut self, left: f64, right: f64, ms: f64) {
            let end = self.t + ms;
            while self.t < end {
                if let Some(e) = self.d.update(Closure { left, right }, self.t, &self.cfg) {
                    self.events.push(e);
                }
                self.t += 16.7;
            }
        }

        fn kinds(&self) -> Vec<GestureKind> {
            self.events.iter().map(|e| e.kind).collect()
        }
    }

    // --- blink mode ---

    #[test]
    fn blink_mode_detects_a_deliberate_two_eye_blink() {
        let mut d = Driver::new(ClickMode::Blink);
        d.hold(0.0, 0.0, 300.0);
        d.hold(0.9, 0.9, 250.0);
        d.hold(0.0, 0.0, 300.0);
        assert_eq!(d.kinds(), vec![GestureKind::Blink]);
    }

    #[test]
    fn blink_mode_ignores_a_wink() {
        let mut d = Driver::new(ClickMode::Blink);
        d.hold(0.0, 0.0, 300.0);
        d.hold(0.95, 0.05, 300.0);
        d.hold(0.0, 0.0, 300.0);
        assert!(d.kinds().is_empty(), "wink fired in blink mode: {:?}", d.kinds());
    }

    // --- wink mode ---

    #[test]
    fn wink_mode_detects_a_left_wink() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 300.0);
        d.hold(0.9, 0.05, 250.0);
        d.hold(0.0, 0.0, 300.0);
        assert_eq!(d.kinds(), vec![GestureKind::LeftWink]);
    }

    #[test]
    fn wink_mode_detects_a_right_wink() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 300.0);
        d.hold(0.05, 0.9, 250.0);
        d.hold(0.0, 0.0, 300.0);
        assert_eq!(d.kinds(), vec![GestureKind::RightWink]);
    }

    /// The headline property of wink mode: an involuntary two-eye blink cannot
    /// produce a click at all, regardless of how long it lasts.
    #[test]
    fn wink_mode_rejects_natural_blinks_entirely() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 200.0);
        for _ in 0..5 {
            d.hold(0.92, 0.90, 140.0); // natural blink
            d.hold(0.0, 0.0, 400.0);
        }
        // Even a long, deliberate two-eye blink does nothing in wink mode.
        d.hold(0.95, 0.95, 300.0);
        d.hold(0.0, 0.0, 300.0);
        assert!(d.kinds().is_empty(), "two-eye blinks leaked through: {:?}", d.kinds());
    }

    /// Real winks are imperfect — the other eye squints. The asymmetry margin,
    /// not a strict "other eye fully open" test, is what makes this usable.
    #[test]
    fn wink_mode_tolerates_the_other_eye_squinting() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 300.0);
        // Winking eye at 0.9, other at 0.25 — squinting but below open_thresh
        // (0.35), and the gap (0.65) exceeds wink_asymmetry (0.28).
        d.hold(0.9, 0.25, 250.0);
        d.hold(0.0, 0.0, 300.0);
        assert_eq!(d.kinds(), vec![GestureKind::LeftWink]);
    }

    #[test]
    fn wink_mode_rejects_insufficient_asymmetry() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 300.0);
        // Gap of 0.2 is below the 0.28 margin — this is a sloppy blink, not a
        // wink.
        d.hold(0.52, 0.32, 250.0);
        d.hold(0.0, 0.0, 300.0);
        assert!(d.kinds().is_empty(), "ambiguous closure counted as a wink");
    }

    #[test]
    fn wink_shorter_than_the_wink_minimum_is_rejected() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 300.0);
        d.hold(0.9, 0.0, 60.0); // below wink_min_close_ms (120)
        d.hold(0.0, 0.0, 300.0);
        assert!(d.kinds().is_empty());
    }

    #[test]
    fn wink_allows_a_longer_hold_than_a_blink() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 200.0);
        // 700 ms would exceed max_close_ms (500) in blink mode but is inside
        // wink_max_close_ms (900).
        d.hold(0.9, 0.0, 700.0);
        d.hold(0.0, 0.0, 300.0);
        assert_eq!(d.kinds(), vec![GestureKind::LeftWink]);
    }

    #[test]
    fn freeze_is_active_during_a_wink() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 100.0);
        assert!(!d.d.is_closing());
        d.d.update(Closure { left: 0.9, right: 0.0 }, d.t, &d.cfg);
        // The closed eye's iris is occluded and it feeds the averaged gaze
        // signal, so the cursor must freeze during a wink too.
        assert!(d.d.is_closing(), "cursor would chase corrupted gaze during a wink");
    }

    #[test]
    fn switching_modes_does_not_emit_a_stale_gesture() {
        let mut d = Driver::new(ClickMode::Blink);
        d.hold(0.0, 0.0, 200.0);
        d.hold(0.9, 0.0, 300.0); // a wink, ignored in blink mode
        d.cfg.mode = ClickMode::Wink;
        d.hold(0.0, 0.0, 300.0);
        assert!(d.kinds().is_empty(), "stale wink emitted after mode switch: {:?}", d.kinds());
    }

    #[test]
    fn reports_onset_for_pre_blink_anchoring() {
        let mut d = Driver::new(ClickMode::Wink);
        d.hold(0.0, 0.0, 500.0);
        let onset_approx = d.t;
        d.hold(0.9, 0.0, 250.0);
        d.hold(0.0, 0.0, 200.0);
        let e = d.events[0];
        assert!((e.onset_ms - onset_approx).abs() < 34.0, "onset {}", e.onset_ms);
    }
}
