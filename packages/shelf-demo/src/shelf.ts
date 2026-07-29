/**
 * The simulated shelf: product zones, dwell-time accounting, and a decaying
 * heatmap trail. Deliberately generic product names — this is a layout demo,
 * not an endorsement of or dig at any real brand.
 */

export interface ProductZone {
  id: string;
  label: string;
  /** Fractional position within the shelf container, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Three shelf levels of four products each — plausible, not photographic. */
export const DEFAULT_ZONES: ProductZone[] = [
  { id: 'z0', label: 'Whole Grain Cereal', x: 0.02, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z1', label: 'Frosted Flakes-Style', x: 0.27, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z2', label: 'Granola Clusters', x: 0.52, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z3', label: 'Bran Flakes', x: 0.77, y: 0.04, w: 0.21, h: 0.28 },

  { id: 'z4', label: 'Sea Salt Chips', x: 0.02, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z5', label: 'BBQ Chips', x: 0.27, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z6', label: 'Pretzel Twists', x: 0.52, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z7', label: 'Trail Mix', x: 0.77, y: 0.36, w: 0.21, h: 0.28 },

  { id: 'z8', label: 'Cola', x: 0.02, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z9', label: 'Diet Cola', x: 0.27, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z10', label: 'Sparkling Water', x: 0.52, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z11', label: 'Iced Tea', x: 0.77, y: 0.68, w: 0.21, h: 0.28 },
];

export function renderZones(container: HTMLElement, zones: ProductZone[]): void {
  container.innerHTML = '';
  for (const z of zones) {
    const el = document.createElement('div');
    el.className = 'product';
    el.dataset.zoneId = z.id;
    el.style.left = `${z.x * 100}%`;
    el.style.top = `${z.y * 100}%`;
    el.style.width = `${z.w * 100}%`;
    el.style.height = `${z.h * 100}%`;
    const label = document.createElement('span');
    label.className = 'product-label';
    label.textContent = z.label;
    el.appendChild(label);
    container.appendChild(el);
  }
}

interface ZoneRect extends ProductZone {
  rect: DOMRect;
}

export class DwellTracker {
  private zoneRects: ZoneRect[] = [];
  private totals = new Map<string, number>();
  private lastT: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly zones: ProductZone[],
  ) {
    for (const z of zones) this.totals.set(z.id, 0);
    this.recomputeRects();
  }

  /** Call after layout changes — resize, or the container becoming visible. */
  recomputeRects(): void {
    const box = this.container.getBoundingClientRect();
    this.zoneRects = this.zones.map((z) => ({
      ...z,
      rect: new DOMRect(box.x + z.x * box.width, box.y + z.y * box.height, z.w * box.width, z.h * box.height),
    }));
  }

  /** `x, y` in viewport (client) coordinates — the same space `getBoundingClientRect` uses. */
  update(x: number, y: number, tMs: number): void {
    if (this.lastT === null) {
      this.lastT = tMs;
      return;
    }
    const dt = Math.max(tMs - this.lastT, 0);
    this.lastT = tMs;
    if (dt === 0 || dt > 500) return; // a pause (mode switch, tab hidden) isn't dwell

    for (const z of this.zoneRects) {
      const r = z.rect;
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        this.totals.set(z.id, (this.totals.get(z.id) ?? 0) + dt);
        return;
      }
    }
  }

  reset(): void {
    for (const z of this.zones) this.totals.set(z.id, 0);
    this.lastT = null;
  }

  stats(): Array<{ id: string; label: string; ms: number; pct: number }> {
    const total = [...this.totals.values()].reduce((a, b) => a + b, 0);
    return this.zones
      .map((z) => {
        const ms = this.totals.get(z.id) ?? 0;
        return { id: z.id, label: z.label, ms, pct: total > 0 ? (ms / total) * 100 : 0 };
      })
      .sort((a, b) => b.ms - a.ms);
  }
}

/** A soft, decaying trail of recent gaze points — a live heatmap, not a static one. */
export class Heatmap {
  private ctx: CanvasRenderingContext2D;
  private pending: Array<{ x: number; y: number }> = [];
  private raf: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** `x, y` in viewport coordinates; converted to canvas-local internally. */
  addPoint(x: number, y: number): void {
    const box = this.canvas.getBoundingClientRect();
    this.pending.push({ x: x - box.x, y: y - box.y });
  }

  start(): void {
    if (this.raf !== null) return;
    const step = (): void => {
      this.tick();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private tick(): void {
    const { ctx, canvas } = this;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pending) {
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 36);
      gradient.addColorStop(0, 'rgba(255, 90, 60, 0.35)');
      gradient.addColorStop(1, 'rgba(255, 90, 60, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 36, 0, Math.PI * 2);
      ctx.fill();
    }
    this.pending = [];
  }
}
