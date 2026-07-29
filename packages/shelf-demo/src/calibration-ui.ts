/**
 * A quick 3×3 calibration over the shelf area itself — reusing the production
 * app's own settle/collect timing constants. Sampling is count- rather than
 * time-driven for the same reason as the Electron app (a slow camera
 * otherwise starves the fit with no visible symptom): see
 * `docs/plan/04-windows-port.md` on the `feat/windows-port` branch for the
 * full story. `CALIBRATION_SAMPLING` itself isn't in `@eye-tracker/core` on
 * `main` yet — this package intentionally doesn't depend on an unmerged
 * branch, so the same small constants are defined here instead. The fit is
 * `gaze-model.ts`'s demo-grade affine, not the production ridge regression —
 * see that module's header.
 */

import { CALIBRATION_TIMING, type GazeFeatures } from '@eye-tracker/core';
import { GazeCalibrator, type CalibrationResult } from './gaze-model.js';

/** Mirrors `CALIBRATION_SAMPLING` from the Windows-port branch (see above). */
const SAMPLING = {
  targetSamples: 15,
  maxCollectMs: 2000,
  pollMs: 50,
} as const;

/** Inset from the shelf edges so no dot sits under a product's own edge. */
const MARGIN = 0.1;
/** Keeps the dot's own circle fully on screen even at the clamp boundary. */
const VIEWPORT_INSET_PX = 20;

/**
 * Target points in viewport (client) coordinates — the same space samples
 * and later predictions use, matching `DwellTracker`/`Heatmap`.
 *
 * Clamped to the viewport regardless of what `shelfRect` says: `shelfRect`
 * should already be on-screen, but a window narrower or shorter than the
 * layout expects (a small browser window, an aggressive zoom level) could
 * still push it partly off — and a calibration dot the user is asked to look
 * at has to be looked-at-able. The clamp is the hard guarantee; getting
 * `shelfRect` right is what keeps the clamp from ever actually triggering.
 */
function targetGrid(rect: DOMRect): Array<{ x: number; y: number }> {
  const xs = [MARGIN, 0.5, 1 - MARGIN];
  const ys = [MARGIN, 0.5, 1 - MARGIN];
  const clampX = (v: number) => Math.min(Math.max(v, VIEWPORT_INSET_PX), window.innerWidth - VIEWPORT_INSET_PX);
  const clampY = (v: number) => Math.min(Math.max(v, VIEWPORT_INSET_PX), window.innerHeight - VIEWPORT_INSET_PX);
  const points: Array<{ x: number; y: number }> = [];
  for (const fy of ys) {
    for (const fx of xs) {
      points.push({ x: clampX(rect.x + fx * rect.width), y: clampY(rect.y + fy * rect.height) });
    }
  }
  return points;
}

const MIN_QUALITY = 0.3;

export async function runCalibration(
  overlay: HTMLElement,
  shelfRect: DOMRect,
  getLatestFeatures: () => { features: GazeFeatures; tMs: number } | null,
  onProgress: (pointIndex: number, total: number) => void,
): Promise<CalibrationResult | null> {
  const points = targetGrid(shelfRect);
  const calibrator = new GazeCalibrator();

  overlay.hidden = false;
  overlay.innerHTML = '';
  const dot = document.createElement('div');
  dot.className = 'calibration-dot';
  overlay.appendChild(dot);
  // The overlay is positioned relative to .shelf-pane, not the viewport, so a
  // point in viewport coordinates has to be re-based to the overlay's own
  // origin before it's used as a CSS offset. Getting this backwards is exactly
  // what put dots in the wrong place (and sometimes off-screen) before: the
  // sample recorded the *intended* viewport point while the dot rendered
  // somewhere else entirely, so the user calibrated against a target that
  // wasn't where they were actually looking.
  const overlayRect = overlay.getBoundingClientRect();

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    onProgress(i, points.length);

    dot.style.left = `${p.x - overlayRect.x}px`;
    dot.style.top = `${p.y - overlayRect.y}px`;
    dot.classList.remove('collecting');

    await sleep(CALIBRATION_TIMING.settleMs);
    dot.classList.add('collecting');
    await sleep(CALIBRATION_TIMING.discardMs);

    const samples: Array<{ gx: number; gy: number; hx: number; hy: number }> = [];
    const startedAt = Date.now();
    const minMs = CALIBRATION_TIMING.collectMs - CALIBRATION_TIMING.discardMs;
    for (;;) {
      const latest = getLatestFeatures();
      if (latest && latest.features.ok && latest.features.quality >= MIN_QUALITY) {
        const f = latest.features;
        samples.push({ gx: f.gx, gy: f.gy, hx: f.hx, hy: f.hy });
      }
      const elapsed = Date.now() - startedAt;
      const enough = elapsed >= minMs && samples.length >= SAMPLING.targetSamples;
      if (enough || elapsed >= SAMPLING.maxCollectMs) break;
      await sleep(SAMPLING.pollMs);
    }

    if (samples.length > 0) {
      const mean = (pick: (s: (typeof samples)[number]) => number) =>
        samples.reduce((a, s) => a + pick(s), 0) / samples.length;
      calibrator.addSample(mean((s) => s.gx), mean((s) => s.gy), mean((s) => s.hx), mean((s) => s.hy), p.x, p.y);
    }

    await sleep(CALIBRATION_TIMING.gapMs);
  }

  overlay.hidden = true;
  overlay.innerHTML = '';
  return calibrator.sampleCount >= 4 ? calibrator.fit() : null;
}
