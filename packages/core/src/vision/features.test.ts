/**
 * Tests for the landmark → gaze feature extraction (ADR-0005, ADR-0025).
 *
 * Three of these guard invariants ADR-0005 was built on — roll invariance,
 * scale invariance, and symmetry under an A/B eye swap. They matter more than
 * they look: a reference or weighting bug that broke eye-swap symmetry would
 * produce a constant offset in the fitted model, which is indistinguishable
 * from an ordinary calibration offset and would never be reported as a bug.
 *
 * The rest are ADR-0025's case: that measuring vertical gaze against the eyelid
 * aperture recovers a monotone signal where the eye-corner reference folds.
 *
 * Run with `npm run test:core`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractFeatures, type FaceInput, type Landmark } from './features.js';
import { EYE_A, EYE_B, LANDMARK_COUNT, NOSE_TIP } from './landmarks.js';

/** Geometry of one synthetic eye, in eye-width units before placement. */
interface EyeShape {
  /** Iris centre offset along the eye's long axis. */
  irisX: number;
  /** Iris centre offset perpendicular to it, +y downward in image space. */
  irisY: number;
  /** Upper-lid margin offset, negative being above the corner line. */
  upper: number;
  /** Lower-lid margin offset. */
  lower: number;
}

const OPEN_EYE: EyeShape = { irisX: 0, irisY: 0, upper: -0.22, lower: 0.2 };

interface FaceShape {
  a: EyeShape;
  b: EyeShape;
  /** Eye width as a fraction of the frame. */
  width?: number;
  /** Head roll in radians. */
  roll?: number;
  /** Frame-space centre of the whole face. */
  cx?: number;
  cy?: number;
  /** Half the interocular distance, in eye widths. */
  separation?: number;
}

/**
 * Build a 478-landmark face carrying exactly the points `extractFeatures`
 * reads: two corners, an iris centre and four lid points per eye, plus the nose.
 *
 * Everything is laid out in a per-eye local frame first — corners at ±0.5 on the
 * x axis, the corner midpoint at the origin — and then rotated by `roll` and
 * scaled by `width`. That ordering is what makes the invariance tests below
 * meaningful: roll and scale are applied to a shape that was built without any
 * knowledge of them.
 */
function face(shape: FaceShape): FaceInput {
  const width = shape.width ?? 0.12;
  const roll = shape.roll ?? 0;
  const cx = shape.cx ?? 0.5;
  const cy = shape.cy ?? 0.45;
  const sep = shape.separation ?? 1.1;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);

  const landmarks: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));

  const place = (u: number, v: number): Landmark => ({
    x: cx + width * (u * cos - v * sin),
    y: cy + width * (u * sin + v * cos),
    z: 0,
  });

  const eyes: [typeof EYE_A, EyeShape, number][] = [
    [EYE_A, shape.a, -sep],
    [EYE_B, shape.b, +sep],
  ];
  for (const [eye, s, offset] of eyes) {
    landmarks[eye.corners[0]] = place(offset - 0.5, 0);
    landmarks[eye.corners[1]] = place(offset + 0.5, 0);
    landmarks[eye.irisCenter] = place(offset + s.irisX, s.irisY);
    // The EAR points: corners at slots 0 and 3, upper lid at 1 and 2, lower at
    // 4 and 5. Placed symmetrically about the eye centre so the lid midpoints
    // sit exactly on the margins the model specifies.
    landmarks[eye.ear[1]] = place(offset - 0.2, s.upper);
    landmarks[eye.ear[2]] = place(offset + 0.2, s.upper);
    landmarks[eye.ear[4]] = place(offset + 0.2, s.lower);
    landmarks[eye.ear[5]] = place(offset - 0.2, s.lower);
  }
  landmarks[NOSE_TIP] = place(0, 1.4);

  return { landmarks };
}

// ---------------------------------------------------------------------------
// ADR-0005 invariants
// ---------------------------------------------------------------------------

test('both vertical references are invariant to head roll', () => {
  const shape: FaceShape = {
    a: { irisX: 0.12, irisY: 0.06, upper: -0.1, lower: 0.2 },
    b: { irisX: 0.12, irisY: 0.06, upper: -0.1, lower: 0.2 },
  };
  const upright = extractFeatures(face(shape));
  const tilted = extractFeatures(face({ ...shape, roll: 0.28 })); // ~16°

  assert.ok(upright.ok && tilted.ok);
  assert.ok(Math.abs(tilted.gx - upright.gx) < 1e-12, `gx moved: ${tilted.gx - upright.gx}`);
  assert.ok(Math.abs(tilted.gy - upright.gy) < 1e-12, `gy moved: ${tilted.gy - upright.gy}`);
  assert.ok(
    Math.abs(tilted.gyAperture - upright.gyAperture) < 1e-12,
    `gyAperture moved: ${tilted.gyAperture - upright.gyAperture}`,
  );
});

test('both vertical references are invariant to camera distance', () => {
  const shape: FaceShape = {
    a: { irisX: -0.08, irisY: 0.11, upper: -0.14, lower: 0.19 },
    b: { irisX: -0.08, irisY: 0.11, upper: -0.14, lower: 0.19 },
  };
  const near = extractFeatures(face({ ...shape, width: 0.17 }));
  const far = extractFeatures(face({ ...shape, width: 0.055 }));

  assert.ok(near.ok && far.ok);
  assert.ok(Math.abs(far.gx - near.gx) < 1e-12);
  assert.ok(Math.abs(far.gy - near.gy) < 1e-12);
  assert.ok(Math.abs(far.gyAperture - near.gyAperture) < 1e-12);
  // …and the normalizer really did change, or the test is vacuous.
  assert.ok(near.interocular > 2 * far.interocular);
});

test('the aperture reference survives an A/B eye swap unchanged', () => {
  // Two *different* eyes, so a reference that quietly favoured one of them
  // would show up. With identical eyes the swap is trivially symmetric and the
  // test would pass whatever the code did.
  const left: EyeShape = { irisX: 0.1, irisY: 0.05, upper: -0.21, lower: 0.18 };
  const right: EyeShape = { irisX: 0.06, irisY: 0.13, upper: -0.09, lower: 0.22 };

  const forward = extractFeatures(face({ a: left, b: right }));
  const swapped = extractFeatures(face({ a: right, b: left }));

  assert.ok(forward.ok && swapped.ok);
  // Within rounding rather than bit-exact: the two eyes sit at different frame
  // positions, so the same geometry is reached through different intermediate
  // values and the last bit can differ. The property is that no *systematic*
  // asymmetry exists, and a reference bug would show up thousands of ULPs out.
  const same = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-12, `${what} moved under an eye swap: ${a} vs ${b}`);
  same(swapped.gx, forward.gx, 'gx');
  same(swapped.gy, forward.gy, 'gy');
  same(swapped.gyAperture, forward.gyAperture, 'gyAperture');
  same(swapped.dgx, forward.dgx, 'dgx');
});

test('a missing lid landmark falls back to the corner reference, not to a partial aperture', () => {
  const shape: FaceShape = { a: OPEN_EYE, b: { ...OPEN_EYE, irisY: 0.09, upper: -0.05 } };
  const intact = extractFeatures(face(shape));

  // One upper-lid point gone, leaving the rest of the eye intact. A half-built
  // aperture centre would still be a number, and a plausible-looking one, which
  // is exactly why the fallback has to be to something known rather than to a
  // reference computed from whatever survived.
  const landmarks = [...face(shape).landmarks];
  delete landmarks[EYE_B.ear[2]];
  const degraded = extractFeatures({ landmarks });

  assert.ok(intact.ok && degraded.ok);
  // Eye A keeps its aperture; eye B falls back to its corner offset.
  const expected = (intact.eyeA.gyAperture + degraded.eyeB.gy) / 2;
  assert.ok(Math.abs(degraded.gyAperture - expected) < 1e-12);
  assert.notEqual(degraded.gyAperture, intact.gyAperture);
});

// ---------------------------------------------------------------------------
// ADR-0025: the fold, and what the aperture reference does to it
// ---------------------------------------------------------------------------

/** Iris radius in eye-width units: an 11.4 mm iris in a 30 mm fissure. */
const IRIS_R = 0.19;

/**
 * Vertical area centroid of a disc of radius `r` centred at `yc`, clipped to
 * the band `[a, b]` — the visible part of an iris between two lid margins, and
 * what a landmark model fitting an iris to visible pixels will report.
 *
 * The *area* centroid, not the midpoint of the visible band. The distinction is
 * the whole model: the midpoint of a doubly-clipped band is by definition the
 * aperture centre, which would make the aperture-relative feature identically
 * zero and every comparison below vacuous.
 */
function visibleIrisCentroid(yc: number, r: number, a: number, b: number): number {
  const lo = Math.max(a - yc, -r);
  const hi = Math.min(b - yc, r);
  const f = (s: number) =>
    s * Math.sqrt(Math.max(r * r - s * s, 0)) +
    r * r * Math.asin(Math.max(-1, Math.min(1, s / r)));
  const area = f(hi) - f(lo);
  if (area <= 0) return yc;
  const moment =
    (2 / 3) *
    (Math.pow(Math.max(r * r - lo * lo, 0), 1.5) - Math.pow(Math.max(r * r - hi * hi, 0), 1.5));
  return yc + moment / area;
}

/**
 * One eye looking `t` of the way down the screen, under a camera mounted above
 * it. `t = 0` is the top row — gaze roughly at the camera, eye wide open —
 * and `t = 1` is the bottom row, in strong downgaze.
 *
 * Lengths are in eye-width units. `K = 0.24` is the ~7 mm the iris centre
 * travels for the ~35° rotation of a 12 mm globe that a laptop screen subtends.
 *
 * Two facts about eyelids drive the failure:
 *
 * - the upper lid margin follows the globe down, but only until it comes to
 *   rest on the cornea, after which it stops;
 * - in strong downgaze the lower lid margin is pushed *up* by the globe, so the
 *   palpebral fissure narrows to a slit.
 *
 * Past the point where the upper lid stalls, the aperture centre therefore
 * moves back *up* while true gaze keeps going down. The measured iris centre is
 * the centroid of whatever is still visible, so it follows the aperture — and
 * the corner-relative offset, whose origin cannot move, records the reversal as
 * if the user had looked back up.
 */
function downgazeEye(t: number): EyeShape {
  const K = 0.24; // iris centre excursion
  const H_UPPER = 0.22; // upper lid margin when wide open
  const L = 0.2; // the upper lid lags the globe slightly…
  const U_SAT = 0.2; // …and stops once it meets the cornea
  const H_LOWER = 0.2;
  const M = 0.26; // lower lid rise in strong downgaze
  const L_START = 0.4;

  const upper = -H_UPPER + L * Math.min(t, U_SAT);
  const lower = H_LOWER - M * Math.max(t - L_START, 0);
  const irisY = visibleIrisCentroid(K * t, IRIS_R, upper, lower);
  return { irisX: 0, irisY, upper, lower };
}

/**
 * Ten rows from the top of the screen to the bottom.
 *
 * Stops at 0.9 rather than 1.0 because past that the model's lids meet and the
 * iris is gone entirely. Nothing recovers gaze from a shut eye, and asserting
 * about that regime would be asserting about the arithmetic of an empty
 * integral rather than about either vertical reference.
 */
function sweep(): { gy: number[]; gyAperture: number[] } {
  const gy: number[] = [];
  const gyAperture: number[] = [];
  for (let i = 0; i <= 9; i++) {
    const eye = downgazeEye(i / 10);
    const f = extractFeatures(face({ a: eye, b: eye }));
    assert.ok(f.ok);
    gy.push(f.gy);
    gyAperture.push(f.gyAperture);
  }
  return { gy, gyAperture };
}

const steps = (v: number[]) => v.slice(1).map((x, i) => x - (v[i] as number));

/**
 * **The claim ADR-0025 rests on.**
 *
 * As the lid descends across the iris, the corner-relative vertical offset
 * stops being a function of gaze and turns over: looking further down makes it
 * come back. A polynomial cannot invert a folded map, which is why #57 measured
 * the vertical channel collapsing to an intercept — 851 px of target range
 * producing 24 px of predicted range — rather than merely losing accuracy.
 */
test('the corner reference folds as the lid descends across the iris', () => {
  const { gy } = sweep();
  const d = steps(gy);

  assert.ok(
    d.some((x) => x > 0),
    'the sweep must rise before it can fold',
  );
  const reversal = d.findIndex((x) => x < 0);
  assert.ok(reversal >= 0, `gy stayed monotone: ${gy.map((v) => v.toFixed(4)).join(', ')}`);

  // And the reversal is not a rounding artefact: the bottom of the screen ends
  // up reading almost the same as a row two-fifths of the way down, so the two
  // are indistinguishable to any function of gy alone.
  const peak = Math.max(...gy);
  const span = peak - Math.min(...gy);
  const givenBack = (peak - (gy.at(-1) as number)) / span;
  // Measured at 0.23: the bottom row reads the same as a row a third of the way
  // down the screen, so no function of gy alone can tell them apart.
  assert.ok(givenBack > 0.2, `the fold gave back only ${givenBack.toFixed(3)} of the range`);
});

/**
 * …and the same landmarks, measured against the lid aperture, do not fold.
 *
 * This is a geometric un-fold rather than a statistical patch: when the lid
 * drops, both the visible iris blob and the aperture centre move, and only the
 * corner midpoint stays put. Referencing the aperture makes the two motions
 * cancel.
 */
test('the aperture reference stays monotone over the same sweep', () => {
  const { gy, gyAperture } = sweep();

  for (const [i, d] of steps(gyAperture).entries()) {
    assert.ok(
      d > 0,
      `aperture gy reversed at step ${i}: ${gyAperture.map((v) => v.toFixed(4)).join(', ')}`,
    );
  }

  // It also spans more, which is the second half of the recovery: the corner
  // reference spends part of its range going backwards.
  const range = (v: number[]) => Math.max(...v) - Math.min(...v);
  // Measured at 0.097 against 0.068 — a 1.44× wider usable span, before even
  // counting that a third of the corner span points the wrong way.
  assert.ok(
    range(gyAperture) > 1.35 * range(gy),
    `aperture range ${range(gyAperture).toFixed(4)} vs corner ${range(gy).toFixed(4)}`,
  );
});

test('a lid that occludes the iris moves the aperture reference less than the corner one', () => {
  // Gaze pinned while the upper lid comes down far enough to cover most of the
  // iris — a hard squint, or the middle of a blink. Under the corner reference
  // the clipped iris centroid slides down while the origin stays put, so this
  // reads as the eye having moved. Under the aperture reference the origin
  // comes down too and most of it cancels.
  //
  // Note the qualifier in the name. For a *shallow* droop that never reaches
  // the iris there is nothing to cancel, and the aperture centre is then lid
  // noise added to a signal that did not need it. That asymmetry is the cost
  // ADR-0025 accepts, and the reason the reference is a switch.
  const open: EyeShape = { irisX: 0, irisY: 0, upper: -0.22, lower: 0.2 };
  const squinting: EyeShape = { ...open, upper: -0.02 };
  const clip = (e: EyeShape): EyeShape => ({
    ...e,
    irisY: visibleIrisCentroid(0, IRIS_R, e.upper, e.lower),
  });

  const a = extractFeatures(face({ a: clip(open), b: clip(open) }));
  const b = extractFeatures(face({ a: clip(squinting), b: clip(squinting) }));
  assert.ok(a.ok && b.ok);

  const cornerShift = Math.abs(b.gy - a.gy);
  const apertureShift = Math.abs(b.gyAperture - a.gyAperture);
  // Measured at 0.070 against 0.030 — the corner reference reports two thirds
  // of a full screen sweep's worth of vertical gaze for an eye that did not
  // move at all.
  assert.ok(cornerShift > 0.05, `the squint must actually move gy, got ${cornerShift}`);
  assert.ok(
    apertureShift < 0.5 * cornerShift,
    `aperture shifted ${apertureShift.toFixed(4)} against corner ${cornerShift.toFixed(4)}`,
  );
});
