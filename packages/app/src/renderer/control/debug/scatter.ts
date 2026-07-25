/**
 * Debug mode 5 — calibration samples in gaze-feature space.
 *
 * Every sample plotted at its own (gx, gy), coloured by target. If the fixation
 * clusters form a recognisable grid, the signal separated the targets and any
 * remaining error is the model's problem. If they merge, no regression can
 * help, because the information is not in the data (ADR-0018).
 *
 * ## Equal aspect is the whole point
 *
 * The first version of this scaled each axis independently to fill the canvas.
 * That is actively misleading here: vertical iris travel is genuinely about
 * half of horizontal, and stretching gy to fill the box hides exactly the
 * asymmetry the plot exists to reveal. Both axes now share one scale, so a
 * squashed vertical band reads as what it is — a squashed vertical signal.
 *
 * The statistics live in `@eye-tracker/core` so they can be tested; this file
 * only draws.
 */

import { gridCell, type CalibrationScatterPoint, type ScatterSummary } from '@eye-tracker/core';

/** Distinct hues, ordered so adjacent grid targets are easy to tell apart. */
const HUES = [0, 35, 60, 110, 160, 190, 220, 275, 320];

function hue(i: number): string {
  return `hsl(${HUES[i % HUES.length]}, 75%, 62%)`;
}

export interface ScatterOptions {
  /** Head-motion clusters are noise by construction; hiding them declutters. */
  showHeadMotion: boolean;
  gridCount: number;
}

interface Centroid {
  index: number;
  gx: number;
  gy: number;
}

function centroids(
  points: readonly CalibrationScatterPoint[],
  keep: (i: number) => boolean,
): Centroid[] {
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (const p of points) {
    if (!p.kept || !keep(p.targetIndex)) continue;
    const c = acc.get(p.targetIndex) ?? { x: 0, y: 0, n: 0 };
    c.x += p.gx;
    c.y += p.gy;
    c.n++;
    acc.set(p.targetIndex, c);
  }
  return [...acc.entries()]
    .map(([index, c]) => ({ index, gx: c.x / c.n, gy: c.y / c.n }))
    .sort((a, b) => a.index - b.index);
}

export function drawScatter(
  canvas: HTMLCanvasElement,
  points: readonly CalibrationScatterPoint[],
  summary: ScatterSummary,
  options: ScatterOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 420;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, cssW, cssH);

  const { gridCount, showHeadMotion } = options;
  const isGrid = (i: number) => i < gridCount;
  const visible = points.filter((p) => showHeadMotion || isGrid(p.targetIndex));

  if (visible.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('No calibration samples yet', 12, 24);
    return;
  }

  // --- equal-aspect projection -------------------------------------------
  //
  // Range is taken from the KEPT samples only. A single rejected outlier at
  // (9, 9) would otherwise compress every real cluster into one pixel.
  const kept = visible.filter((p) => p.kept);
  const basis = kept.length > 0 ? kept : visible;

  let lox = Infinity;
  let hix = -Infinity;
  let loy = Infinity;
  let hiy = -Infinity;
  for (const p of basis) {
    lox = Math.min(lox, p.gx);
    hix = Math.max(hix, p.gx);
    loy = Math.min(loy, p.gy);
    hiy = Math.max(hiy, p.gy);
  }

  const pad = 34;
  const spanX = Math.max(hix - lox, 1e-6);
  const spanY = Math.max(hiy - loy, 1e-6);
  // One scale for both axes: this is what makes a narrow gy range visibly
  // narrow instead of being stretched to fill the panel.
  const scale = Math.min((cssW - 2 * pad) / spanX, (cssH - 2 * pad) / spanY);
  const midX = (lox + hix) / 2;
  const midY = (loy + hiy) / 2;
  const px = (v: number) => cssW / 2 + (v - midX) * scale;
  const py = (v: number) => cssH / 2 + (v - midY) * scale;

  // --- reference frame ----------------------------------------------------
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px(lox), py(loy), spanX * scale, spanY * scale);

  // A square showing what an equal gx and gy excursion looks like, so "the
  // vertical band is half the width of the horizontal one" is readable off the
  // picture without doing arithmetic.
  const unit = 0.05;
  if (unit * scale > 12 && unit * scale < Math.min(cssW, cssH)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(pad * 0.5 + 6, cssH - pad * 0.5 - 6 - unit * scale, unit * scale, unit * scale);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText('0.05²', pad * 0.5 + 9, cssH - pad * 0.5 - 10);
  }

  // --- samples ------------------------------------------------------------
  for (const p of visible) {
    const head = !isGrid(p.targetIndex);
    ctx.beginPath();
    ctx.arc(px(p.gx), py(p.gy), p.kept ? 2 : 3, 0, Math.PI * 2);
    if (!p.kept) {
      // Rejected outliers: hollow, so a thin cluster is visibly explained by
      // rejections rather than looking like missing data.
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (head) {
      // Head-motion samples are supposed to be smeared; drawn grey so they
      // never read as a failed fixation cluster.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = 'rgba(150,160,175,0.9)';
      ctx.fill();
    } else {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = hue(p.targetIndex);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- grid mesh ----------------------------------------------------------
  //
  // Connect the fixation centroids in their true grid adjacency. A healthy
  // calibration draws a deformed but untangled mesh; crossing edges mean the
  // mapping folds, which is a different (and worse) failure than tight
  // clusters.
  const gridCentroids = centroids(points, isGrid);
  const byCell = new Map<string, Centroid>();
  for (const c of gridCentroids) {
    const cell = gridCell(c.index, gridCount);
    if (cell) byCell.set(`${cell.col},${cell.row}`, c);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const here = byCell.get(`${col},${row}`);
      if (!here) continue;
      for (const [dc, dr] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const next = byCell.get(`${col + dc},${row + dr}`);
        if (!next) continue;
        ctx.beginPath();
        ctx.moveTo(px(here.gx), py(here.gy));
        ctx.lineTo(px(next.gx), py(next.gy));
        ctx.stroke();
      }
    }
  }

  // --- centroids ----------------------------------------------------------
  for (const c of gridCentroids) {
    ctx.beginPath();
    ctx.arc(px(c.gx), py(c.gy), 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(String(c.index), px(c.gx) + 7, py(c.gy) - 5);
  }

  if (showHeadMotion) {
    ctx.setLineDash([2, 2]);
    for (const c of centroids(points, (i) => !isGrid(i))) {
      ctx.beginPath();
      ctx.arc(px(c.gx), py(c.gy), 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(150,160,175,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // --- axis captions ------------------------------------------------------
  //
  // Both ranges, always. Labelling only gx was what made it impossible to
  // answer "is the vertical axis worse?" from the picture.
  ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText(`gx  ${lox.toFixed(3)} … ${hix.toFixed(3)}   (span ${spanX.toFixed(3)})`, cssW / 2, cssH - 8);

  ctx.save();
  ctx.translate(11, cssH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`gy  ${loy.toFixed(3)} … ${hiy.toFixed(3)}   (span ${spanY.toFixed(3)})`, 0, 0);
  ctx.restore();

  // Span ratio: the single number that answers "how much worse is vertical?"
  ctx.textAlign = 'left';
  ctx.fillStyle = spanY / spanX < 0.5 ? 'rgba(255, 209, 102, 0.9)' : 'rgba(255,255,255,0.5)';
  ctx.fillText(`gy span is ${((spanY / spanX) * 100).toFixed(0)}% of gx`, pad * 0.5 + 6, 16);

  if (summary.headMotionClusters > 0) {
    ctx.fillStyle = 'rgba(150,160,175,0.75)';
    ctx.fillText(
      showHeadMotion
        ? `grey = ${summary.headMotionClusters} head-motion clusters (excluded from the stats)`
        : `${summary.headMotionClusters} head-motion clusters hidden`,
      pad * 0.5 + 6,
      30,
    );
  }
  ctx.textAlign = 'start';
}
