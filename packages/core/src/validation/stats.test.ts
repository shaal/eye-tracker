/**
 * Tests for the accuracy/precision decomposition.
 *
 * These matter more than they look: the entire value of a validation run is
 * that the two numbers are *independent*. If a bias leaked into the precision
 * figure, a badly-calibrated-but-steady tracker would report as noisy, and the
 * user would be sent to buy a camera instead of recalibrating.
 *
 * Run with `npm run test:core` (node's built-in runner, no dependencies).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeValidation, type ValidationSamples } from './stats.js';
import { MIN_VALIDATION_SAMPLES } from './protocol.js';

const PX_PER_DEG = 40;

/** A fixation cloud: `n` samples centred at target+bias, spread by ±`jitter`. */
function cloud(
  target: { x: number; y: number },
  bias: { x: number; y: number },
  jitter: number,
  n = 30,
): ValidationSamples {
  const raw: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    // Deterministic offsets drawn from a symmetric set that sums to exactly
    // zero over each group of six, so the cloud's mean lands precisely on
    // target+bias. Any asymmetry here would show up as a phantom bias and the
    // tests would be asserting against the fixture rather than the code.
    const k = ((i % 6) - 2.5) / 2.5; // -1, -0.6, -0.2, 0.2, 0.6, 1
    raw.push({ x: target.x + bias.x + jitter * k, y: target.y + bias.y - jitter * k });
  }
  return { target, raw, filtered: raw.map((p) => ({ ...p })) };
}

test('a steady but offset tracker reports accuracy, not noise', () => {
  const r = summarizeValidation(
    [cloud({ x: 500, y: 500 }, { x: 80, y: 0 }, 0), cloud({ x: 900, y: 500 }, { x: 80, y: 0 }, 0)],
    PX_PER_DEG,
  );

  assert.ok(Math.abs(r.meanAccuracyPx - 80) < 1e-6, `accuracy ${r.meanAccuracyPx}`);
  assert.equal(r.meanPrecisionPx, 0, 'a perfectly steady cloud has zero scatter');
  assert.ok(r.advice.includes('Recalibrate'), `advice should point at recalibration: ${r.advice}`);
});

test('a noisy but centred tracker reports precision, not bias', () => {
  const r = summarizeValidation(
    [cloud({ x: 500, y: 500 }, { x: 0, y: 0 }, 60), cloud({ x: 900, y: 500 }, { x: 0, y: 0 }, 60)],
    PX_PER_DEG,
  );

  assert.ok(r.meanAccuracyPx < 1e-6, `bias should vanish, got ${r.meanAccuracyPx}`);
  assert.ok(r.meanPrecisionPx > 20, `scatter should be reported, got ${r.meanPrecisionPx}`);
  assert.ok(
    r.advice.includes('noisy') && r.advice.includes('Recalibrating will not help'),
    `advice should rule out recalibration: ${r.advice}`,
  );
});

test('precision is measured about the cloud centre, not the target', () => {
  // Same scatter, wildly different bias. If precision were measured from the
  // target, the offset cloud would report as far noisier than it is.
  const centred = summarizeValidation([cloud({ x: 500, y: 500 }, { x: 0, y: 0 }, 40)], PX_PER_DEG);
  const offset = summarizeValidation([cloud({ x: 500, y: 500 }, { x: 300, y: 0 }, 40)], PX_PER_DEG);

  assert.ok(
    Math.abs(centred.meanPrecisionPx - offset.meanPrecisionPx) < 1e-6,
    `precision must be bias-invariant: ${centred.meanPrecisionPx} vs ${offset.meanPrecisionPx}`,
  );
  assert.ok(offset.meanAccuracyPx > 290, 'the bias must still show up as accuracy');
});

test('targets with too few samples are dropped, not averaged in', () => {
  const good = cloud({ x: 500, y: 500 }, { x: 10, y: 0 }, 5);
  const starved = cloud({ x: 900, y: 500 }, { x: 500, y: 0 }, 5, MIN_VALIDATION_SAMPLES - 1);

  const r = summarizeValidation([good, starved], PX_PER_DEG);
  assert.equal(r.targets.length, 1);
  assert.equal(r.dropped, 1);
  // The starved target's huge bias must not reach the mean.
  assert.ok(r.meanAccuracyPx < 20, `starved target leaked in: ${r.meanAccuracyPx}`);
});

test('a run where tracking was lost entirely says so', () => {
  const r = summarizeValidation([{ target: { x: 0, y: 0 }, raw: [], filtered: [] }], PX_PER_DEG);
  assert.equal(r.targets.length, 0);
  assert.equal(r.dropped, 1);
  assert.ok(r.advice.includes('tracking was lost'), r.advice);
});

test('degrees are NaN rather than Infinity when the scale is unknown', () => {
  // px_per_degree of 0 reaches here whenever the engine has not been told the
  // display geometry. Infinity would render as a confident "∞°".
  const r = summarizeValidation([cloud({ x: 500, y: 500 }, { x: 40, y: 0 }, 5)], 0);
  assert.ok(Number.isNaN(r.meanAccuracyDeg));
  assert.ok(Number.isFinite(r.meanAccuracyPx));
});

test('the worst point is identified by accuracy', () => {
  const r = summarizeValidation(
    [
      cloud({ x: 100, y: 100 }, { x: 5, y: 0 }, 2),
      cloud({ x: 500, y: 100 }, { x: 200, y: 0 }, 2),
      cloud({ x: 900, y: 100 }, { x: 20, y: 0 }, 2),
    ],
    PX_PER_DEG,
  );
  assert.equal(r.worstIndex, 1);
  assert.ok(r.targets[r.worstIndex]!.accuracyPx > 190);
});

test('the filter comparison reports separately from the raw signal', () => {
  const raw = cloud({ x: 500, y: 500 }, { x: 0, y: 0 }, 80);
  // A filter that removed all jitter: same centroid, no spread.
  const smoothed: ValidationSamples = {
    ...raw,
    filtered: raw.raw.map(() => ({ x: 500, y: 500 })),
  };

  const r = summarizeValidation([smoothed], PX_PER_DEG);
  assert.ok(r.meanPrecisionPx > 20, 'raw scatter is still reported');
  assert.equal(r.meanFilteredPrecisionPx, 0, 'filtered scatter is reported independently');
});
