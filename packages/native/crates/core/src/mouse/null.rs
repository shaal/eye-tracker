//! Recording backend that never touches the OS.
//!
//! This is what `cargo test` links against, which is what makes the whole
//! engine — including click synthesis and manual-takeover detection — testable
//! with no display, no camera, and no Accessibility permission (ADR-0010).
//!
//! State is shared (`Rc<RefCell<..>>`) so a test can keep inspecting calls, and
//! can *simulate physical input*, after the backend has been boxed and handed
//! to the engine.

use std::cell::RefCell;
use std::rc::Rc;

use super::{Button, MouseBackend, MouseError};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseCall {
    Move { x: f64, y: f64 },
    Click { button: Button, count: u8 },
}

#[derive(Debug, Default)]
struct NullState {
    calls: Vec<MouseCall>,
    position: (f64, f64),
}

/// A handle onto a `NullMouse`'s recorded calls and cursor position.
#[derive(Debug, Clone, Default)]
pub struct MouseLog(Rc<RefCell<NullState>>);

impl MouseLog {
    pub fn calls(&self) -> Vec<MouseCall> {
        self.0.borrow().calls.clone()
    }

    pub fn moves(&self) -> Vec<(f64, f64)> {
        self.0
            .borrow()
            .calls
            .iter()
            .filter_map(|c| match c {
                MouseCall::Move { x, y } => Some((*x, *y)),
                _ => None,
            })
            .collect()
    }

    pub fn clicks(&self) -> Vec<(Button, u8)> {
        self.0
            .borrow()
            .calls
            .iter()
            .filter_map(|c| match c {
                MouseCall::Click { button, count } => Some((*button, *count)),
                _ => None,
            })
            .collect()
    }

    /// Position of the last move issued before the i-th click.
    pub fn position_of_click(&self, nth: usize) -> Option<(f64, f64)> {
        let state = self.0.borrow();
        let mut last_move = None;
        let mut seen = 0usize;
        for c in state.calls.iter() {
            match c {
                MouseCall::Move { x, y } => last_move = Some((*x, *y)),
                MouseCall::Click { .. } => {
                    if seen == nth {
                        return last_move;
                    }
                    seen += 1;
                }
            }
        }
        None
    }

    pub fn position(&self) -> (f64, f64) {
        self.0.borrow().position
    }

    /// Move the cursor **without** going through the backend, as a physical
    /// mouse or trackpad would. Used to test manual takeover (ADR-0016).
    pub fn simulate_physical_move(&self, x: f64, y: f64) {
        self.0.borrow_mut().position = (x, y);
    }

    pub fn clear(&self) {
        self.0.borrow_mut().calls.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.0.borrow().calls.is_empty()
    }
}

#[derive(Debug, Default)]
pub struct NullMouse {
    state: MouseLog,
    /// Set to simulate a backend that refuses, for error-path tests.
    pub fail: bool,
}

impl NullMouse {
    /// Returns the backend and a handle onto its state.
    pub fn new() -> (Self, MouseLog) {
        let m = Self::default();
        let log = m.state.clone();
        (m, log)
    }
}

impl MouseBackend for NullMouse {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), MouseError> {
        if self.fail {
            return Err(MouseError::Backend("simulated failure".into()));
        }
        let mut s = self.state.0.borrow_mut();
        s.position = (x, y);
        s.calls.push(MouseCall::Move { x, y });
        Ok(())
    }

    fn click(&mut self, button: Button, count: u8) -> Result<(), MouseError> {
        if self.fail {
            return Err(MouseError::Backend("simulated failure".into()));
        }
        self.state.0.borrow_mut().calls.push(MouseCall::Click { button, count });
        Ok(())
    }

    fn cursor_position(&self) -> Result<(f64, f64), MouseError> {
        Ok(self.state.0.borrow().position)
    }

    fn name(&self) -> &'static str {
        "null"
    }
}
