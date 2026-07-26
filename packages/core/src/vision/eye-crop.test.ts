/**
 * Tests for the shared eye crop geometry.
 *
 * The property that matters is scale invariance: the same eye recorded from two
 * distances must fill the crop identically. If it did not, seating distance
 * would enter a training set as a systematic change in apparent eye size —
 * correlated with `hz`, which is itself a feature — and the model would learn
 * the room instead of the gaze.
 *
 * Run with `npm run test:core`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CROP_MARGIN, eyeCropBox } from './eye-crop.js';
import type { EyeMeasure } from './features.js';

/** An eye centred at (cx, cy) in normalized frame coordinates. */
function eye(width: number, cx = 0.5, cy = 0.5): EyeMeasure {
  return {
    gx: 0,
    gy: 0,
    width,
    centerX: cx,
    centerY: cy,
    ux: 1,
    uy: 0,
    irisX: cx,
    irisY: cy,
    openness: 0.3,
  };
}

test('the box is centred on the eye and sized from its width', () => {
  const box = eyeCropBox(eye(0.09), 1280, 720, 0.75);
  assert.ok(box);

  // 0.09 × 1280 = 115.2 px eye, × (1 + 2 × 0.55) = 2.1 → 241.9 px across.
  assert.equal(box.width, 0.09 * 1280 * (1 + 2 * CROP_MARGIN));
  assert.equal(box.height, box.width * 0.75);
  assert.equal(box.x + box.width / 2, 640);
  assert.equal(box.y + box.height / 2, 360);
});

test('the eye occupies the same fraction of the box at any distance', () => {
  const near = eyeCropBox(eye(0.14), 1280, 720, 0.75);
  const far = eyeCropBox(eye(0.06), 1280, 720, 0.75);
  assert.ok(near && far);

  const fill = (w: number, boxW: number) => (w * 1280) / boxW;
  assert.ok(Math.abs(fill(0.14, near.width) - fill(0.06, far.width)) < 1e-12);
});

test('the box is not clamped to the frame', () => {
  // An eye near the left edge: the crop runs off it, and it must keep running
  // off it. Sliding the box back inside would silently decentre the eye and
  // make the recorded scale disagree with the recorded crop rectangle.
  const box = eyeCropBox(eye(0.09, 0.03), 1280, 720, 0.75);
  assert.ok(box);
  assert.ok(box.x < 0);
  assert.ok(Math.abs(box.x + box.width / 2 - 0.03 * 1280) < 1e-9);
});

test('a lost face yields no box rather than an empty one', () => {
  assert.equal(eyeCropBox(eye(0), 1280, 720, 0.75), null);
  assert.equal(eyeCropBox(eye(0.09), 0, 720, 0.75), null);
  assert.equal(eyeCropBox(eye(0.09), 1280, 0, 0.75), null);
});
