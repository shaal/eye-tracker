/**
 * Tests for calibration-scatter separability.
 *
 * The headline case is `head_motion_clusters_do_not_drag_the_verdict`, which is
 * a regression test for a real false negative: the metric reported "the eye
 * signal did not separate the targets, recalibrating will not help" on data
 * whose horizontal separation was in fact excellent. The head-motion targets
 * sit at the same screen points as fixation targets by design, so including
 * them in a nearest-centroid metric drives it to ~0 unconditionally.
 *
 * A diagnostic that says "your camera is inadequate" when the camera is fine is
 * worse than no diagnostic, because it sends the user to buy hardware.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gridCell, scatterAdvice, separability, summarizeScatter } from './scatter.js';
import type { CalibrationScatterPoint } from '../types.js';

/**
 * Synthesize a 3×3 grid of clusters.
 *
 * `sx`/`sy` are the per-axis cluster spacings and `noise` the within-cluster
 * spread, so the separation/spread ratio each axis should report is sx/noise
 * and sy/noise respectively.
 */
function grid(sx: number, sy: number, noise: number, n = 20): CalibrationScatterPoint[] {
  const out: CalibrationScatterPoint[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const index = row * 3 + col;
      for (let k = 0; k < n; k++) {
        // Symmetric offsets summing to zero, so the centroid lands exactly on
        // the intended point and the assertions test the code, not the fixture.
        const j = ((k % 4) - 1.5) / 1.5; // -1, -1/3, 1/3, 1
        out.push({
          gx: (col - 1) * sx + noise * j,
          gy: (row - 1) * sy - noise * j,
          targetIndex: index,
          kept: true,
        });
      }
    }
  }
  return out;
}

/** Head-motion clusters: centred on the grid's own points, but very wide. */
function headMotion(spread: number, n = 40): CalibrationScatterPoint[] {
  const out: CalibrationScatterPoint[] = [];
  // Mirrors HEAD_MOTION_STEPS: the first sits exactly at the centre target.
  const centres = [
    [0, 0],
    [-0.5, 0],
    [0.5, 0],
    [0, -0.5],
  ];
  centres.forEach(([cx, cy], i) => {
    for (let k = 0; k < n; k++) {
      const j = ((k % 4) - 1.5) / 1.5;
      out.push({ gx: cx! + spread * j, gy: cy! + spread * j, targetIndex: 9 + i, kept: true });
    }
  });
  return out;
}

test('grid cells mirror the 9-point row-major layout', () => {
  assert.deepEqual(gridCell(0, 9), { col: 0, row: 0 });
  assert.deepEqual(gridCell(4, 9), { col: 1, row: 1 });
  assert.deepEqual(gridCell(8, 9), { col: 2, row: 2 });
  assert.equal(gridCell(9, 9), null, 'head-motion indices are not grid cells');
});

test('grid cells mirror the 5-point corners-plus-centre layout', () => {
  assert.deepEqual(gridCell(2, 5), { col: 1, row: 1 }, 'index 2 is the centre in the 5-point grid');
  assert.deepEqual(gridCell(1, 5), { col: 2, row: 0 });
  assert.equal(gridCell(5, 5), null);
});

test('a clean grid reports clean separation on both axes', () => {
  const s = summarizeScatter(grid(0.05, 0.05, 0.005), 9);
  assert.equal(s.gridClusters, 9);
  assert.equal(s.headMotionClusters, 0);
  assert.ok(s.x.ratio > 3, `x ratio ${s.x.ratio}`);
  assert.ok(s.y.ratio > 3, `y ratio ${s.y.ratio}`);
  assert.equal(separability(s.x.ratio), 'clean');
  assert.ok(s.x.monotonic && s.y.monotonic);
});

test('head-motion clusters do not drag the verdict', () => {
  // The regression. Horizontal and vertical separation are both excellent, but
  // the head-motion clusters sit on top of the grid with a huge spread. Before
  // the fix this reported "the fit had nothing to work with".
  const points = [...grid(0.05, 0.05, 0.005), ...headMotion(0.08)];
  const s = summarizeScatter(points, 9);

  assert.equal(s.gridClusters, 9);
  assert.equal(s.headMotionClusters, 4, 'head-motion clusters are counted but excluded');
  assert.ok(s.x.ratio > 3, `head motion must not deflate x: ${s.x.ratio}`);
  assert.ok(s.y.ratio > 3, `head motion must not deflate y: ${s.y.ratio}`);
  assert.match(scatterAdvice(s), /Clean separation/);

  // And the verdict must be identical with and without them present.
  const withoutHead = summarizeScatter(grid(0.05, 0.05, 0.005), 9);
  assert.equal(s.x.ratio, withoutHead.x.ratio);
  assert.equal(s.y.ratio, withoutHead.y.ratio);
});

test('a good x axis and a poor y axis are reported separately', () => {
  // The case in the wild: horizontal iris travel is large, vertical is not,
  // because the eyelids crop the iris as the eye rotates up and down.
  const s = summarizeScatter(grid(0.05, 0.004, 0.005), 9);

  assert.equal(separability(s.x.ratio), 'clean');
  assert.equal(separability(s.y.ratio), 'unusable');

  const advice = scatterAdvice(s);
  assert.match(advice, /[Vv]ertical/);
  assert.match(advice, /camera/i, 'vertical advice must name the camera geometry lever');
  assert.doesNotMatch(
    advice,
    /recalibrating will not help/i,
    'a working x axis must not produce a blanket "give up" verdict',
  );
});

test('rejected samples are shown but excluded from the statistics', () => {
  const clean = grid(0.05, 0.05, 0.005);
  const withOutliers: CalibrationScatterPoint[] = [
    ...clean,
    // A glance away, far outside every cluster. It must not inflate spread.
    { gx: 9, gy: 9, targetIndex: 0, kept: false },
    { gx: -9, gy: -9, targetIndex: 4, kept: false },
  ];

  const a = summarizeScatter(clean, 9);
  const b = summarizeScatter(withOutliers, 9);

  assert.equal(b.rejected, 2);
  assert.equal(b.total, clean.length + 2);
  assert.ok(Math.abs(a.x.ratio - b.x.ratio) < 1e-9, 'rejects must not change separability');
  assert.ok(Math.abs(a.spread - b.spread) < 1e-9);
});

test('a mirrored axis is healthy, a folded one is not', () => {
  // Cameras mirror, so a monotonically *decreasing* sequence is fine.
  const mirrored = grid(-0.05, 0.05, 0.005);
  assert.ok(summarizeScatter(mirrored, 9).x.monotonic, 'mirroring is not folding');

  // Swap two columns so the band order is scrambled.
  const folded = grid(0.05, 0.05, 0.005).map((p) => ({
    ...p,
    gx: gridCell(p.targetIndex, 9)?.col === 0 ? p.gx + 0.1 : p.gx,
  }));
  const s = summarizeScatter(folded, 9);
  assert.equal(s.x.monotonic, false);
  assert.match(scatterAdvice(s), /folded/);
});

test('an axis with too few bands is unknown, never silently "clean"', () => {
  // Tracking survived on only two targets, both in the same column. The
  // horizontal axis then has one occupied band and no separation to measure.
  // A NaN ratio fails every `<` comparison, so before the fix it fell through
  // to the final "clean separation" verdict and printed `x NaN×` — asserting an
  // unmeasured axis was fine.
  const points = grid(0.05, 0.05, 0.005).filter(
    (p) => p.targetIndex === 0 || p.targetIndex === 6, // same column, rows 0 and 2
  );
  const s = summarizeScatter(points, 9);

  assert.equal(s.gridClusters, 2, 'reachable with gridClusters >= 2');
  assert.equal(separability(s.x.ratio), 'unknown');

  const advice = scatterAdvice(s);
  assert.doesNotMatch(advice, /Clean separation/, 'must not claim clean on unmeasured evidence');
  assert.doesNotMatch(advice, /NaN/, 'must not print NaN at the user');
  assert.match(advice, /horizontal/i);
});

test('an empty scatter asks for a calibration rather than reporting failure', () => {
  const s = summarizeScatter([], 9);
  assert.equal(s.gridClusters, 0);
  assert.ok(Number.isNaN(s.ratio));
  assert.match(scatterAdvice(s), /Run a calibration/);
});

test('separability bands are ordered and cover the range', () => {
  assert.equal(separability(5), 'clean');
  assert.equal(separability(3), 'clean');
  assert.equal(separability(2), 'crowded');
  assert.equal(separability(1.4), 'unusable');
  assert.equal(separability(Number.NaN), 'unknown');
});
