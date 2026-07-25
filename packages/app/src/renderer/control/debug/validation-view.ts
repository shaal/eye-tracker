/**
 * Debug mode 3 — the validation error map.
 *
 * One picture of the screen with, at every tested point, an arrow from where
 * you were told to look to where the tracker thought you were looking, and an
 * ellipse showing how much the estimate scattered while you held that fixation.
 *
 * Arrow length is accuracy, ellipse size is precision, and the two have
 * opposite remedies (see `validation/protocol.ts`). Drawing them together also
 * exposes the patterns a single average hides:
 *
 *   arrows all pointing the same way   → a uniform offset. You sat differently
 *                                        than you calibrated; recalibrate.
 *   arrows splaying outward from centre → the quadratic terms under-fit the
 *                                        periphery. More calibration points.
 *   one bad corner, rest fine          → you never looked properly at that
 *                                        calibration dot.
 *   big ellipses everywhere            → noise, not mapping. Nothing about
 *                                        calibration will help.
 */

import type { ScreenBounds, ValidationReport } from '@eye-tracker/core';

export function drawValidationMap(
  canvas: HTMLCanvasElement,
  report: ValidationReport,
  bounds: ScreenBounds,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 480;
  // Preserve the screen's aspect ratio: a squashed map would make a vertical
  // bias look like a horizontal one.
  const aspect = bounds.height / Math.max(1, bounds.width);
  const cssH = Math.round(cssW * aspect);
  if (canvas.height !== Math.round(cssH * dpr) || canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);

  const s = cssW / Math.max(1, bounds.width);
  const toX = (x: number) => (x - bounds.x) * s;
  const toY = (y: number) => (y - bounds.y) * s;

  if (report.targets.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No usable validation data', 12, 24);
    return;
  }

  for (const t of report.targets) {
    const tx = toX(t.target.x);
    const ty = toY(t.target.y);
    const mx = toX(t.mean.x);
    const my = toY(t.mean.y);

    // Dispersion ellipse at ±1 SD per axis. Axis-aligned rather than a proper
    // covariance ellipse: the extra rigour would not change any decision the
    // user makes from this picture.
    ctx.beginPath();
    ctx.ellipse(mx, my, Math.max(1, t.sdX * s), Math.max(1, t.sdY * s), 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120, 170, 255, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 170, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Bias arrow, target → mean prediction.
    const errDeg = report.pxPerDegree > 0 ? t.accuracyPx / report.pxPerDegree : Number.NaN;
    const stroke =
      errDeg < 1.0
        ? 'rgba(88, 214, 141, 0.95)'
        : errDeg < 2.0
          ? 'rgba(255, 209, 102, 0.95)'
          : 'rgba(255, 107, 107, 0.95)';
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(mx, my);
    ctx.stroke();

    // Arrowhead, only when the arrow is long enough for one to read as such.
    const len = Math.hypot(mx - tx, my - ty);
    if (len > 8) {
      const a = Math.atan2(my - ty, mx - tx);
      const h = 6;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - h * Math.cos(a - 0.4), my - h * Math.sin(a - 0.4));
      ctx.lineTo(mx - h * Math.cos(a + 0.4), my - h * Math.sin(a + 0.4));
      ctx.closePath();
      ctx.fill();
    }

    // The target itself.
    ctx.beginPath();
    ctx.arc(tx, ty, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(Number.isFinite(errDeg) ? `${errDeg.toFixed(1)}°` : '—', tx + 6, ty - 6);
  }

  // Scale reference: without one, "how big is that ellipse" has no answer.
  if (report.pxPerDegree > 0) {
    const oneDeg = report.pxPerDegree * s;
    const x0 = 12;
    const y0 = cssH - 14;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + oneDeg, y0);
    ctx.moveTo(x0, y0 - 3);
    ctx.lineTo(x0, y0 + 3);
    ctx.moveTo(x0 + oneDeg, y0 - 3);
    ctx.lineTo(x0 + oneDeg, y0 + 3);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('1°', x0 + oneDeg + 5, y0 + 3);
  }
}
