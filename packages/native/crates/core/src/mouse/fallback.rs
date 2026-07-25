//! Windows / Linux mouse backend via `enigo`.
//!
//! **Written but unverified** — ADR-0010 treats these as a starting point, not
//! a supported target. Two known fidelity gaps versus the macOS backend:
//!
//! - Double-click is emulated as two clicks rather than a single event carrying
//!   a click-count, so applications that inspect click state may not recognize
//!   it as a double-click.
//! - `enigo` works in physical pixels while the engine works in logical (DIP)
//!   pixels, so the caller must supply a scale factor. Left at 1.0 this is
//!   correct only on non-scaled displays.

use enigo::{Button as EnigoButton, Coordinate, Direction, Enigo, Mouse, Settings};

use super::{Button, MouseBackend, MouseError};

pub struct EnigoMouse {
    enigo: Enigo,
    /// Logical → physical pixel ratio. See the module note.
    scale: f64,
}

impl EnigoMouse {
    pub fn new() -> Result<Self, MouseError> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| MouseError::Backend(format!("enigo init failed: {e}")))?;
        Ok(Self { enigo, scale: 1.0 })
    }

    pub fn set_scale(&mut self, scale: f64) {
        if scale.is_finite() && scale > 0.0 {
            self.scale = scale;
        }
    }
}

fn map_button(b: Button) -> EnigoButton {
    match b {
        Button::Left => EnigoButton::Left,
        Button::Right => EnigoButton::Right,
        Button::Middle => EnigoButton::Middle,
    }
}

impl MouseBackend for EnigoMouse {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), MouseError> {
        let px = (x * self.scale).round() as i32;
        let py = (y * self.scale).round() as i32;
        self.enigo
            .move_mouse(px, py, Coordinate::Abs)
            .map_err(|e| MouseError::Backend(format!("move_mouse failed: {e}")))
    }

    fn click(&mut self, button: Button, count: u8) -> Result<(), MouseError> {
        let b = map_button(button);
        for _ in 0..count.max(1) {
            self.enigo
                .button(b, Direction::Click)
                .map_err(|e| MouseError::Backend(format!("button failed: {e}")))?;
        }
        Ok(())
    }

    fn cursor_position(&self) -> Result<(f64, f64), MouseError> {
        let (x, y) = self
            .enigo
            .location()
            .map_err(|e| MouseError::Backend(format!("location failed: {e}")))?;
        Ok((f64::from(x) / self.scale, f64::from(y) / self.scale))
    }

    fn name(&self) -> &'static str {
        "enigo"
    }
}
