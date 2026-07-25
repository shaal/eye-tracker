//! Decoding of the packed per-frame payload (ADR-0009).
//!
//! This layout is mirrored by hand in `packages/core/src/ipc/frame-layout.ts`.
//! The width assertion below is the tripwire that turns a drifted layout into a
//! loud error on the first frame instead of silently shifted fields.

use crate::blink::gesture::Closure;

/// Number of `f64` slots in one packed frame. Must equal `FRAME_WIDTH` in
/// `packages/core/src/ipc/frame-layout.ts`.
pub const FRAME_WIDTH: usize = 16;

pub mod slot {
    pub const TIMESTAMP: usize = 0;
    pub const OK: usize = 1;
    pub const QUALITY: usize = 2;
    pub const GX: usize = 3;
    pub const GY: usize = 4;
    pub const DGX: usize = 5;
    pub const YAW: usize = 6;
    pub const PITCH: usize = 7;
    pub const ROLL: usize = 8;
    pub const HX: usize = 9;
    pub const HY: usize = 10;
    pub const HZ: usize = 11;
    /// Openness / closure are resolved to the SUBJECT'S OWN left and right by
    /// the renderer before packing (ADR-0013). Gaze features remain symmetric.
    pub const OPEN_LEFT: usize = 12;
    pub const OPEN_RIGHT: usize = 13;
    pub const BLINK_LEFT: usize = 14;
    pub const BLINK_RIGHT: usize = 15;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// The TS and Rust layouts have diverged.
    BadWidth { got: usize, want: usize },
    /// A non-finite value reached us. Left unchecked, a single NaN propagates
    /// through the regression into the cursor position and the cursor
    /// disappears — so we reject the frame at the boundary instead.
    NotFinite { slot: usize },
}

impl core::fmt::Display for FrameError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FrameError::BadWidth { got, want } => write!(
                f,
                "packed frame width {got} != expected {want}; \
                 frame-layout.ts and frame.rs have diverged (ADR-0009)"
            ),
            FrameError::NotFinite { slot } => {
                write!(f, "packed frame slot {slot} was NaN or infinite")
            }
        }
    }
}

/// One frame of gaze features, already normalized by the renderer (ADR-0005).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct GazeFrame {
    /// Monotonic milliseconds, stamped at frame acquisition in the renderer.
    pub t_ms: f64,
    /// Whether a face was detected at all.
    pub ok: bool,
    /// Tracking confidence, 0..1.
    pub quality: f64,

    /// Mean normalized horizontal iris offset — primary gaze signal.
    pub gx: f64,
    /// Mean normalized vertical iris offset.
    pub gy: f64,
    /// abs(gxA - gxB), vergence proxy.
    pub dgx: f64,

    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,

    /// Head position in frame, centered (nose tip).
    pub hx: f64,
    pub hy: f64,
    /// Inverse interocular distance — a distance proxy that is closer to linear
    /// in physical distance than the distance itself (ADR-0005).
    pub hz: f64,

    /// Subject's own left/right (ADR-0013).
    pub open_left: f64,
    pub open_right: f64,
    pub blink_left: f64,
    pub blink_right: f64,
}

impl GazeFrame {
    pub fn decode(s: &[f64]) -> Result<Self, FrameError> {
        if s.len() != FRAME_WIDTH {
            return Err(FrameError::BadWidth { got: s.len(), want: FRAME_WIDTH });
        }
        for (i, v) in s.iter().enumerate() {
            if !v.is_finite() {
                return Err(FrameError::NotFinite { slot: i });
            }
        }
        Ok(GazeFrame {
            t_ms: s[slot::TIMESTAMP],
            ok: s[slot::OK] != 0.0,
            quality: s[slot::QUALITY],
            gx: s[slot::GX],
            gy: s[slot::GY],
            dgx: s[slot::DGX],
            yaw: s[slot::YAW],
            pitch: s[slot::PITCH],
            roll: s[slot::ROLL],
            hx: s[slot::HX],
            hy: s[slot::HY],
            hz: s[slot::HZ],
            open_left: s[slot::OPEN_LEFT],
            open_right: s[slot::OPEN_RIGHT],
            blink_left: s[slot::BLINK_LEFT],
            blink_right: s[slot::BLINK_RIGHT],
        })
    }

    /// Per-eye closure from blendshapes.
    #[inline]
    pub fn closure(&self) -> Closure {
        Closure { left: self.blink_left, right: self.blink_right }
    }

    /// Geometric fallback closure, used when blendshapes are unavailable.
    /// Openness is height/width, so closure is its complement against a
    /// nominal open ratio.
    #[inline]
    pub fn geometric_closure(&self, open_ratio_at_rest: f64) -> Closure {
        let f = |open: f64| {
            if open_ratio_at_rest <= f64::EPSILON {
                0.0
            } else {
                (1.0 - open / open_ratio_at_rest).clamp(0.0, 1.0)
            }
        };
        Closure { left: f(self.open_left), right: f(self.open_right) }
    }

    /// Head-pose vector in the order used for drift reporting:
    /// yaw, pitch, roll, hx, hy, hz.
    #[inline]
    pub fn pose(&self) -> [f64; 6] {
        [self.yaw, self.pitch, self.roll, self.hx, self.hy, self.hz]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Vec<f64> {
        let mut v = vec![0.0; FRAME_WIDTH];
        v[slot::TIMESTAMP] = 1000.0;
        v[slot::OK] = 1.0;
        v[slot::QUALITY] = 0.9;
        v[slot::GX] = 0.1;
        v[slot::GY] = -0.2;
        v[slot::BLINK_LEFT] = 0.3;
        v[slot::BLINK_RIGHT] = 0.7;
        v
    }

    #[test]
    fn decodes_all_fields() {
        let f = GazeFrame::decode(&valid()).unwrap();
        assert_eq!(f.t_ms, 1000.0);
        assert!(f.ok);
        assert_eq!(f.quality, 0.9);
        assert_eq!(f.gx, 0.1);
        assert_eq!(f.gy, -0.2);
        assert_eq!(f.blink_left, 0.3);
        assert_eq!(f.blink_right, 0.7);
    }

    #[test]
    fn rejects_wrong_width() {
        let err = GazeFrame::decode(&[0.0; 8]).unwrap_err();
        assert_eq!(err, FrameError::BadWidth { got: 8, want: FRAME_WIDTH });
    }

    #[test]
    fn rejects_nan() {
        let mut v = valid();
        v[slot::GX] = f64::NAN;
        assert_eq!(
            GazeFrame::decode(&v).unwrap_err(),
            FrameError::NotFinite { slot: slot::GX }
        );
    }

    #[test]
    fn both_eye_closure_requires_both_eyes() {
        let f = GazeFrame::decode(&valid()).unwrap();
        // One eye at 0.7 but the other at 0.3 must not read as a blink.
        assert_eq!(f.closure().both(), 0.3);
        // But it does count as "an eyelid is moving", for the cursor freeze.
        assert_eq!(f.closure().any(), 0.7);
    }

    #[test]
    fn pose_vector_is_ordered() {
        let mut v = valid();
        v[slot::YAW] = 0.1;
        v[slot::PITCH] = 0.2;
        v[slot::ROLL] = 0.3;
        v[slot::HX] = 0.4;
        v[slot::HY] = 0.5;
        v[slot::HZ] = 0.6;
        let f = GazeFrame::decode(&v).unwrap();
        assert_eq!(f.pose(), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    }
}
