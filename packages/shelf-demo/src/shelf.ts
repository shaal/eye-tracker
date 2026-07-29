/**
 * The simulated shelf: product zones, dwell-time accounting, and a decaying
 * heatmap trail. Deliberately generic product names — this is a layout demo,
 * not an endorsement of or dig at any real brand.
 */

export interface ProductZone {
  id: string;
  label: string;
  /**
   * A hotlinked photo (Pexels/Unsplash direct image URL — both licenses
   * explicitly permit this without attribution). Not vendored locally: this
   * demo depends on the network for this one thing, unlike the rest of it.
   * If a link ever breaks, `renderZones` falls back to the text label rather
   * than showing a broken-image icon mid-pitch.
   */
  image: string;
  /** Fractional position within the shelf container, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * All Pexels — direct photo URLs, hotlinked rather than vendored (see
 * `ProductZone.image`). Pexels License: free for commercial use, no
 * attribution required, hotlinking permitted. Each was verified to actually
 * resolve (HTTP 200, `content-type: image/jpeg`) before being used here.
 *
 * Two are compromises, not exact matches — flagged rather than silently
 * passed off as generic-and-accurate:
 * - `bran-flakes`: the closest candidate found reads visually as plain thin
 *   brown flakes; its own source alt-text calls it "cornflakes."
 * - `bbq-chips`: a styled bowl of chips with sauce, not a bagged BBQ-chips
 *   shot — no unbranded bagged option turned up after ~15 candidates.
 */
type ZoneId = 'z0' | 'z1' | 'z2' | 'z3' | 'z4' | 'z5' | 'z6' | 'z7' | 'z8' | 'z9' | 'z10' | 'z11';

const PRODUCT_IMAGES: Record<ZoneId, string> = {
  z0: 'https://images.pexels.com/photos/3886613/pexels-photo-3886613.jpeg',
  z1: 'https://images.pexels.com/photos/6104144/pexels-photo-6104144.jpeg',
  z2: 'https://images.pexels.com/photos/3872412/pexels-photo-3872412.jpeg',
  z3: 'https://images.pexels.com/photos/7847920/pexels-photo-7847920.jpeg',
  z4: 'https://images.pexels.com/photos/13060681/pexels-photo-13060681.jpeg',
  z5: 'https://images.pexels.com/photos/38446289/pexels-photo-38446289.jpeg',
  z6: 'https://images.pexels.com/photos/1894325/pexels-photo-1894325.jpeg',
  z7: 'https://images.pexels.com/photos/14122549/pexels-photo-14122549.jpeg',
  z8: 'https://images.pexels.com/photos/8879617/pexels-photo-8879617.jpeg',
  z9: 'https://images.pexels.com/photos/4195603/pexels-photo-4195603.jpeg',
  z10: 'https://images.pexels.com/photos/13723906/pexels-photo-13723906.jpeg',
  z11: 'https://images.pexels.com/photos/1484678/pexels-photo-1484678.jpeg',
};

/** Three shelf levels of four products each — plausible, not photographic. */
export const DEFAULT_ZONES: ProductZone[] = [
  { id: 'z0', label: 'Whole Grain Cereal', image: PRODUCT_IMAGES.z0, x: 0.02, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z1', label: 'Frosted Flakes-Style', image: PRODUCT_IMAGES.z1, x: 0.27, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z2', label: 'Granola Clusters', image: PRODUCT_IMAGES.z2, x: 0.52, y: 0.04, w: 0.22, h: 0.28 },
  { id: 'z3', label: 'Bran Flakes', image: PRODUCT_IMAGES.z3, x: 0.77, y: 0.04, w: 0.21, h: 0.28 },

  { id: 'z4', label: 'Sea Salt Chips', image: PRODUCT_IMAGES.z4, x: 0.02, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z5', label: 'BBQ Chips', image: PRODUCT_IMAGES.z5, x: 0.27, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z6', label: 'Pretzel Twists', image: PRODUCT_IMAGES.z6, x: 0.52, y: 0.36, w: 0.22, h: 0.28 },
  { id: 'z7', label: 'Trail Mix', image: PRODUCT_IMAGES.z7, x: 0.77, y: 0.36, w: 0.21, h: 0.28 },

  { id: 'z8', label: 'Cola', image: PRODUCT_IMAGES.z8, x: 0.02, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z9', label: 'Diet Cola', image: PRODUCT_IMAGES.z9, x: 0.27, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z10', label: 'Sparkling Water', image: PRODUCT_IMAGES.z10, x: 0.52, y: 0.68, w: 0.22, h: 0.28 },
  { id: 'z11', label: 'Iced Tea', image: PRODUCT_IMAGES.z11, x: 0.77, y: 0.68, w: 0.21, h: 0.28 },
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

    const img = document.createElement('img');
    img.className = 'product-photo';
    img.src = z.image;
    img.alt = z.label;
    img.loading = 'lazy';
    // A hotlinked photo can fail live (link rot, rate limiting) in a way
    // nothing local ever would — falling back to the text label beats a
    // broken-image icon in the middle of a pitch.
    img.addEventListener('error', () => el.classList.add('product--image-failed'), { once: true });
    el.appendChild(img);

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
    // Points queued via addPoint() but not yet drawn would otherwise survive
    // the clear and paint on the very next animation frame, making a reset
    // look like it silently failed.
    this.pending = [];
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
