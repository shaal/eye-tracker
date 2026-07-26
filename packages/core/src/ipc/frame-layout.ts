/**
 * Packed per-frame payload layout (ADR-0009).
 *
 * MIRRORED BY HAND in `packages/native/crates/core/src/frame.rs`. If you change
 * anything here, change it there too — `FRAME_WIDTH` is asserted on the Rust
 * side on every frame, so a mismatch fails loudly rather than silently shifting
 * fields.
 */

export const FRAME_SLOTS = {
  /** Monotonic ms, stamped at frame acquisition in the renderer. */
  TIMESTAMP: 0,
  /** 1 when a face was detected, 0 otherwise. */
  OK: 1,
  /** Tracking confidence, 0..1. */
  QUALITY: 2,
  /** Mean normalized horizontal iris offset — the primary gaze signal. */
  GX: 3,
  /** Mean normalized vertical iris offset. */
  GY: 4,
  /** abs(gxA - gxB) — vergence proxy for fixation depth. */
  DGX: 5,
  YAW: 6,
  PITCH: 7,
  ROLL: 8,
  /** Head position in frame (nose tip), centered on 0. */
  HX: 9,
  HY: 10,
  /** Inverse interocular distance — a distance proxy (ADR-0005). */
  HZ: 11,
  /**
   * Openness and closure are resolved to the SUBJECT'S OWN left and right
   * before packing (ADR-0013), because wink gestures need to distinguish them.
   * Gaze features above remain symmetric and are unaffected.
   */
  OPEN_LEFT: 12,
  OPEN_RIGHT: 13,
  BLINK_LEFT: 14,
  BLINK_RIGHT: 15,
  /**
   * The vertical iris offset measured against the eyelid aperture centre
   * instead of the eye-corner midpoint (ADR-0025).
   *
   * Sent alongside `GY` rather than replacing it, deliberately. Which basis the
   * calibration fit consumes is a Rust-side switch, so shipping both means the
   * A/B costs one `f64` per frame instead of a rebuild — and a session recorded
   * today can answer the question offline for either basis.
   */
  GY_APERTURE: 16,
} as const;

export const FRAME_WIDTH = 17;

export type FrameSlot = (typeof FRAME_SLOTS)[keyof typeof FRAME_SLOTS];

/** Human-readable view of a packed frame. For logging only — never on the hot path. */
export function decodeFrame(f: Float64Array): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, slot] of Object.entries(FRAME_SLOTS)) {
    out[name] = f[slot] ?? Number.NaN;
  }
  return out;
}

/**
 * Assert the TS and Rust layouts agree. Called once at startup with the width
 * reported by the native addon.
 */
export function assertFrameLayout(nativeWidth: number): void {
  if (nativeWidth !== FRAME_WIDTH) {
    throw new Error(
      `Frame layout mismatch: native expects ${nativeWidth} slots, TypeScript packs ${FRAME_WIDTH}. ` +
        `frame-layout.ts and frame.rs have diverged (ADR-0009).`,
    );
  }
}
