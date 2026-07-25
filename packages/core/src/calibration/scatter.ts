/**
 * Statistics on the calibration sample cloud in gaze-feature space.
 *
 * This is the view that answers a question the fit report cannot: *was the
 * calibration ever going to work?* If the per-target clusters do not separate in
 * (gx, gy), no regression can recover the mapping, because the information is
 * not in the data — and that is a hardware/lighting/seating problem, not
 * something another calibration run can fix.
 *
 * ## Why head-motion targets must be excluded
 *
 * The naive metric — smallest distance between any two cluster centroids,
 * divided by the typical within-cluster spread — is wrong here, and wrong in a
 * way that always reports failure.
 *
 * The head-motion targets (ADR-0015) sit at 0.5/0.5, 0.2/0.5, 0.8/0.5 and
 * 0.5/0.25 of the work area. The first is the *same screen point* as the centre
 * fixation target, and the others are close to the mid-row ones. Their
 * centroids are supposed to coincide with fixation centroids, and their spread
 * is supposed to be enormous — sweeping the head through a range while holding
 * gaze is the entire point of the phase.
 *
 * Include them and `minSeparation` goes to ~0 no matter how good the signal is.
 * The metric therefore runs over the fixation grid only.
 *
 * ## Why the axes are reported separately
 *
 * Vertical gaze is materially harder to estimate than horizontal, for reasons
 * that have nothing to do with the fit:
 *
 *   - The eyelids occlude the iris from above and below, and they *move with*
 *     vertical gaze — look down and the upper lid follows, cropping the iris
 *     exactly when its centroid is being measured.
 *   - Physical vertical eye rotation range is smaller than horizontal.
 *   - Head pitch couples into apparent vertical iris offset far more strongly
 *     than yaw couples into horizontal.
 *
 * A single blended number hides all of that. Split per axis, "gx is fine and gy
 * is marginal" is visible immediately — and it implies different remedies
 * (camera height and pitch, rather than lighting and distance).
 */

import type { CalibrationScatterPoint } from '../types.js';

/** Where a fixation target sits in the 3×3 conceptual grid. */
export interface GridCell {
  col: 0 | 1 | 2;
  row: 0 | 1 | 2;
}

/**
 * Map a fixation target index to its grid cell.
 *
 * MIRRORS `target_grid` in `calibration/mod.rs`: the 9-point layout is
 * row-major over [0.10, 0.50, 0.90]; the 5-point layout is the four corners
 * plus centre, in that order.
 */
export function gridCell(index: number, gridCount: number): GridCell | null {
  if (gridCount >= 9) {
    if (index < 0 || index > 8) return null;
    return { col: (index % 3) as 0 | 1 | 2, row: Math.floor(index / 3) as 0 | 1 | 2 };
  }
  const five: GridCell[] = [
    { col: 0, row: 0 }, // top-left
    { col: 2, row: 0 }, // top-right
    { col: 1, row: 1 }, // centre
    { col: 0, row: 2 }, // bottom-left
    { col: 2, row: 2 }, // bottom-right
  ];
  return five[index] ?? null;
}

export interface AxisSeparation {
  /**
   * Smallest gap between adjacent band means along this axis, where a band is
   * a grid column (for gx) or a grid row (for gy).
   *
   * Adjacent rather than any-pair: the outer bands are always further apart,
   * so an any-pair minimum would just re-measure the tightest neighbour anyway,
   * but adjacency makes a *folded* grid (where band order inverts) detectable.
   */
  separation: number;
  /** Mean within-cluster standard deviation along this axis. */
  spread: number;
  /** separation / spread. Below ~1.5 the bands are not reliably distinguishable. */
  ratio: number;
  /** Full span of the band means, end to end. */
  range: number;
  /** False when the bands are not in monotonic order — a folded mapping. */
  monotonic: boolean;
}

export interface ScatterSummary {
  /** Clusters belonging to the fixation grid. */
  gridClusters: number;
  /** Clusters from the head-motion phase, excluded from every metric below. */
  headMotionClusters: number;
  rejected: number;
  total: number;
  /** Horizontal separability, from the grid columns. */
  x: AxisSeparation;
  /** Vertical separability, from the grid rows. */
  y: AxisSeparation;
  /**
   * 2-D nearest-neighbour ratio over grid centroids only. The headline number,
   * kept for continuity with the fit report.
   */
  ratio: number;
  minSeparation: number;
  spread: number;
}

const EMPTY_AXIS: AxisSeparation = {
  separation: Number.NaN,
  spread: Number.NaN,
  ratio: Number.NaN,
  range: Number.NaN,
  monotonic: true,
};

interface Cluster {
  index: number;
  gx: number;
  gy: number;
  sdX: number;
  sdY: number;
  n: number;
}

function clustersOf(points: readonly CalibrationScatterPoint[], keep: (i: number) => boolean): Cluster[] {
  const groups = new Map<number, CalibrationScatterPoint[]>();
  for (const p of points) {
    // Rejected samples are shown on the plot but must not shape the statistics:
    // they are exactly the frames the fit already threw away.
    if (!p.kept || !keep(p.targetIndex)) continue;
    const g = groups.get(p.targetIndex);
    if (g) g.push(p);
    else groups.set(p.targetIndex, [p]);
  }

  const out: Cluster[] = [];
  for (const [index, g] of groups) {
    const n = g.length;
    let mx = 0;
    let my = 0;
    for (const p of g) {
      mx += p.gx;
      my += p.gy;
    }
    mx /= n;
    my /= n;

    let vx = 0;
    let vy = 0;
    for (const p of g) {
      vx += (p.gx - mx) ** 2;
      vy += (p.gy - my) ** 2;
    }
    out.push({ index, gx: mx, gy: my, sdX: Math.sqrt(vx / n), sdY: Math.sqrt(vy / n), n });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Collapse clusters into three bands along one axis and measure their spacing.
 *
 * `band` picks the column (for gx) or the row (for gy).
 */
function axisSeparation(
  clusters: readonly Cluster[],
  gridCount: number,
  axis: 'x' | 'y',
): AxisSeparation {
  const bands = new Map<number, number[]>();
  const spreads: number[] = [];

  for (const c of clusters) {
    const cell = gridCell(c.index, gridCount);
    if (!cell) continue;
    const key = axis === 'x' ? cell.col : cell.row;
    const value = axis === 'x' ? c.gx : c.gy;
    const list = bands.get(key);
    if (list) list.push(value);
    else bands.set(key, [value]);
    spreads.push(axis === 'x' ? c.sdX : c.sdY);
  }

  if (bands.size < 2 || spreads.length === 0) return EMPTY_AXIS;

  const means = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, values]) => values.reduce((s, v) => s + v, 0) / values.length);

  let separation = Number.POSITIVE_INFINITY;
  for (let i = 1; i < means.length; i++) {
    separation = Math.min(separation, Math.abs(means[i]! - means[i - 1]!));
  }

  // Monotonic in either direction: the camera may mirror, so a consistently
  // decreasing sequence is just as healthy as an increasing one. What matters
  // is that the order is not scrambled, which would mean the mapping folds.
  const increasing = means.every((v, i) => i === 0 || v > means[i - 1]!);
  const decreasing = means.every((v, i) => i === 0 || v < means[i - 1]!);

  const spread = spreads.reduce((s, v) => s + v, 0) / spreads.length;
  return {
    separation,
    spread,
    ratio: spread > 0 ? separation / spread : Number.NaN,
    range: Math.abs(means[means.length - 1]! - means[0]!),
    monotonic: increasing || decreasing,
  };
}

export function summarizeScatter(
  points: readonly CalibrationScatterPoint[],
  gridCount: number,
): ScatterSummary {
  const grid = clustersOf(points, (i) => i < gridCount);
  const head = clustersOf(points, (i) => i >= gridCount);
  const rejected = points.filter((p) => !p.kept).length;

  const base = {
    gridClusters: grid.length,
    headMotionClusters: head.length,
    rejected,
    total: points.length,
  };

  if (grid.length < 2) {
    return {
      ...base,
      x: EMPTY_AXIS,
      y: EMPTY_AXIS,
      ratio: Number.NaN,
      minSeparation: Number.NaN,
      spread: Number.NaN,
    };
  }

  let minSeparation = Number.POSITIVE_INFINITY;
  for (let i = 0; i < grid.length; i++) {
    for (let j = i + 1; j < grid.length; j++) {
      minSeparation = Math.min(
        minSeparation,
        Math.hypot(grid[i]!.gx - grid[j]!.gx, grid[i]!.gy - grid[j]!.gy),
      );
    }
  }

  const spread =
    grid.reduce((s, c) => s + Math.hypot(c.sdX, c.sdY), 0) / grid.length;

  return {
    ...base,
    x: axisSeparation(grid, gridCount, 'x'),
    y: axisSeparation(grid, gridCount, 'y'),
    ratio: spread > 0 ? minSeparation / spread : Number.NaN,
    minSeparation,
    spread,
  };
}

export type Separability = 'clean' | 'crowded' | 'unusable' | 'unknown';

export function separability(ratio: number): Separability {
  if (!Number.isFinite(ratio)) return 'unknown';
  if (ratio >= 3) return 'clean';
  if (ratio >= 1.5) return 'crowded';
  return 'unusable';
}

/**
 * Turn the per-axis numbers into the remedy that follows from them.
 *
 * The axes get different advice on purpose. Horizontal separability is mostly
 * about iris resolution — pixels on the eye, so distance, lighting and sensor.
 * Vertical separability is dominated by lid occlusion and camera geometry, so
 * the useful levers are camera height and screen tilt, which no amount of extra
 * light will substitute for.
 */
export function scatterAdvice(s: ScatterSummary): string {
  if (s.gridClusters < 2) return 'Run a calibration to populate this.';

  const x = separability(s.x.ratio);
  const y = separability(s.y.ratio);

  // An axis with fewer than two occupied bands has no separability evidence at
  // all — reachable whenever tracking was lost on enough targets that the
  // survivors share a column or a row. Without this branch the NaN ratio failed
  // every comparison below and fell through to the final "clean" verdict,
  // printing `x NaN×` and, far worse, asserting that an unmeasured axis is
  // fine. That is precisely the false negative this diagnostic exists to catch.
  if (x === 'unknown' || y === 'unknown') {
    const missing = [x === 'unknown' ? 'horizontal' : null, y === 'unknown' ? 'vertical' : null]
      .filter(Boolean)
      .join(' and ');
    return (
      `Not enough surviving targets to measure ${missing} separation — the clusters that ` +
      'remain do not span enough of the grid. Tracking was probably lost during the run; ' +
      'recalibrate and check that your face stays in frame throughout.'
    );
  }

  if (!s.x.monotonic || !s.y.monotonic) {
    return (
      'The clusters are out of order — the grid is folded rather than merely tight. ' +
      'That usually means fixations landed on the wrong dots, or tracking was lost partway. ' +
      'Recalibrate and follow each dot deliberately.'
    );
  }

  if (x === 'unusable' && y === 'unusable') {
    return (
      'Neither axis separated the targets, so the fit had nothing to work with and ' +
      'recalibrating will not help. Sit closer, add light on your face, or use a better camera.'
    );
  }

  if (y === 'unusable' || (y === 'crowded' && x === 'clean')) {
    return (
      `Horizontal is ${x} (${s.x.ratio.toFixed(1)}×) but vertical is ${y} (${s.y.ratio.toFixed(1)}×). ` +
      'Vertical is the harder axis — the eyelids crop the iris exactly as you look up and down. ' +
      'Raise the camera to eye level so it is not looking up at your lids, reduce how far you tilt ' +
      'your screen back, and keep the light in front of you rather than overhead. Expect vertical ' +
      'cursor accuracy to stay worse than horizontal regardless.'
    );
  }

  if (x === 'unusable') {
    return (
      `Vertical separated (${s.y.ratio.toFixed(1)}×) but horizontal did not (${s.x.ratio.toFixed(1)}×), ` +
      'which is unusual and normally means the iris landmarks are being mislocalised. ' +
      'Check the eye zoom view — the green outline should sit still on your iris.'
    );
  }

  if (x === 'crowded' || y === 'crowded') {
    return (
      `Separable but tight (x ${s.x.ratio.toFixed(1)}×, y ${s.y.ratio.toFixed(1)}×). ` +
      'Expect a usable but imprecise cursor. Sitting closer widens both axes.'
    );
  }

  return (
    `Clean separation on both axes (x ${s.x.ratio.toFixed(1)}×, y ${s.y.ratio.toFixed(1)}×). ` +
    'The input signal is good, so any remaining error is in the mapping or in your fixations — ' +
    'run a validation to see which.'
  );
}
