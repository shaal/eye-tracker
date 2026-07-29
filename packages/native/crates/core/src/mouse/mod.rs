//! Platform mouse control (ADR-0010).
//!
//! The engine works exclusively in logical (DIP) screen coordinates with a
//! top-left origin over the union of all displays — Electron's `screen` space.
//! Each backend converts to its platform's native space at the boundary.

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(not(target_os = "macos"))]
pub mod fallback;
// Built on every platform, not just the one that uses it, so the mapping stays
// unit-testable from a mac checkout — where nobody would otherwise notice it
// breaking.
pub mod geometry;
pub mod null;
pub mod permissions;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MouseError {
    /// The platform refused to create or post an event.
    Backend(String),
    /// macOS Accessibility authorization is missing. Note that this is not
    /// something the OS reports: `CGEventPost` succeeds and silently does
    /// nothing, so we detect it by checking permission, not by catching a
    /// failure (ADR-0010).
    PermissionDenied,
    Unsupported(String),
}

impl core::fmt::Display for MouseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MouseError::Backend(m) => write!(f, "mouse backend error: {m}"),
            MouseError::PermissionDenied => {
                write!(f, "Accessibility permission is required to control the cursor")
            }
            MouseError::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

pub trait MouseBackend {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), MouseError>;

    /// `count` is the click multiplicity: 1 for a single click, 2 for a
    /// double. On macOS this maps to the event's click-state field, which is
    /// what makes a double-click a *real* double-click rather than two singles.
    fn click(&mut self, button: Button, count: u8) -> Result<(), MouseError>;

    fn cursor_position(&self) -> Result<(f64, f64), MouseError>;

    fn name(&self) -> &'static str;
}

/// Construct the backend for the current platform.
pub fn default_backend() -> Result<Box<dyn MouseBackend>, MouseError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(macos::MacMouse::new()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Box::new(fallback::EnigoMouse::new()?))
    }
}
