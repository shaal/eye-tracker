/**
 * Draws the eye measurement over the camera preview.
 *
 * This is the visual check for ADR-0005 (milestone M1): the drawn basis vector
 * should rotate with your head, and `gx`/`gy` should stay put when you roll
 * your head or lean toward the camera while holding your gaze fixed.
 */

import type { EyeLandmarks, GazeFeatures } from '@eye-tracker/core';

export function drawDebugOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  f: GazeFeatures,
  _eyes: { EYE_A: EyeLandmarks; EYE_B: EyeLandmarks },
): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  if (!f.ok) {
    ctx.fillStyle = 'rgba(255, 107, 107, 0.9)';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('no face', 12, 26);
    return;
  }

  for (const eye of [f.eyeA, f.eyeB]) {
    if (eye.width <= 0) continue;

    const cx = eye.centerX * w;
    const cy = eye.centerY * h;
    const ix = eye.irisX * w;
    const iy = eye.irisY * h;
    // Eye width is normalized in frame units; scale by the frame width to draw.
    const len = eye.width * w;

    // The eye's own axis — this is the basis the iris offset is measured
    // against, and it rotating with the head is what makes gx/gy roll-invariant.
    ctx.strokeStyle = 'rgba(120, 170, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - (eye.ux * len) / 2, cy - (eye.uy * len) / 2);
    ctx.lineTo(cx + (eye.ux * len) / 2, cy + (eye.uy * len) / 2);
    ctx.stroke();

    // Perpendicular.
    ctx.strokeStyle = 'rgba(120, 170, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(cx + (eye.uy * len) / 4, cy - (eye.ux * len) / 4);
    ctx.lineTo(cx - (eye.uy * len) / 4, cy + (eye.ux * len) / 4);
    ctx.stroke();

    // Eye centre.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Iris centre — the thing whose offset is the gaze signal.
    ctx.strokeStyle = 'rgba(88, 214, 141, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ix, iy, 5, 0, Math.PI * 2);
    ctx.stroke();

    // Offset vector from eye centre to iris.
    ctx.strokeStyle = 'rgba(88, 214, 141, 0.6)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ix, iy);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '14px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(`gx ${f.gx.toFixed(3)}  gy ${f.gy.toFixed(3)}`, 12, 22);
  ctx.fillText(`quality ${f.quality.toFixed(2)}`, 12, 40);
}
