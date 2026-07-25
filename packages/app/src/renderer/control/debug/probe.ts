/**
 * Debug mode 4 — the continuous accuracy probe.
 *
 * A validation run is a snapshot: it tells you the tracker was off by 1.4° at
 * the moment you ran it. It cannot answer the question people actually ask,
 * which is *"it was fine ten minutes ago — what changed?"*
 *
 * The probe answers that. A fixed dot sits on the overlay; you look at it and
 * watch the offset live while you deliberately change one thing at a time —
 * lean back, turn your head, dim the lamp, take your glasses off. Whichever
 * change makes the number jump is the thing that is breaking your tracking.
 *
 * It measures the same accuracy/precision split as a validation run, but over a
 * sliding window rather than a fixed dwell, so it updates continuously.
 */

import type { Point } from '@eye-tracker/core';

/** ~3 s at 30 fps. Long enough to average out noise, short enough to react. */
const WINDOW = 90;

export interface ProbeReading {
  /** Samples in the window. */
  samples: number;
  /** Signed offset of the mean estimate from the probe dot, in px. */
  offsetX: number;
  offsetY: number;
  /** |offset| — live accuracy. */
  accuracyPx: number;
  /** RMS scatter about the mean — live precision. */
  precisionPx: number;
  /** Direction of the bias, as a compass-style phrase. */
  direction: string;
}

const EMPTY: ProbeReading = {
  samples: 0,
  offsetX: Number.NaN,
  offsetY: Number.NaN,
  accuracyPx: Number.NaN,
  precisionPx: Number.NaN,
  direction: '',
};

/**
 * Describe the bias in words. "Reads 90 px low" is immediately actionable in a
 * way that a signed pair of numbers is not — a consistent vertical offset, for
 * instance, usually means you are sitting higher or lower than you calibrated.
 */
function describe(dx: number, dy: number, magnitude: number): string {
  if (!Number.isFinite(magnitude) || magnitude < 12) return 'on target';
  const parts: string[] = [];
  if (Math.abs(dy) > magnitude * 0.4) parts.push(dy > 0 ? 'low' : 'high');
  if (Math.abs(dx) > magnitude * 0.4) parts.push(dx > 0 ? 'right' : 'left');
  return parts.length ? `reads ${parts.join(' and ')}` : 'offset';
}

export class AccuracyProbe {
  private xs: number[] = [];
  private ys: number[] = [];
  private target: Point | null = null;

  setTarget(p: Point | null): void {
    this.target = p;
    this.reset();
  }

  get targetPoint(): Point | null {
    return this.target;
  }

  reset(): void {
    this.xs = [];
    this.ys = [];
  }

  /** Feed one unfiltered gaze estimate. Ignored while no dot is parked. */
  push(rawX: number, rawY: number): void {
    if (!this.target) return;
    this.xs.push(rawX);
    this.ys.push(rawY);
    if (this.xs.length > WINDOW) this.xs.shift();
    if (this.ys.length > WINDOW) this.ys.shift();
  }

  read(): ProbeReading {
    const n = this.xs.length;
    if (!this.target || n < 10) return { ...EMPTY, samples: n };

    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += this.xs[i] ?? 0;
      my += this.ys[i] ?? 0;
    }
    mx /= n;
    my /= n;

    let sq = 0;
    for (let i = 0; i < n; i++) {
      sq += ((this.xs[i] ?? 0) - mx) ** 2 + ((this.ys[i] ?? 0) - my) ** 2;
    }

    const dx = mx - this.target.x;
    const dy = my - this.target.y;
    const accuracyPx = Math.hypot(dx, dy);

    return {
      samples: n,
      offsetX: dx,
      offsetY: dy,
      accuracyPx,
      precisionPx: Math.sqrt(sq / n),
      direction: describe(dx, dy, accuracyPx),
    };
  }
}
