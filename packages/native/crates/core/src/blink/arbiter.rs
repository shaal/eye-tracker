//! Resolves eyelid gestures into clicks (ADR-0008, ADR-0013).
//!
//! In blink mode a single click cannot be emitted the moment a blink completes:
//! it might be the first half of a double. So the arbiter holds it for
//! `double_window_ms` and emits it on expiry. That latency is intrinsic.
//!
//! In wink mode only the *left* wink participates in doubles, so a right wink
//! fires immediately — right-click gets no latency penalty.

use super::gesture::{GestureEvent, GestureKind};
use crate::config::BlinkConfig;
use crate::mouse::Button;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickKind {
    None,
    Single,
    Double,
}

impl ClickKind {
    pub fn as_u8(self) -> u8 {
        match self {
            ClickKind::None => 0,
            ClickKind::Single => 1,
            ClickKind::Double => 2,
        }
    }

    pub fn count(self) -> u8 {
        match self {
            ClickKind::None => 0,
            ClickKind::Single => 1,
            ClickKind::Double => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClickEvent {
    pub kind: ClickKind,
    pub button: Button,
    /// Onset of the gesture that started this click. Pre-blink anchoring
    /// resolves the click position from this, not from the emission time.
    pub onset_ms: f64,
}

impl ClickEvent {
    pub const NONE: ClickEvent =
        ClickEvent { kind: ClickKind::None, button: Button::Left, onset_ms: 0.0 };

    pub fn is_none(&self) -> bool {
        self.kind == ClickKind::None
    }
}

#[derive(Debug, Clone, Copy)]
struct Pending {
    onset_ms: f64,
    /// When the gesture completed — the double window runs from here.
    emitted_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ClickArbiter {
    pending: Option<Pending>,
    last_click_ms: Option<f64>,
}

impl ClickArbiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    fn in_refractory(&self, now_ms: f64, cfg: &BlinkConfig) -> bool {
        self.last_click_ms.is_some_and(|t| now_ms - t < cfg.refractory_ms)
    }

    fn fire(&mut self, kind: ClickKind, button: Button, onset_ms: f64, now_ms: f64) -> ClickEvent {
        self.last_click_ms = Some(now_ms);
        ClickEvent { kind, button, onset_ms }
    }

    /// A gesture completed at `now_ms`.
    pub fn on_gesture(&mut self, g: GestureEvent, now_ms: f64, cfg: &BlinkConfig) -> ClickEvent {
        // A trailing gesture right after a click must not cascade.
        if self.in_refractory(now_ms, cfg) {
            return ClickEvent::NONE;
        }

        // Right wink is unambiguous — nothing pairs with it — so it never waits.
        if g.kind == GestureKind::RightWink {
            return self.fire(ClickKind::Single, Button::Right, g.onset_ms, now_ms);
        }

        // Opt-out of double-click: fire singles with no latency.
        if cfg.double_window_ms <= 0.0 {
            self.pending = None;
            return self.fire(ClickKind::Single, Button::Left, g.onset_ms, now_ms);
        }

        match self.pending {
            Some(p) if now_ms - p.emitted_ms <= cfg.double_window_ms => {
                self.pending = None;
                // Anchor the double-click at the *first* gesture's onset — that
                // is where the user was looking when they began.
                self.fire(ClickKind::Double, Button::Left, p.onset_ms, now_ms)
            }
            _ => {
                self.pending = Some(Pending { onset_ms: g.onset_ms, emitted_ms: now_ms });
                ClickEvent::NONE
            }
        }
    }

    /// Called every frame. Emits a deferred single click once its window has
    /// passed with no second gesture.
    pub fn tick(&mut self, now_ms: f64, cfg: &BlinkConfig) -> ClickEvent {
        let Some(p) = self.pending else { return ClickEvent::NONE };
        if now_ms - p.emitted_ms > cfg.double_window_ms {
            self.pending = None;
            return self.fire(ClickKind::Single, Button::Left, p.onset_ms, now_ms);
        }
        ClickEvent::NONE
    }

    /// Convenience for the engine: feed an optional gesture and always tick.
    pub fn step(
        &mut self,
        gesture: Option<GestureEvent>,
        now_ms: f64,
        cfg: &BlinkConfig,
    ) -> ClickEvent {
        if let Some(g) = gesture {
            let e = self.on_gesture(g, now_ms, cfg);
            if !e.is_none() {
                return e;
            }
        }
        self.tick(now_ms, cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> BlinkConfig {
        BlinkConfig::default()
    }

    fn g(kind: GestureKind, onset: f64) -> GestureEvent {
        GestureEvent { kind, onset_ms: onset, duration_ms: 200.0 }
    }

    #[test]
    fn lone_blink_becomes_a_single_click_after_the_window() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        assert!(a.on_gesture(g(GestureKind::Blink, 1000.0), 1200.0, &c).is_none());
        assert!(a.has_pending());
        assert!(a.tick(1500.0, &c).is_none());

        let e = a.tick(1800.0, &c);
        assert_eq!(e.kind, ClickKind::Single);
        assert_eq!(e.button, Button::Left);
        assert_eq!(e.onset_ms, 1000.0, "single click must anchor at gesture onset");
    }

    #[test]
    fn two_blinks_inside_the_window_become_a_double_click() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        a.on_gesture(g(GestureKind::Blink, 1000.0), 1200.0, &c);
        let e = a.on_gesture(g(GestureKind::Blink, 1400.0), 1600.0, &c);
        assert_eq!(e.kind, ClickKind::Double);
        assert_eq!(e.button, Button::Left);
        assert_eq!(e.onset_ms, 1000.0, "double click must anchor at the first onset");
        assert!(a.tick(3000.0, &c).is_none());
    }

    #[test]
    fn left_wink_behaves_like_a_blink_for_click_purposes() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        assert!(a.on_gesture(g(GestureKind::LeftWink, 1000.0), 1200.0, &c).is_none());
        let e = a.tick(1800.0, &c);
        assert_eq!(e.kind, ClickKind::Single);
        assert_eq!(e.button, Button::Left);
    }

    #[test]
    fn two_left_winks_make_a_double_click() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        a.on_gesture(g(GestureKind::LeftWink, 1000.0), 1200.0, &c);
        let e = a.on_gesture(g(GestureKind::LeftWink, 1400.0), 1600.0, &c);
        assert_eq!(e.kind, ClickKind::Double);
        assert_eq!(e.button, Button::Left);
    }

    /// Right-click has nothing to pair with, so making the user wait out the
    /// double window would be pure latency for no benefit.
    #[test]
    fn right_wink_fires_immediately_as_a_right_click() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        let e = a.on_gesture(g(GestureKind::RightWink, 1000.0), 1200.0, &c);
        assert_eq!(e.kind, ClickKind::Single);
        assert_eq!(e.button, Button::Right);
        assert_eq!(e.onset_ms, 1000.0);
        assert!(!a.has_pending());
    }

    #[test]
    fn right_wink_does_not_consume_a_pending_left_click() {
        let mut a = ClickArbiter::new();
        let mut c = cfg();
        c.refractory_ms = 0.0;
        a.on_gesture(g(GestureKind::LeftWink, 1000.0), 1200.0, &c);
        let r = a.on_gesture(g(GestureKind::RightWink, 1300.0), 1400.0, &c);
        assert_eq!(r.button, Button::Right);
        // The pending left single must still resolve on its own schedule.
        assert!(a.has_pending());
        let l = a.tick(2000.0, &c);
        assert_eq!(l.kind, ClickKind::Single);
        assert_eq!(l.button, Button::Left);
    }

    #[test]
    fn refractory_period_suppresses_a_trailing_gesture() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        a.on_gesture(g(GestureKind::Blink, 1000.0), 1200.0, &c);
        assert_eq!(a.tick(1800.0, &c).kind, ClickKind::Single);
        assert!(a.on_gesture(g(GestureKind::Blink, 1850.0), 1900.0, &c).is_none());
        assert!(!a.has_pending());
    }

    #[test]
    fn zero_window_fires_singles_immediately() {
        let mut a = ClickArbiter::new();
        let mut c = cfg();
        c.double_window_ms = 0.0;
        let e = a.on_gesture(g(GestureKind::Blink, 1000.0), 1200.0, &c);
        assert_eq!(e.kind, ClickKind::Single);
        assert!(!a.has_pending());
    }

    #[test]
    fn triple_blink_does_not_produce_three_clicks() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        let mut clicks = Vec::new();
        for (onset, done) in [(1000.0, 1200.0), (1300.0, 1500.0), (1600.0, 1800.0)] {
            let e = a.step(Some(g(GestureKind::Blink, onset)), done, &c);
            if !e.is_none() {
                clicks.push(e.kind);
            }
        }
        assert_eq!(clicks, vec![ClickKind::Double], "got {clicks:?}");
    }

    #[test]
    fn step_ticks_even_without_a_gesture() {
        let mut a = ClickArbiter::new();
        let c = cfg();
        a.step(Some(g(GestureKind::Blink, 1000.0)), 1200.0, &c);
        assert!(a.step(None, 1400.0, &c).is_none());
        assert_eq!(a.step(None, 1800.0, &c).kind, ClickKind::Single);
    }
}
