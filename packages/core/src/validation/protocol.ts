/**
 * Validation protocol — measuring how wrong the tracker actually is.
 *
 * Calibration's own cross-validation (`fit.rs`) holds out one *target* at a
 * time, but it can only ever score the nine locations it was trained on, and it
 * scores them against the same fixation data the fit already saw. Validation is
 * a separate pass: fresh fixations, at locations the model was not fitted to,
 * scored against where the model says you are looking right now.
 *
 * The two numbers it produces have opposite remedies, which is the whole reason
 * to separate them:
 *
 *   accuracy  — how far the *mean* prediction sits from the target. Systematic.
 *               Fixed by recalibrating, or by a bias offset.
 *   precision — how much the prediction scatters around its own mean. Random.
 *               Recalibrating cannot help; only better light, a better sensor,
 *               sitting closer, or more smoothing will.
 *
 * Reporting a single "error" number conflates them and sends you to the wrong
 * fix roughly half the time.
 */

import type { Point, ScreenBounds } from '../types.js';

/**
 * Validation targets run longer than calibration targets. Calibration only
 * needs the fixation's centroid; validation needs its *spread*, and a spread
 * estimated from a handful of samples is mostly noise itself.
 */
export const VALIDATION_TIMING = {
  settleMs: 700,
  collectMs: 900,
  discardMs: 250,
  gapMs: 200,
} as const;

/**
 * Where validation dots go, as fractions of the work area.
 *
 * Deliberately offset from the calibration grid (which sits at 0.10/0.50/0.90
 * for 9-point and 0.15/0.50/0.85 for 5-point, see `target_grid`). Testing at
 * the points you trained on measures memorization, not generalization — and
 * generalization is exactly what fails when the cursor "doesn't follow you".
 *
 * The centre is the one shared location, kept on purpose: it is the pose the
 * model is most confident about, so a large error *there* means something is
 * wrong that no amount of recalibration will fix.
 *
 * The order is fixed but scrambled so consecutive dots are never adjacent. Two
 * reasons: a predictable sweep lets you anticipate the next dot and start the
 * saccade early, and a spatially ordered sweep would let slow drift over the
 * run masquerade as a spatial error pattern.
 */
const VALIDATION_GRID: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.8],
  [0.5, 0.18],
  [0.35, 0.65],
  [0.82, 0.5],
  [0.2, 0.8],
  [0.65, 0.35],
  [0.5, 0.82],
  [0.8, 0.2],
  [0.35, 0.35],
  [0.18, 0.5],
  [0.65, 0.65],
];

export const VALIDATION_POINT_COUNT = VALIDATION_GRID.length;

export const VALIDATION_PROMPT = 'Look at the dot — sit as you normally would';

export function validationTargets(bounds: ScreenBounds): Point[] {
  return VALIDATION_GRID.map(([fx, fy]) => ({
    x: bounds.x + bounds.width * fx,
    y: bounds.y + bounds.height * fy,
  }));
}

export function validationDurationMs(targetCount = VALIDATION_POINT_COUNT): number {
  const { settleMs, collectMs, gapMs } = VALIDATION_TIMING;
  return targetCount * (settleMs + collectMs + gapMs);
}

/**
 * Below this many accepted samples a target's precision estimate is too noisy
 * to report, so the target is dropped from the summary rather than quietly
 * contributing a bad number.
 */
export const MIN_VALIDATION_SAMPLES = 8;

/** Verdict bands, in degrees of visual angle. */
export function accuracyVerdict(deg: number): 'good' | 'usable' | 'poor' {
  if (deg < 1.0) return 'good';
  if (deg < 2.0) return 'usable';
  return 'poor';
}

/**
 * Precision bands. Tighter than the accuracy bands because precision sets the
 * floor: whatever the accuracy is, you cannot reliably hit a target smaller
 * than roughly the precision cloud, no matter how well calibrated you are.
 */
export function precisionVerdict(deg: number): 'good' | 'usable' | 'poor' {
  if (deg < 0.5) return 'good';
  if (deg < 1.0) return 'usable';
  return 'poor';
}

/**
 * Turn the two numbers into the action that actually follows from them.
 *
 * This exists so the UI never just prints an error and leaves the user to guess
 * — the whole point of splitting accuracy from precision is that they imply
 * different fixes.
 */
export function diagnose(accuracyDeg: number, precisionDeg: number): string {
  const acc = accuracyVerdict(accuracyDeg);
  const prec = precisionVerdict(precisionDeg);

  if (prec === 'poor') {
    return (
      'The signal itself is noisy — the prediction scatters this much even while you hold ' +
      'a fixation. Recalibrating will not help. Add light on your face, sit closer, or use ' +
      'a better camera. Check the eye zoom view: the iris outline should sit still.'
    );
  }
  if (acc === 'poor') {
    return (
      'The tracking is steady but systematically off-target — the mapping is wrong rather ' +
      'than noisy. Recalibrate, sitting in the pose you actually use, and look precisely at ' +
      'the centre of each dot.'
    );
  }
  if (acc === 'usable' || prec === 'usable') {
    return (
      'Usable, but not tight. Recalibrating in your normal pose usually gains a few tenths ' +
      'of a degree; so does more light on your face.'
    );
  }
  return 'Good — this is about as accurate as a webcam tracker gets.';
}
