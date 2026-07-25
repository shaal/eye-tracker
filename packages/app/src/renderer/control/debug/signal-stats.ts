/**
 * Rolling statistics on the raw gaze features.
 *
 * The number this exists to produce is the **noise floor**: how much the gaze
 * signal moves when you are not moving your eyes. That single figure decides
 * whether accurate tracking is even possible, and no amount of recalibration or
 * filter tuning can beat it — it is a property of the camera, the lighting and
 * how far away you are sitting (ADR-0005).
 *
 * Estimating it is less obvious than it looks. A plain standard deviation over
 * a few seconds is dominated by whatever saccades happened to fall in the
 * window, so it measures your reading behaviour rather than the sensor. Instead
 * we take the standard deviation over a short window every frame, keep a
 * history of those, and report a low percentile of them: the quietest moments
 * are the ones where you actually held a fixation, and those are the only
 * moments that say anything about the noise floor.
 */

/** ~0.5 s at 30 fps — long enough to estimate a spread, short enough to fall inside one fixation. */
const SHORT_WINDOW = 15;
/** ~10 s of short-window estimates. */
const HISTORY = 300;
/**
 * Which percentile of the short-window spreads counts as "quiet". The 20th
 * means we are characterising the calmest fifth of the recent past; higher
 * values start folding saccades back in, lower ones chase single lucky frames.
 */
const QUIET_PERCENTILE = 0.2;

function stddev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sum = 0;
  for (const v of values) {
    const d = v - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx] ?? Number.NaN;
}

export interface SignalSummary {
  /** Quiet-period standard deviation of gx, in feature units. */
  noiseGx: number;
  noiseGy: number;
  /** Full range of gx seen since the last reset — the usable signal span. */
  travelGx: number;
  travelGy: number;
  /** Mean absolute per-eye disagreement. High means one iris is mis-fit. */
  meanDgx: number;
  /** Samples backing the estimate. Below ~60 the numbers are not yet settled. */
  samples: number;
}

export class SignalStats {
  private shortGx: number[] = [];
  private shortGy: number[] = [];
  private histGx: number[] = [];
  private histGy: number[] = [];

  private minGx = Number.POSITIVE_INFINITY;
  private maxGx = Number.NEGATIVE_INFINITY;
  private minGy = Number.POSITIVE_INFINITY;
  private maxGy = Number.NEGATIVE_INFINITY;

  private dgxSum = 0;
  private count = 0;

  push(gx: number, gy: number, dgx: number): void {
    this.shortGx.push(gx);
    this.shortGy.push(gy);
    if (this.shortGx.length > SHORT_WINDOW) this.shortGx.shift();
    if (this.shortGy.length > SHORT_WINDOW) this.shortGy.shift();

    if (this.shortGx.length === SHORT_WINDOW) {
      this.histGx.push(stddev(this.shortGx));
      this.histGy.push(stddev(this.shortGy));
      if (this.histGx.length > HISTORY) this.histGx.shift();
      if (this.histGy.length > HISTORY) this.histGy.shift();
    }

    if (gx < this.minGx) this.minGx = gx;
    if (gx > this.maxGx) this.maxGx = gx;
    if (gy < this.minGy) this.minGy = gy;
    if (gy > this.maxGy) this.maxGy = gy;

    this.dgxSum += Math.abs(dgx);
    this.count++;
  }

  reset(): void {
    this.shortGx = [];
    this.shortGy = [];
    this.histGx = [];
    this.histGy = [];
    this.minGx = Number.POSITIVE_INFINITY;
    this.maxGx = Number.NEGATIVE_INFINITY;
    this.minGy = Number.POSITIVE_INFINITY;
    this.maxGy = Number.NEGATIVE_INFINITY;
    this.dgxSum = 0;
    this.count = 0;
  }

  summary(): SignalSummary {
    const span = (lo: number, hi: number) => (Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0);
    return {
      noiseGx: percentile(this.histGx, QUIET_PERCENTILE),
      noiseGy: percentile(this.histGy, QUIET_PERCENTILE),
      travelGx: span(this.minGx, this.maxGx),
      travelGy: span(this.minGy, this.maxGy),
      meanDgx: this.count > 0 ? this.dgxSum / this.count : 0,
      samples: this.count,
    };
  }
}

/**
 * How a measured noise floor reads once converted to screen pixels.
 *
 * The bands are deliberately about *usability*, not about the sensor: a 25 px
 * cloud is smaller than most click targets, 60 px is about a toolbar button, and
 * past ~120 px the cursor cannot reliably land on anything at all.
 */
export function noiseVerdict(px: number): { label: string; level: 'good' | 'warn' | 'bad' } {
  if (!Number.isFinite(px)) return { label: 'calibrate to measure', level: 'warn' };
  if (px < 30) return { label: 'clean — small targets are reachable', level: 'good' };
  if (px < 70) return { label: 'workable — button-sized targets only', level: 'warn' };
  if (px < 130) return { label: 'noisy — expect to miss small targets', level: 'bad' };
  return { label: 'too noisy to control a cursor', level: 'bad' };
}

/**
 * Whether the usable range of the signal is large compared to its noise.
 *
 * This ratio is the honest summary of the whole pipeline's ceiling: it is how
 * many distinguishable positions the tracker can resolve across the screen. Ten
 * means roughly ten separable columns — a screen split into a coarse grid, not
 * a pointer.
 */
export function resolvableSteps(travel: number, noise: number): number {
  if (!Number.isFinite(travel) || !Number.isFinite(noise) || noise <= 0) return Number.NaN;
  return travel / noise;
}
