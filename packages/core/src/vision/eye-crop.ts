/**
 * The eye-aligned crop box, in source-frame pixels.
 *
 * Two very different consumers want the *same* rectangle, and it matters that
 * they agree: the eye-zoom debug view (`debug/eye-zoom.ts`) magnifies it so a
 * human can judge the sensor, and the session recorder writes it to disk as
 * training data (ADR-0022). If those drifted apart, the pixels a user inspected
 * while deciding "the tracking looks fine" would not be the pixels a model was
 * later trained on.
 */

import type { EyeMeasure } from './features.js';

/**
 * How much of the eye width to show on each side of it.
 *
 * 1.0 would clip the lids. 0.55 puts the box at 2.1× the eye width — at
 * 1280×720 and a normal seating distance that is ~242 px across for a ~115 px
 * eye, which keeps the brow, the outer canthus and a margin of cheek inside the
 * frame. Head-pose normalization (#32) warps within this box offline, so the
 * margin is what stops that warp from running off the edge when the head is
 * turned.
 */
export const CROP_MARGIN = 0.55;

/** A rectangle in the camera frame's own pixel coordinates. */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The crop rectangle for one eye at a given output aspect ratio.
 *
 * Sized from the eye's *own* width rather than a fixed pixel count, so the
 * magnification stays constant as the user moves toward or away from the
 * camera — otherwise leaning in would look like the tracking improved, and a
 * recorded dataset would silently vary in scale with seating distance.
 *
 * The box is **not** clamped to the frame. Clamping would change the scale and
 * shift the eye off centre, which is worse for both consumers than a few
 * transparent pixels: `drawImage` and `createImageBitmap` both treat the region
 * outside the source as transparent black. Offline consumers should expect a
 * box that can extend past the frame edge when the user sits near it.
 *
 * Returns `null` when the eye has no measured width — a lost face — because
 * there is no meaningful rectangle to return and a zero-sized one would be a
 * silently invalid image.
 */
export function eyeCropBox(
  measure: EyeMeasure,
  frameWidth: number,
  frameHeight: number,
  outputAspect: number,
): CropBox | null {
  if (!(measure.width > 0) || frameWidth <= 0 || frameHeight <= 0) return null;

  const width = measure.width * frameWidth * (1 + 2 * CROP_MARGIN);
  const height = width * outputAspect;

  return {
    x: measure.centerX * frameWidth - width / 2,
    y: measure.centerY * frameHeight - height / 2,
    width,
    height,
  };
}
