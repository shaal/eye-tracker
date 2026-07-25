/**
 * MediaPipe Face Landmarker index constants (ADR-0003, ADR-0005).
 *
 * ## Why these are called A and B, not left and right
 *
 * Sources disagree on whether MediaPipe's "left eye" means the subject's left
 * or the viewer's left, and the answer flips again depending on whether the
 * video element is mirrored. Getting it backwards does not crash — it produces
 * a tracker that works but is quietly worse, because the two eyes' geometric
 * features end up swapped relative to their blendshape scores.
 *
 * Rather than rely on being right about it, the pipeline is built so that
 * swapping the two eyes is harmless: gaze uses their mean, vergence uses an
 * absolute difference, and blink uses their minimum. All three are symmetric.
 * Naming them A and B keeps anyone from assuming a semantics we do not
 * guarantee.
 */

/** Total landmarks when the iris refinement submodel is present. */
export const LANDMARK_COUNT = 478;

/** Nose tip — used as the head-position reference. */
export const NOSE_TIP = 1;

export interface EyeLandmarks {
  /** The two corner landmarks. Order is resolved at runtime by image x. */
  readonly corners: readonly [number, number];
  /** Iris center, from the iris refinement submodel. */
  readonly irisCenter: number;
  /** The four iris rim points. */
  readonly irisRim: readonly [number, number, number, number];
  /**
   * Six points for the eye-aspect ratio, in the canonical EAR order:
   * [outer, upper1, upper2, inner, lower2, lower1].
   */
  readonly ear: readonly [number, number, number, number, number, number];
}

export const EYE_A: EyeLandmarks = {
  corners: [33, 133],
  irisCenter: 468,
  irisRim: [469, 470, 471, 472],
  ear: [33, 160, 158, 133, 153, 144],
};

export const EYE_B: EyeLandmarks = {
  corners: [362, 263],
  irisCenter: 473,
  irisRim: [474, 475, 476, 477],
  ear: [362, 385, 387, 263, 373, 380],
};

/**
 * Blendshape names for eyelid closure, following the ARKit convention that
 * MediaPipe reproduces: these are the **subject's own** left and right.
 *
 * For plain blink mode the distinction is irrelevant — blink uses `min(a, b)`.
 * It matters for wink mode (ADR-0013), where left and right map to different
 * mouse buttons, which is why `extractFeatures` accepts a `swapEyes` option for
 * cameras that deliver hardware-mirrored frames.
 */
export const BLINK_SHAPE_LEFT = 'eyeBlinkLeft';
export const BLINK_SHAPE_RIGHT = 'eyeBlinkRight';
export const BLINK_SHAPES = [BLINK_SHAPE_LEFT, BLINK_SHAPE_RIGHT] as const;

/**
 * The iris landmarks only exist when the model bundle includes the refinement
 * submodel. A 468-landmark result means we are running a face-mesh-only model
 * and gaze estimation is impossible.
 */
export function hasIrisLandmarks(count: number): boolean {
  return count >= LANDMARK_COUNT;
}
