/**
 * A synthetic gaze path, for demoing without a camera.
 *
 * Not a recording — a weighted random walk that spends most of its time
 * around a handful of "interesting" zones with occasional glances elsewhere,
 * which is the shape a real shopper's gaze takes (a few products get most of
 * the attention, everything else gets a glance). Deterministic seed points so
 * repeated runs look similar without being frame-identical.
 */

import type { ProductZone } from './shelf.js';

const INTERESTING_IDS = ['z1', 'z6', 'z9'];
const INTERESTING_WEIGHT = 6;
const OTHER_WEIGHT = 1;
/** How much of the way to the current target the point moves each tick. */
const EASE = 0.08;
const JITTER_PX = 3;
/** How often a new target zone is chosen. */
const RETARGET_MS = [900, 2200] as const;

function pickWeighted(zones: ProductZone[]): ProductZone {
  const weights = zones.map((z) => (INTERESTING_IDS.includes(z.id) ? INTERESTING_WEIGHT : OTHER_WEIGHT));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < zones.length; i++) {
    r -= weights[i] as number;
    if (r <= 0) return zones[i] as ProductZone;
  }
  return zones[0] as ProductZone;
}

export class ReplayGenerator {
  private raf: number | null = null;
  private current: { x: number; y: number };
  private target: { x: number; y: number };
  private nextRetargetAt = 0;

  constructor(
    private readonly zones: ProductZone[],
    private readonly shelfRect: () => DOMRect,
  ) {
    const rect = this.shelfRect();
    const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    this.current = start;
    this.target = start;
  }

  private zoneCenter(z: ProductZone, rect: DOMRect): { x: number; y: number } {
    return {
      x: rect.x + (z.x + z.w / 2) * rect.width,
      y: rect.y + (z.y + z.h / 2) * rect.height,
    };
  }

  private maybeRetarget(now: number): void {
    if (now < this.nextRetargetAt) return;
    const rect = this.shelfRect();
    const zone = pickWeighted(this.zones);
    const center = this.zoneCenter(zone, rect);
    this.target = {
      x: center.x + (Math.random() - 0.5) * rect.width * 0.06,
      y: center.y + (Math.random() - 0.5) * rect.height * 0.06,
    };
    const [lo, hi] = RETARGET_MS;
    this.nextRetargetAt = now + lo + Math.random() * (hi - lo);
  }

  start(onPoint: (x: number, y: number, tMs: number) => void): void {
    const step = (): void => {
      const now = performance.now();
      this.maybeRetarget(now);
      this.current = {
        x: this.current.x + (this.target.x - this.current.x) * EASE + (Math.random() - 0.5) * JITTER_PX,
        y: this.current.y + (this.target.y - this.current.y) * EASE + (Math.random() - 0.5) * JITTER_PX,
      };
      onPoint(this.current.x, this.current.y, now);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
