/**
 * Debug mode 2 — the signal scope.
 *
 * Three very different faults all feel identical in use ("the cursor is
 * unstable"), and telling them apart from a live cursor is essentially
 * impossible. Plotted against time they are unmistakable:
 *
 *   sensor noise    raw trace is fuzzy; filtered trace is smooth but centred on
 *                   the same place. Fix upstream — light, distance, camera.
 *   over-smoothing  raw trace is clean; filtered trace is a visibly delayed
 *                   copy. Fix with minCutoff / beta (ADR-0007).
 *   clamp sticking  raw trace moves; filtered trace is a flat line, then jumps.
 *                   Fix with clampRadius / clampMs (ADR-0014).
 *
 * So the scope draws raw and filtered on the same axes, and shades the spans
 * where the fixation clamp was holding.
 */

const CAPACITY = 600; // ~20 s at 30 fps

interface Sample {
  t: number;
  gx: number;
  gy: number;
  rawX: number;
  rawY: number;
  x: number;
  y: number;
  clamped: boolean;
  quality: number;
}

export type ScopeChannel = 'features' | 'screen-x' | 'screen-y';

export class Scope {
  private buf: Sample[] = [];

  push(s: Sample): void {
    this.buf.push(s);
    if (this.buf.length > CAPACITY) this.buf.shift();
  }

  clear(): void {
    this.buf = [];
  }

  get length(): number {
    return this.buf.length;
  }

  draw(canvas: HTMLCanvasElement, channel: ScopeChannel, windowMs: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 480;
    const cssH = canvas.clientHeight || 140;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(0, 0, cssW, cssH);

    if (this.buf.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('waiting for frames…', 10, 20);
      return;
    }

    const now = this.buf[this.buf.length - 1]?.t ?? 0;
    const t0 = now - windowMs;
    const visible = this.buf.filter((s) => s.t >= t0);
    if (visible.length < 2) return;

    // Two series per channel: what the model produced, and what the filter let
    // through. Auto-scaled together so their vertical separation is the lag.
    const pick = (s: Sample): [number, number] =>
      channel === 'features'
        ? [s.gx, s.gy]
        : channel === 'screen-x'
          ? [s.rawX, s.x]
          : [s.rawY, s.y];

    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of visible) {
      const [a, b] = pick(s);
      lo = Math.min(lo, a, b);
      hi = Math.max(hi, a, b);
    }
    // A dead-flat trace would divide by zero and, worse, would be magnified
    // into a wall of noise. Give it a floor so flat reads as flat.
    const span = Math.max(hi - lo, channel === 'features' ? 0.02 : 20);
    const mid = (hi + lo) / 2;
    lo = mid - span / 2;
    hi = mid + span / 2;

    const px = (t: number) => ((t - t0) / windowMs) * cssW;
    const py = (v: number) => cssH - ((v - lo) / (hi - lo)) * cssH;

    // Clamp-held spans, drawn first so the traces sit on top.
    ctx.fillStyle = 'rgba(88, 214, 141, 0.10)';
    let runStart: number | null = null;
    for (const s of visible) {
      if (s.clamped && runStart === null) runStart = s.t;
      if (!s.clamped && runStart !== null) {
        ctx.fillRect(px(runStart), 0, Math.max(1, px(s.t) - px(runStart)), cssH);
        runStart = null;
      }
    }
    if (runStart !== null) ctx.fillRect(px(runStart), 0, cssW - px(runStart), cssH);

    // Low-quality spans: a trace doing something odd while quality was on the
    // floor is explained, not mysterious.
    ctx.fillStyle = 'rgba(255, 107, 107, 0.12)';
    for (const s of visible) {
      if (s.quality < 0.4) ctx.fillRect(px(s.t) - 1, 0, 2, cssH);
    }

    const series = (idx: 0 | 1, stroke: string, width: number) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      visible.forEach((s, i) => {
        const v = pick(s)[idx];
        const X = px(s.t);
        const Y = py(v);
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    };

    // Raw thin and pale, filtered thick and bright: the eye reads the bright
    // line as "what I get" and the pale one as "what was available".
    series(0, 'rgba(255, 107, 107, 0.65)', 1);
    series(1, 'rgba(120, 170, 255, 0.95)', 2);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
    const legend =
      channel === 'features' ? 'gx (red) / gy (blue)' : 'raw (red) / filtered (blue)';
    ctx.fillText(legend, 8, 14);
    ctx.fillText(`${(windowMs / 1000).toFixed(0)}s  span ${span.toFixed(channel === 'features' ? 3 : 0)}`, 8, cssH - 6);
  }

  /**
   * Median lag between the raw and filtered screen traces, in ms.
   *
   * Estimated by cross-correlation over a small set of candidate shifts: for
   * each shift, how well does the filtered trace match the raw trace delayed by
   * that much. The best-matching shift is the smoothing delay you are feeling.
   *
   * Returns NaN when there is not enough movement to measure — a lag estimate
   * from a stationary signal is meaningless, and reporting 0 would read as
   * "no lag" rather than "unknown".
   */
  estimateLagMs(): number {
    const n = this.buf.length;
    if (n < 90) return Number.NaN;

    const raw = this.buf.map((s) => s.rawX);
    const filt = this.buf.map((s) => s.x);
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const mr = mean(raw);
    const mf = mean(filt);
    const variance = raw.reduce((a, b) => a + (b - mr) ** 2, 0) / n;
    // Under ~15 px RMS of movement there is nothing to correlate against.
    if (Math.sqrt(variance) < 15) return Number.NaN;

    const dt = (this.buf[n - 1]!.t - this.buf[0]!.t) / (n - 1);
    let bestShift = 0;
    let bestScore = -Infinity;
    for (let shift = 0; shift <= 20; shift++) {
      let dot = 0;
      let count = 0;
      for (let i = shift; i < n; i++) {
        dot += (raw[i - shift]! - mr) * (filt[i]! - mf);
        count++;
      }
      const score = count > 0 ? dot / count : -Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestShift = shift;
      }
    }
    return bestShift * dt;
  }
}
