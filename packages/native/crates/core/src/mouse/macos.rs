//! macOS mouse backend built directly on Core Graphics events (ADR-0010).
//!
//! Two things here are not available through cross-platform input crates and
//! are the reason this backend exists:
//!
//! 1. **Click state.** A double-click on macOS is not two clicks in quick
//!    succession — it is an event carrying `kCGMouseEventClickState = 2`.
//!    Applications read that field: without it, text will not select by word
//!    and files will not open.
//! 2. **Posted movement rather than a warp.** `CGWarpMouseCursorPosition` moves
//!    the pointer without generating the movement events applications use for
//!    hover states, and it desynchronizes the hardware cursor association.

use core_graphics::event::{
    CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

use super::{Button, MouseBackend, MouseError};

pub struct MacMouse;

impl MacMouse {
    pub fn new() -> Result<Self, MouseError> {
        // Construction is a permission-independent smoke test that Core
        // Graphics is reachable at all.
        source()?;
        Ok(Self)
    }
}

/// A fresh event source per call. Cheap relative to the event post, and it
/// keeps the backend free of Core Foundation handles that would complicate
/// ownership across the napi boundary.
fn source() -> Result<CGEventSource, MouseError> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| MouseError::Backend("could not create CGEventSource".into()))
}

fn buttons(b: Button) -> (CGEventType, CGEventType, CGMouseButton) {
    match b {
        Button::Left => (
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGMouseButton::Left,
        ),
        Button::Right => (
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGMouseButton::Right,
        ),
        Button::Middle => (
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
            CGMouseButton::Center,
        ),
    }
}

impl MouseBackend for MacMouse {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), MouseError> {
        // macOS global display coordinates are top-left origin and measured in
        // points, which is exactly Electron's `screen` DIP space — so no
        // conversion is needed here. This backend is the reference for the
        // coordinate contract in ADR-0010.
        let event = CGEvent::new_mouse_event(
            source()?,
            CGEventType::MouseMoved,
            CGPoint::new(x, y),
            CGMouseButton::Left,
        )
        .map_err(|_| MouseError::Backend("could not create mouse-move event".into()))?;
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn click(&mut self, button: Button, count: u8) -> Result<(), MouseError> {
        let (down_ty, up_ty, cg_button) = buttons(button);
        let (x, y) = self.cursor_position()?;
        let at = CGPoint::new(x, y);

        // For a double-click macOS expects the full sequence with an
        // incrementing click state: down/up at state 1, then down/up at state 2.
        for state in 1..=count.max(1) {
            for &ty in &[down_ty, up_ty] {
                let event = CGEvent::new_mouse_event(source()?, ty, at, cg_button)
                    .map_err(|_| MouseError::Backend("could not create click event".into()))?;
                event.set_integer_value_field(
                    EventField::MOUSE_EVENT_CLICK_STATE,
                    i64::from(state),
                );
                event.post(CGEventTapLocation::HID);
            }
        }
        Ok(())
    }

    fn cursor_position(&self) -> Result<(f64, f64), MouseError> {
        let event = CGEvent::new(source()?)
            .map_err(|_| MouseError::Backend("could not read cursor position".into()))?;
        let p = event.location();
        Ok((p.x, p.y))
    }

    fn name(&self) -> &'static str {
        "macos-cgevent"
    }
}
