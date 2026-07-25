//! Eyelid closure state machine (ADR-0008).
//!
//! Runs against a monotonic clock in the main process rather than the renderer,
//! because a 250 ms GC pause in a renderer would turn one blink into two
//! (ADR-0004).

use crate::config::BlinkConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlinkPhase {
    Open,
    Closed,
    /// Closure longer than `max_close_ms` — the user is resting their eyes, not
    /// clicking. Emits no click.
    LongClose,
}

impl BlinkPhase {
    pub fn as_u8(self) -> u8 {
        match self {
            BlinkPhase::Open => 0,
            BlinkPhase::Closed => 1,
            BlinkPhase::LongClose => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BlinkEvent {
    None,
    /// A closure of qualifying duration completed.
    Blink { onset_ms: f64, duration_ms: f64 },
    /// A closure exceeded `max_close_ms`. Surfaced so it can be bound to a
    /// gesture later; it never produces a click.
    LongClose { onset_ms: f64 },
}

#[derive(Debug, Clone)]
pub struct BlinkFsm {
    phase: BlinkPhase,
    closed_at_ms: f64,
    /// Duration of the most recent qualifying blink, for the HUD.
    last_duration_ms: f64,
}

impl Default for BlinkFsm {
    fn default() -> Self {
        Self::new()
    }
}

impl BlinkFsm {
    pub fn new() -> Self {
        Self { phase: BlinkPhase::Open, closed_at_ms: 0.0, last_duration_ms: 0.0 }
    }

    pub fn phase(&self) -> BlinkPhase {
        self.phase
    }

    /// True whenever the eyes are not fully open. The filter freezes on this,
    /// because the eyelid corrupts the gaze estimate throughout the closure.
    pub fn is_closing(&self) -> bool {
        self.phase != BlinkPhase::Open
    }

    pub fn last_duration_ms(&self) -> f64 {
        self.last_duration_ms
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Advance the machine. `closure` is 0..1, where 1 is fully shut.
    pub fn update(&mut self, closure: f64, t_ms: f64, cfg: &BlinkConfig) -> BlinkEvent {
        match self.phase {
            BlinkPhase::Open => {
                if closure > cfg.close_thresh {
                    self.phase = BlinkPhase::Closed;
                    self.closed_at_ms = t_ms;
                }
                BlinkEvent::None
            }
            BlinkPhase::Closed => {
                let held = t_ms - self.closed_at_ms;
                // Asymmetric thresholds are hysteresis: a single threshold
                // produces a burst of events when the signal sits on it.
                if closure < cfg.open_thresh {
                    self.phase = BlinkPhase::Open;
                    if held >= cfg.min_close_ms && held <= cfg.max_close_ms {
                        self.last_duration_ms = held;
                        return BlinkEvent::Blink { onset_ms: self.closed_at_ms, duration_ms: held };
                    }
                    // Too short: involuntary flicker or landmark noise.
                    // Too long: handled below before we get here.
                    return BlinkEvent::None;
                }
                if held > cfg.max_close_ms {
                    self.phase = BlinkPhase::LongClose;
                    return BlinkEvent::LongClose { onset_ms: self.closed_at_ms };
                }
                BlinkEvent::None
            }
            BlinkPhase::LongClose => {
                if closure < cfg.open_thresh {
                    self.phase = BlinkPhase::Open;
                }
                BlinkEvent::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Driver {
        fsm: BlinkFsm,
        cfg: BlinkConfig,
        t: f64,
        events: Vec<BlinkEvent>,
    }

    impl Driver {
        fn new() -> Self {
            Self { fsm: BlinkFsm::new(), cfg: BlinkConfig::default(), t: 0.0, events: Vec::new() }
        }
        /// Hold `closure` for `ms`, stepping at 60 Hz.
        fn hold(&mut self, closure: f64, ms: f64) {
            let end = self.t + ms;
            while self.t < end {
                let e = self.fsm.update(closure, self.t, &self.cfg);
                if e != BlinkEvent::None {
                    self.events.push(e);
                }
                self.t += 16.7;
            }
        }
        fn blinks(&self) -> Vec<&BlinkEvent> {
            self.events.iter().filter(|e| matches!(e, BlinkEvent::Blink { .. })).collect()
        }
    }

    #[test]
    fn deliberate_blink_is_detected() {
        let mut d = Driver::new();
        d.hold(0.0, 500.0);
        d.hold(0.9, 250.0); // deliberate: well past min_close_ms
        d.hold(0.0, 500.0);
        assert_eq!(d.blinks().len(), 1, "events: {:?}", d.events);
    }

    /// The central requirement of ADR-0008: a natural ~120 ms blink must not
    /// click at the default threshold.
    #[test]
    fn natural_short_blink_is_rejected() {
        let mut d = Driver::new();
        d.hold(0.0, 500.0);
        d.hold(0.9, 100.0);
        d.hold(0.0, 500.0);
        assert!(d.blinks().is_empty(), "involuntary blink produced a click: {:?}", d.events);
    }

    #[test]
    fn long_closure_emits_long_close_not_a_blink() {
        let mut d = Driver::new();
        d.hold(0.0, 200.0);
        d.hold(0.9, 1200.0); // resting the eyes
        d.hold(0.0, 300.0);
        assert!(d.blinks().is_empty(), "resting eyes produced a click");
        assert!(d.events.iter().any(|e| matches!(e, BlinkEvent::LongClose { .. })));
        assert_eq!(d.fsm.phase(), BlinkPhase::Open);
    }

    /// A single LongClose must not re-fire every frame while the eyes stay shut.
    #[test]
    fn long_close_fires_once_per_closure() {
        let mut d = Driver::new();
        d.hold(0.0, 100.0);
        d.hold(0.9, 3000.0);
        let n = d.events.iter().filter(|e| matches!(e, BlinkEvent::LongClose { .. })).count();
        assert_eq!(n, 1, "events: {:?}", d.events);
    }

    /// Hysteresis: a signal hovering between the two thresholds must not
    /// oscillate the state machine.
    #[test]
    fn signal_sitting_between_thresholds_does_not_chatter() {
        let mut d = Driver::new();
        d.hold(0.0, 200.0);
        d.hold(0.9, 250.0);
        d.hold(0.0, 200.0);
        let before = d.blinks().len();
        // Now hover at 0.45 — above open_thresh (0.35), below close_thresh (0.55).
        d.hold(0.45, 2000.0);
        assert_eq!(d.blinks().len(), before, "hysteresis band produced events");
    }

    #[test]
    fn raising_min_close_ms_rejects_more_blinks() {
        let mut d = Driver::new();
        d.cfg.min_close_ms = 250.0;
        d.hold(0.0, 200.0);
        d.hold(0.9, 180.0); // would pass at the 150 ms default
        d.hold(0.0, 200.0);
        assert!(d.blinks().is_empty(), "tightened threshold still clicked");
    }

    #[test]
    fn is_closing_is_true_throughout_a_closure() {
        let mut fsm = BlinkFsm::new();
        let cfg = BlinkConfig::default();
        fsm.update(0.0, 0.0, &cfg);
        assert!(!fsm.is_closing());
        fsm.update(0.9, 16.0, &cfg);
        assert!(fsm.is_closing(), "filter would not freeze during the blink");
        fsm.update(0.0, 300.0, &cfg);
        assert!(!fsm.is_closing());
    }

    #[test]
    fn reports_onset_not_completion_time() {
        let mut d = Driver::new();
        d.hold(0.0, 500.0);
        let onset_approx = d.t;
        d.hold(0.9, 250.0);
        d.hold(0.0, 100.0);
        let BlinkEvent::Blink { onset_ms, duration_ms } = *d.blinks()[0] else {
            panic!("no blink");
        };
        // Onset is what pre-blink anchoring keys off, so it must be the start of
        // the closure, not the end.
        assert!((onset_ms - onset_approx).abs() < 34.0, "onset {onset_ms} vs {onset_approx}");
        assert!(duration_ms >= 250.0 - 34.0);
    }
}
