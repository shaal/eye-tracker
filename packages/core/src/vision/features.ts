/**
 * Landmarks → roll-invariant, scale-free gaze features (ADR-0005).
 *
 * This is the one place that knows MediaPipe's coordinate conventions. It runs
 * in the renderer, is pure, and allocates nothing per frame beyond a couple of
 * small objects.
 */

import {
  BLINK_SHAPE_LEFT,
  BLINK_SHAPE_RIGHT,
  EYE_A,
  EYE_B,
  NOSE_TIP,
  type EyeLandmarks,
} from './landmarks.js';
import { FRAME_SLOTS, FRAME_WIDTH } from '../ipc/frame-layout.js';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface FaceInput {
  /** 478 normalized landmarks (x, y in 0..1 of the frame). */
  landmarks: readonly Landmark[];
  /** Blendshape scores by name, if the model emitted them. */
  blendshapes?: Readonly<Record<string, number>>;
  /** 4×4 facial transformation matrix, column-major. */
  transform?: ArrayLike<number> | undefined;
}

export interface FeatureOptions {
  /**
   * Swap which physical eye counts as the subject's left.
   *
   * Needed for cameras that deliver hardware-mirrored frames, where both the
   * blendshape naming and the image-x geometry come out inverted. Only affects
   * wink gestures (ADR-0013); gaze is symmetric and unchanged either way.
   */
  swapEyes?: boolean;
}

/** Per-eye intermediate measurements, exposed for the debug HUD. */
export interface EyeMeasure {
  /** Normalized iris offset along the eye's own axis. */
  gx: number;
  gy: number;
  /** Eye width in frame units — the normalizer. */
  width: number;
  centerX: number;
  centerY: number;
  /** Unit vector along the eye's long axis, pointing +x in image space. */
  ux: number;
  uy: number;
  irisX: number;
  irisY: number;
  /** Eye-aspect ratio: lid separation over eye width. */
  openness: number;
}

export interface GazeFeatures {
  ok: boolean;
  quality: number;
  gx: number;
  gy: number;
  dgx: number;
  yaw: number;
  pitch: number;
  roll: number;
  hx: number;
  hy: number;
  hz: number;
  /** Resolved to the subject's own left/right (ADR-0013). */
  openLeft: number;
  openRight: number;
  blinkLeft: number;
  blinkRight: number;
  /** Interocular distance in frame units, for the HUD. */
  interocular: number;
  /** Geometric eyes, in landmark order — symmetric, not left/right resolved. */
  eyeA: EyeMeasure;
  eyeB: EyeMeasure;
}

const EPS = 1e-9;

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Measure one eye in its own frame of reference.
 *
 * The basis is built from the eye's own corner landmarks, so it rotates with
 * the head — that is what makes `gx`/`gy` invariant to head roll. Dividing by
 * the eye width makes them invariant to camera distance and frame resolution.
 *
 * The corners are ordered by image x rather than by anatomy. This matters: the
 * two eyes' corner landmarks are anatomically mirrored, so a fixed
 * inner→outer ordering would give the two eyes ANTI-PARALLEL basis vectors,
 * and averaging their `gx` would cancel the signal instead of reinforcing it.
 * Ordering by x makes both bases point the same way in image space.
 */
function measureEye(lm: readonly Landmark[], eye: EyeLandmarks): EyeMeasure | null {
  const c0 = lm[eye.corners[0]];
  const c1 = lm[eye.corners[1]];
  const iris = lm[eye.irisCenter];
  if (!c0 || !c1 || !iris) return null;

  const [pLo, pHi] = c0.x <= c1.x ? [c0, c1] : [c1, c0];

  const rawUx = pHi.x - pLo.x;
  const rawUy = pHi.y - pLo.y;
  const width = Math.hypot(rawUx, rawUy);
  if (width < EPS) return null;

  const ux = rawUx / width;
  const uy = rawUy / width;
  // Perpendicular, pointing +y (downward in image coordinates).
  const vx = -uy;
  const vy = ux;

  const centerX = (pLo.x + pHi.x) / 2;
  const centerY = (pLo.y + pHi.y) / 2;

  const dx = iris.x - centerX;
  const dy = iris.y - centerY;

  const gx = (dx * ux + dy * uy) / width;
  const gy = (dx * vx + dy * vy) / width;

  // Eye-aspect ratio from the six canonical lid points.
  const [e1, e2, e3, e4, e5, e6] = eye.ear.map((i) => lm[i]);
  let openness = 0;
  if (e1 && e2 && e3 && e4 && e5 && e6) {
    const horizontal = dist(e1, e4);
    if (horizontal > EPS) {
      openness = (dist(e2, e6) + dist(e3, e5)) / (2 * horizontal);
    }
  }

  return { gx, gy, width, centerX, centerY, ux, uy, irisX: iris.x, irisY: iris.y, openness };
}

/**
 * Euler angles from the 4×4 facial transformation matrix (column-major).
 *
 * The exact convention does not matter much — the regression only needs smooth,
 * monotonic functions of head rotation — but the gimbal-lock branch does, since
 * a NaN here would poison the whole feature vector.
 */
function headPose(m: ArrayLike<number> | undefined): {
  yaw: number;
  pitch: number;
  roll: number;
} {
  if (!m || m.length < 12) return { yaw: 0, pitch: 0, roll: 0 };

  // Column-major: column c, row r is at m[c * 4 + r].
  const r00 = m[0] ?? 0;
  const r10 = m[1] ?? 0;
  const r20 = m[2] ?? 0;
  const r11 = m[5] ?? 0;
  const r12 = m[9] ?? 0;
  const r21 = m[6] ?? 0;
  const r22 = m[10] ?? 0;

  const sy = Math.hypot(r00, r10);
  if (sy < 1e-6) {
    return { pitch: Math.atan2(-r12, r11), yaw: Math.atan2(-r20, sy), roll: 0 };
  }
  return {
    pitch: Math.atan2(r21, r22),
    yaw: Math.atan2(-r20, sy),
    roll: Math.atan2(r10, r00),
  };
}

/**
 * Heuristic tracking confidence. MediaPipe does not report a per-face score, so
 * we derive one from conditions known to degrade gaze accuracy. Used by the
 * quality guard (ADR-0011) and to reject calibration samples.
 */
function estimateQuality(
  interocular: number,
  yaw: number,
  pitch: number,
  openness: number,
): number {
  let q = 1;

  // Too far from the camera: the iris crop the refinement model works from
  // becomes too small to localize precisely.
  if (interocular < 0.06) q *= clamp(interocular / 0.06, 0, 1);

  // Extreme head rotation foreshortens the eye and the 2-D normalization stops
  // holding.
  q *= clamp(1 - Math.abs(yaw) / 1.0, 0.15, 1);
  q *= clamp(1 - Math.abs(pitch) / 0.8, 0.15, 1);

  // A partly closed lid occludes the iris.
  if (openness < 0.15) q *= clamp(openness / 0.15, 0, 1);

  return clamp(q, 0, 1);
}

/** Zeroed measure, so callers never have to handle nulls downstream. */
const NO_EYE: EyeMeasure = {
  gx: 0,
  gy: 0,
  width: 0,
  centerX: 0,
  centerY: 0,
  ux: 1,
  uy: 0,
  irisX: 0,
  irisY: 0,
  openness: 0,
};

export const NO_FACE: GazeFeatures = {
  ok: false,
  quality: 0,
  gx: 0,
  gy: 0,
  dgx: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  openLeft: 0,
  openRight: 0,
  blinkLeft: 0,
  blinkRight: 0,
  interocular: 0,
  eyeA: NO_EYE,
  eyeB: NO_EYE,
};

export function extractFeatures(input: FaceInput, options: FeatureOptions = {}): GazeFeatures {
  const { landmarks, blendshapes, transform } = input;
  const swap = options.swapEyes ?? false;

  const a = measureEye(landmarks, EYE_A);
  const b = measureEye(landmarks, EYE_B);
  const nose = landmarks[NOSE_TIP];
  if (!a || !b || !nose) return NO_FACE;

  const { yaw, pitch, roll } = headPose(transform);

  const interocular = Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY);

  // Both eyes' bases point the same way in image space, so the mean reinforces
  // rather than cancels. Symmetric under an A/B swap by construction.
  const gx = (a.gx + b.gx) / 2;
  const gy = (a.gy + b.gy) / 2;
  const dgx = Math.abs(a.gx - b.gx);

  const hx = nose.x - 0.5;
  const hy = nose.y - 0.5;
  // Inverse interocular distance: closer to linear in physical distance than
  // the raw separation, which matters for a model that is only quadratic.
  const hz = interocular > EPS ? 1 / interocular : 0;

  // Blendshapes are named in the subject's own frame (ARKit convention), so
  // they resolve left/right directly.
  const shapeLeft = blendshapes?.[BLINK_SHAPE_LEFT] ?? 0;
  const shapeRight = blendshapes?.[BLINK_SHAPE_RIGHT] ?? 0;

  // Geometric openness has no names, so resolve it by position: in an
  // unmirrored frame the subject's LEFT eye appears at the LARGER image x,
  // because the subject faces the camera.
  const [geomLeft, geomRight] = a.centerX >= b.centerX ? [a, b] : [b, a];

  const blinkLeft = swap ? shapeRight : shapeLeft;
  const blinkRight = swap ? shapeLeft : shapeRight;
  const openLeft = swap ? geomRight.openness : geomLeft.openness;
  const openRight = swap ? geomLeft.openness : geomRight.openness;

  const quality = estimateQuality(interocular, yaw, pitch, Math.min(a.openness, b.openness));

  return {
    ok: true,
    quality,
    gx,
    gy,
    dgx,
    yaw,
    pitch,
    roll,
    hx,
    hy,
    hz,
    openLeft,
    openRight,
    blinkLeft,
    blinkRight,
    interocular,
    eyeA: a,
    eyeB: b,
  };
}

/**
 * Write features into a reusable buffer (ADR-0009). The renderer keeps one
 * `Float64Array` for the life of the session, so the vision loop allocates
 * nothing in steady state.
 */
export function packFrame(out: Float64Array, tMs: number, f: GazeFeatures): Float64Array {
  if (out.length !== FRAME_WIDTH) {
    throw new Error(`packFrame expects a Float64Array(${FRAME_WIDTH}), got ${out.length}`);
  }
  out[FRAME_SLOTS.TIMESTAMP] = tMs;
  out[FRAME_SLOTS.OK] = f.ok ? 1 : 0;
  out[FRAME_SLOTS.QUALITY] = f.quality;
  out[FRAME_SLOTS.GX] = f.gx;
  out[FRAME_SLOTS.GY] = f.gy;
  out[FRAME_SLOTS.DGX] = f.dgx;
  out[FRAME_SLOTS.YAW] = f.yaw;
  out[FRAME_SLOTS.PITCH] = f.pitch;
  out[FRAME_SLOTS.ROLL] = f.roll;
  out[FRAME_SLOTS.HX] = f.hx;
  out[FRAME_SLOTS.HY] = f.hy;
  out[FRAME_SLOTS.HZ] = f.hz;
  out[FRAME_SLOTS.OPEN_LEFT] = f.openLeft;
  out[FRAME_SLOTS.OPEN_RIGHT] = f.openRight;
  out[FRAME_SLOTS.BLINK_LEFT] = f.blinkLeft;
  out[FRAME_SLOTS.BLINK_RIGHT] = f.blinkRight;
  return out;
}

/**
 * Guard against non-finite values before they cross the IPC boundary. Rust
 * rejects them too, but catching it here names the offending field.
 */
export function findNonFinite(f: Float64Array): number | null {
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v === undefined || !Number.isFinite(v)) return i;
  }
  return null;
}
