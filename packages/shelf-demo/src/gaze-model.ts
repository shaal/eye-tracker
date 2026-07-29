/**
 * Demo-grade gaze mapping and smoothing.
 *
 * The production app fits and filters in Rust, reached from Electron through
 * napi — a route a plain browser tab has no access to (a `.node` binary
 * cannot load in a page). Re-implementing the exact ridge regression
 * (ADR-0006, cross-validated λ per ADR-0019) and the One Euro filter
 * (ADR-0007) faithfully would mean standing up a WASM build of the Rust core,
 * which is a real project in its own right, not a demo. This is the
 * deliberately smaller version: a scale-adaptive ridge-regularized affine fit
 * and a direct One Euro implementation. Good enough to show where someone is
 * looking; not the validated pipeline, and not claimed to be.
 *
 * The fit is written for an arbitrary feature count, though this module only
 * ever uses it at 2: eye-only (gx,gy) and head-only (hx,hy), fit from the same
 * calibration pass. There's no fused eye+head model — a live comparison is
 * more honest as two independent markers than one blended point, and a fused
 * fit tends to collapse toward whichever signal has more variance anyway.
 */

/** Solve an N×N linear system by Gaussian elimination with partial pivoting. */
function solveLinear(m: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i] as number]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(a[col]?.[col] ?? 0);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r]?.[col] ?? 0);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivotRow = r;
      }
    }
    if (pivotAbs < 1e-12) return null; // singular — too few/degenerate samples
    if (pivotRow !== col) {
      const tmp = a[col] as number[];
      a[col] = a[pivotRow] as number[];
      a[pivotRow] = tmp;
    }

    const pivot = a[col]?.[col] as number;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = a[r] as number[];
      const factor = (row[col] as number) / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        row[c] = (row[c] as number) - factor * (a[col]?.[c] as number);
      }
    }
  }

  return Array.from({ length: n }, (_, i) => (a[i]?.[n] as number) / (a[i]?.[i] as number));
}

/**
 * Fits `target ≈ c0 + c1*f0 + c2*f1 + ...` via ridge-regularized least
 * squares, `lambda` chosen as a small fraction of the fitted terms' own
 * natural scale rather than a fixed constant.
 *
 * A fixed absolute λ was the bug this replaced: `gx`/`gy` are normalized iris
 * offsets, typically ±0.05–0.15, so `AtA`'s diagonal for those columns over a
 * calibration run's worth of samples lands around 0.1–1. A λ of 5 — chosen
 * with no reference to that scale — swamped it: the fitted slope came out
 * roughly 100× too small, so a full eye-movement swing barely moved the
 * predicted point at all. Scaling λ to the data's own diagonal magnitude
 * means it does the same *job* (keep the solve away from singular) regardless
 * of whether a session's features happen to be small or large.
 *
 * The intercept is deliberately left unregularized — shrinking a constant
 * offset toward zero has no generalization benefit, and only biases where the
 * model thinks the middle of the screen is.
 */
function fitRidge(features: readonly number[][], target: readonly number[], ridgeFraction = 1e-3): number[] | null {
  const n = features.length;
  const dim = (features[0]?.length ?? 0) + 1;
  if (n < dim + 2) return null; // need comfortably more samples than parameters

  const ata: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
  const aty: number[] = new Array(dim).fill(0);

  for (let i = 0; i < n; i++) {
    const row = [1, ...(features[i] as number[])];
    const t = target[i] as number;
    for (let r = 0; r < dim; r++) {
      aty[r] = (aty[r] as number) + (row[r] as number) * t;
      const ataRow = ata[r] as number[];
      for (let c = 0; c < dim; c++) {
        ataRow[c] = (ataRow[c] as number) + (row[r] as number) * (row[c] as number);
      }
    }
  }

  let slopeTrace = 0;
  for (let i = 1; i < dim; i++) slopeTrace += (ata[i] as number[])[i] as number;
  const lambda = ridgeFraction * (slopeTrace / Math.max(dim - 1, 1));
  for (let i = 1; i < dim; i++) {
    const row = ata[i] as number[];
    row[i] = (row[i] as number) + lambda;
  }

  return solveLinear(ata, aty as number[]);
}

/** A fitted `target ≈ c0 + c1*f0 + c2*f1 + ...` for one axis (x or y). */
class LinearModel {
  constructor(private readonly coefs: readonly number[]) {}

  predict(features: readonly number[]): number {
    let v = this.coefs[0] ?? 0;
    for (let i = 0; i < features.length; i++) {
      v += (this.coefs[i + 1] ?? 0) * (features[i] as number);
    }
    return v;
  }
}

export class GazeModel {
  constructor(
    private readonly modelX: LinearModel,
    private readonly modelY: LinearModel,
  ) {}

  predict(features: readonly number[]): { x: number; y: number } {
    return { x: this.modelX.predict(features), y: this.modelY.predict(features) };
  }
}

function fitModel(features: readonly number[][], targetX: readonly number[], targetY: readonly number[]): GazeModel | null {
  const cx = fitRidge(features, targetX);
  const cy = fitRidge(features, targetY);
  if (!cx || !cy) return null;
  return new GazeModel(new LinearModel(cx), new LinearModel(cy));
}

function stddev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

interface CalibrationSample {
  gx: number;
  gy: number;
  hx: number;
  hy: number;
  x: number;
  y: number;
}

export interface CalibrationResult {
  eye: GazeModel | null;
  head: GazeModel | null;
  /**
   * True when the head barely moved during calibration, which makes the
   * head-only model close to fitting noise — worth saying out loud rather
   * than silently handing over a model that looks calibrated but isn't.
   */
  headMotionTooSmall: boolean;
}

/** Below this normalized head-position spread, a head-only fit is mostly noise. */
const MIN_HEAD_SPREAD = 0.02;

export class GazeCalibrator {
  private samples: CalibrationSample[] = [];

  addSample(gx: number, gy: number, hx: number, hy: number, x: number, y: number): void {
    this.samples.push({ gx, gy, hx, hy, x, y });
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  fit(): CalibrationResult {
    const targetX = this.samples.map((s) => s.x);
    const targetY = this.samples.map((s) => s.y);

    const eyeFeatures = this.samples.map((s) => [s.gx, s.gy]);
    const headFeatures = this.samples.map((s) => [s.hx, s.hy]);

    const headSpread = (stddev(this.samples.map((s) => s.hx)) + stddev(this.samples.map((s) => s.hy))) / 2;

    return {
      eye: fitModel(eyeFeatures, targetX, targetY),
      head: fitModel(headFeatures, targetX, targetY),
      headMotionTooSmall: headSpread < MIN_HEAD_SPREAD,
    };
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * One Euro filter (Casiez, Roussel & Vogel 2012) — the same smoothing family
 * as the production filter (ADR-0007), reimplemented directly since it's
 * small. One instance per scalar signal (x and y need their own).
 */
export class OneEuroFilter {
  private lastT: number | null = null;
  private lastX: number | null = null;
  private lastDx = 0;

  constructor(
    private readonly minCutoff = 1.0,
    private readonly beta = 0.02,
    private readonly dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dtSeconds: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSeconds);
  }

  filter(tMs: number, x: number): number {
    if (this.lastT === null || this.lastX === null) {
      this.lastT = tMs;
      this.lastX = x;
      return x;
    }
    const dt = Math.max((tMs - this.lastT) / 1000, 1 / 120);
    this.lastT = tMs;

    const dx = (x - this.lastX) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.lastDx;
    this.lastDx = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.lastX;
    this.lastX = xHat;
    return xHat;
  }

  reset(): void {
    this.lastT = null;
    this.lastX = null;
    this.lastDx = 0;
  }
}
