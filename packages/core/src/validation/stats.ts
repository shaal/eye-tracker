/**
 * Turning a cloud of predictions into accuracy and precision.
 *
 * Pure functions, no Electron and no DOM, so the arithmetic can be reasoned
 * about (and tested) on its own.
 */

import type { Point } from '../types.js';
import {
  MIN_VALIDATION_SAMPLES,
  accuracyVerdict,
  diagnose,
  precisionVerdict,
  type Verdict,
} from './protocol.js';

/** Everything recorded while the user fixated one validation dot. */
export interface ValidationSamples {
  target: Point;
  /** Unfiltered model output — measures the model. */
  raw: Point[];
  /** Post-filter cursor positions — measures what the user actually gets. */
  filtered: Point[];
}

export interface ValidationTargetResult {
  target: Point;
  samples: number;
  /** Centroid of the raw predictions. */
  mean: Point;
  /** Centroid minus target: the systematic error, with direction. */
  bias: Point;
  /** |bias| — accuracy, in pixels. */
  accuracyPx: number;
  /** RMS distance from the centroid — precision, in pixels. */
  precisionPx: number;
  /** Precision of the *filtered* cursor, for comparison. */
  filteredPrecisionPx: number;
  /** Per-axis standard deviation, for drawing the dispersion ellipse. */
  sdX: number;
  sdY: number;
  /** Raw cloud, kept for the scatter overlay. */
  cloud: Point[];
}

export interface ValidationReport {
  targets: ValidationTargetResult[];
  /** Targets dropped for having too few usable samples. */
  dropped: number;
  meanAccuracyPx: number;
  meanAccuracyDeg: number;
  p95AccuracyPx: number;
  meanPrecisionPx: number;
  meanPrecisionDeg: number;
  /** Mean precision of the filtered cursor — how much smoothing bought. */
  meanFilteredPrecisionPx: number;
  /** Index into `targets` of the worst point, or -1. */
  worstIndex: number;
  pxPerDegree: number;
  /** `'unknown'` when the degree scale was unavailable — not a grade of poor. */
  accuracyVerdict: Verdict;
  precisionVerdict: Verdict;
  /** What the user should actually do about it. */
  advice: string;
}

function centroid(pts: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, pts.length);
  return { x: x / n, y: y / n };
}

/**
 * RMS distance from the centroid.
 *
 * Note this is deliberately *not* the distance from the target: dispersion
 * around wherever the tracker thinks you are looking is a property of the
 * signal, independent of whether that location is correct. Measuring spread
 * about the target instead would fold the bias back in and destroy the
 * separation the whole report is built on.
 */
function rmsFromCentroid(pts: readonly Point[], c: Point): number {
  if (pts.length === 0) return Number.NaN;
  let sum = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / pts.length);
}

function axisSd(pts: readonly Point[], c: Point, axis: 'x' | 'y'): number {
  if (pts.length === 0) return Number.NaN;
  let sum = 0;
  for (const p of pts) {
    const d = p[axis] - c[axis];
    sum += d * d;
  }
  return Math.sqrt(sum / pts.length);
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.round((sorted.length - 1) * q);
  return sorted[Math.min(idx, sorted.length - 1)] ?? Number.NaN;
}

export function summarizeTarget(s: ValidationSamples): ValidationTargetResult | null {
  if (s.raw.length < MIN_VALIDATION_SAMPLES) return null;

  const mean = centroid(s.raw);
  const bias = { x: mean.x - s.target.x, y: mean.y - s.target.y };
  const filteredMean = centroid(s.filtered);

  return {
    target: s.target,
    samples: s.raw.length,
    mean,
    bias,
    accuracyPx: Math.hypot(bias.x, bias.y),
    precisionPx: rmsFromCentroid(s.raw, mean),
    filteredPrecisionPx: s.filtered.length
      ? rmsFromCentroid(s.filtered, filteredMean)
      : Number.NaN,
    sdX: axisSd(s.raw, mean, 'x'),
    sdY: axisSd(s.raw, mean, 'y'),
    cloud: s.raw,
  };
}

const EMPTY_REPORT = (pxPerDegree: number, dropped: number): ValidationReport => ({
  targets: [],
  dropped,
  meanAccuracyPx: Number.NaN,
  meanAccuracyDeg: Number.NaN,
  p95AccuracyPx: Number.NaN,
  meanPrecisionPx: Number.NaN,
  meanPrecisionDeg: Number.NaN,
  meanFilteredPrecisionPx: Number.NaN,
  worstIndex: -1,
  pxPerDegree,
  // Nothing was measured, so nothing can be graded. 'poor' here would assert a
  // finding the run never produced.
  accuracyVerdict: 'unknown',
  precisionVerdict: 'unknown',
  advice:
    'No target collected enough samples to score. That usually means tracking was lost — ' +
    'check that your face stays in frame and that quality stays above the guard threshold.',
});

export function summarizeValidation(
  collected: readonly ValidationSamples[],
  pxPerDegree: number,
): ValidationReport {
  const targets: ValidationTargetResult[] = [];
  let dropped = 0;
  for (const s of collected) {
    const r = summarizeTarget(s);
    if (r) targets.push(r);
    else dropped++;
  }

  if (targets.length === 0) return EMPTY_REPORT(pxPerDegree, dropped);

  const accs = targets.map((t) => t.accuracyPx);
  const precs = targets.map((t) => t.precisionPx);
  const filtered = targets.map((t) => t.filteredPrecisionPx).filter((v) => Number.isFinite(v));

  const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const meanAccuracyPx = mean(accs);
  const meanPrecisionPx = mean(precs);

  // Guard the conversion: a zero or missing px-per-degree would turn every
  // reported angle into Infinity and the verdict into nonsense.
  const scale = pxPerDegree > 0 ? pxPerDegree : Number.NaN;
  const meanAccuracyDeg = meanAccuracyPx / scale;
  const meanPrecisionDeg = meanPrecisionPx / scale;

  let worstIndex = 0;
  for (let i = 1; i < targets.length; i++) {
    if ((targets[i]?.accuracyPx ?? 0) > (targets[worstIndex]?.accuracyPx ?? 0)) worstIndex = i;
  }

  return {
    targets,
    dropped,
    meanAccuracyPx,
    meanAccuracyDeg,
    p95AccuracyPx: percentile([...accs].sort((a, b) => a - b), 0.95),
    meanPrecisionPx,
    meanPrecisionDeg,
    meanFilteredPrecisionPx: filtered.length ? mean(filtered) : Number.NaN,
    worstIndex,
    pxPerDegree,
    accuracyVerdict: accuracyVerdict(meanAccuracyDeg),
    precisionVerdict: precisionVerdict(meanPrecisionDeg),
    advice: diagnose(meanAccuracyDeg, meanPrecisionDeg),
  };
}

/** Live state for the overlay while a validation run is in flight. */
export interface ValidationUiState {
  active: boolean;
  targets: Point[];
  currentIndex: number;
  phase: 'idle' | 'settle' | 'collect' | 'done';
  samples: number;
  prompt: string;
}
