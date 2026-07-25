/**
 * Click-through crosshair + calibration target renderer (ADR-0012).
 *
 * Draws to a canvas in a requestAnimationFrame loop, reading the newest state
 * from a mutable variable that IPC writes into. State updates are never
 * queued — an overwritten cursor position is the correct semantics, since only
 * the latest one matters.
 */

import type { CalibrationUiState, OverlayState } from '@eye-tracker/core';

const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');

let state: OverlayState | null = null;
let calibration: CalibrationUiState | null = null;
/** Phase-local clock for the calibration target animation. */
let phaseStartedAt = performance.now();
let lastPhase = '';

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resize);
resize();

window.eyeTracker.onOverlay((s) => {
  state = s;
});

window.eyeTracker.onCalibrationUi((c) => {
  if (c.phase !== lastPhase) {
    lastPhase = c.phase;
    phaseStartedAt = performance.now();
  }
  calibration = c;
});

/**
 * The overlay window spans the union of all displays, but the canvas origin is
 * the window's top-left. Screen coordinates can be negative on multi-display
 * setups, so convert rather than assuming they match.
 */
function toCanvas(x: number, y: number): [number, number] {
  return [x - window.screenX, y - window.screenY];
}

function drawCrosshair(s: OverlayState): void {
  if (!ctx || !s.hasGaze) return;

  const [x, y] = toCanvas(s.x, s.y);

  // Colour encodes state so the user can tell at a glance whether the tracker
  // is driving the cursor.
  const active = s.controlEnabled;
  const stroke = active ? 'rgba(88, 214, 141, 0.95)' : 'rgba(120, 170, 255, 0.75)';
  const blinking = s.blinkPhase !== 0;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;

  const gap = 6;
  const arm = 16;
  ctx.beginPath();
  ctx.moveTo(x - arm - gap, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + arm + gap, y);
  ctx.moveTo(x, y - arm - gap);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + arm + gap);
  ctx.stroke();

  // Ring: filled while the fixation clamp holds, dashed during a blink.
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  if (blinking) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.95)';
  } else if (s.clamped) {
    ctx.fillStyle = 'rgba(88, 214, 141, 0.18)';
    ctx.fill();
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Click flash.
  if (s.clickPulse > 0) {
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Unfiltered gaze, for diagnosing whether jitter is tracking or filtering.
  if (s.showRaw) {
    const [rx, ry] = toCanvas(s.rawX, s.rawY);
    ctx.beginPath();
    ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 107, 107, 0.6)';
    ctx.fill();
  }

  ctx.restore();
}

function drawCalibration(c: CalibrationUiState): void {
  if (!ctx) return;

  // Dim the desktop so nothing competes with the target for attention.
  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 14, 0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const target = c.targets[c.currentIndex];
  if (target) {
    const [x, y] = toCanvas(target.x, target.y);
    const elapsed = performance.now() - phaseStartedAt;

    if (c.phase === 'settle') {
      // Shrink to draw and hold fixation before any sampling starts.
      const t = Math.min(1, elapsed / 600);
      const radius = 40 - 26 * t;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (c.phase === 'collect') {
      // A filling ring tells the user to hold still, and for how long.
      const t = Math.min(1, elapsed / 700);
      ctx.beginPath();
      ctx.arc(x, y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.strokeStyle = 'rgba(88, 214, 141, 0.95)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // The fixation point itself: small, high contrast, with a dark centre so
    // the eye has something precise to land on.
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1117';
    ctx.fill();
  }

  ctx.textAlign = 'center';
  const n = c.targets.length;
  const shown = Math.min(n, c.currentIndex + 1);

  // The head-motion instruction is the whole point of that phase, so it gets
  // emphasis rather than sharing a line with the counter (ADR-0015).
  ctx.fillStyle = c.headMotion ? 'rgba(255, 209, 102, 0.95)' : 'rgba(255,255,255,0.8)';
  ctx.font = `${c.headMotion ? '600 19px' : '15px'} -apple-system, system-ui, sans-serif`;
  ctx.fillText(
    c.prompt || 'Look at the dot',
    window.innerWidth / 2,
    window.innerHeight - 72,
  );

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '13px -apple-system, system-ui, sans-serif';
  ctx.fillText(`${shown} of ${n}`, window.innerWidth / 2, window.innerHeight - 46);
  ctx.restore();
}

function render(): void {
  requestAnimationFrame(render);
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (calibration?.active) {
    drawCalibration(calibration);
    return;
  }
  if (state?.visible) drawCrosshair(state);
}

render();
