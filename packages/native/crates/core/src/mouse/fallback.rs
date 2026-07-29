//! Windows / Linux mouse backend via `enigo`.
//!
//! ADR-0010 treats this as a secondary target behind macOS. One fidelity gap
//! versus the mac backend remains:
//!
//! - Double-click is emulated as two clicks rather than a single event carrying
//!   a click-count, so applications that inspect click state may not recognize
//!   it as a double-click.
//!
//! The other gap — `enigo` working in physical pixels while the engine works in
//! logical (DIP) pixels — is handled by [`super::geometry`], which the app
//! populates from Electron's `screen` module. Until it does, the mapping is the
//! identity, so an unscaled single-display setup is correct either way.

use enigo::{Button as EnigoButton, Coordinate, Direction, Enigo, Mouse, Settings};

use super::geometry::{dip_to_physical, physical_to_dip, with_displays};
use super::{Button, MouseBackend, MouseError};

pub struct EnigoMouse {
    enigo: Enigo,
}

impl EnigoMouse {
    pub fn new() -> Result<Self, MouseError> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| MouseError::Backend(format!("enigo init failed: {e}")))?;
        Ok(Self { enigo })
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
        let (fx, fy) = with_displays(|d| dip_to_physical(d, x, y));
        let px = fx.round() as i32;
        let py = fy.round() as i32;
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
        Ok(with_displays(|d| physical_to_dip(d, f64::from(x), f64::from(y))))
    }

    fn name(&self) -> &'static str {
        "enigo"
    }
}
