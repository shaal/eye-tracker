/**
 * Click-through crosshair + calibration target renderer (ADR-0012).
 *
 * Draws to a canvas in a requestAnimationFrame loop, reading the newest state
 * from a mutable variable that IPC writes into. State updates are never
 * queued — an overwritten cursor position is the correct semantics, since only
 * the latest one matters.
 */

import {
  VALIDATION_TIMING,
  type CalibrationUiState,
  type OverlayState,
  type ValidationUiState,
} from '@eye-tracker/core';

const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');

let state: OverlayState | null = null;
let calibration: CalibrationUiState | null = null;
let validation: ValidationUiState | null = null;
/** Phase-local clock for the calibration target animation. */
let phaseStartedAt = performance.now();
let lastPhase = '';
/** Separate clock, so a validation phase change cannot reset the calibration one. */
let validationPhaseAt = performance.now();
let lastValidationPhase = '';

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
 * Click anywhere to dismiss an instruction card.
 *
 * The overlay is click-through except while a card is up, when main flips
 * `setIgnoreMouseEvents(false)` — so in practice this only ever fires during
 * the 'instruct' phase. The phase check in `skipInstruction` makes that
 * belt-and-braces rather than load-bearing.
 */
window.addEventListener('mousedown', () => {
  if (calibration?.phase === 'instruct') void window.eyeTracker.skipInstruction();
});

window.eyeTracker.onValidationUi((v) => {
  if (v.phase !== lastValidationPhase) {
    lastValidationPhase = v.phase;
    validationPhaseAt = performance.now();
  }
  validation = v;
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

/**
 * Wrap text to a maximum width, measuring against the live canvas font.
 *
 * Needed because the instruction headline is set at a size proportional to the
 * window: on a narrow display a phrase that fits on one line at 1080p would
 * otherwise run off both edges.
 */
function wrap(text: string, maxWidth: number): string[] {
  if (!ctx) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The full-screen instruction card.
 *
 * Deliberately shows **no dot**. The whole failure this fixes was the user
 * reading an instruction while a target was already collecting; putting the dot
 * on the card would reintroduce exactly that split attention. The dot appears
 * only once the card has cleared.
 */
function drawInstruction(c: CalibrationUiState): void {
  if (!ctx) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.save();
  // Near-opaque: this is a read-this moment, and desktop content showing
  // through would compete for the attention the card is asking for.
  ctx.fillStyle = 'rgba(8, 10, 14, 0.97)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Scaled to the window rather than fixed, so it reads as "giant" on a laptop
  // panel and on a 32" display alike.
  const titleSize = Math.max(30, Math.min(76, Math.round(w / 22)));
  const maxWidth = w * 0.78;

  ctx.font = `700 ${titleSize}px -apple-system, system-ui, sans-serif`;
  const lines = wrap(c.title, maxWidth);
  const lineHeight = titleSize * 1.22;
  const blockTop = h / 2 - ((lines.length - 1) * lineHeight) / 2 - 20;

  ctx.fillStyle = c.headMotion ? 'rgba(255, 209, 102, 0.98)' : 'rgba(255, 255, 255, 0.97)';
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, blockTop + i * lineHeight);
  });

  const detailSize = Math.max(15, Math.round(titleSize * 0.34));
  ctx.font = `400 ${detailSize}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(215, 224, 234, 0.75)';
  const detailTop = blockTop + (lines.length - 1) * lineHeight + lineHeight * 0.85;
  wrap(c.detail, maxWidth).forEach((line, i) => {
    ctx.fillText(line, w / 2, detailTop + i * detailSize * 1.35);
  });

  // A countdown bar, so the pause reads as "starting shortly" rather than as a
  // hang. Without it a four-second wait on a blank screen looks like a freeze.
  const elapsed = performance.now() - phaseStartedAt;
  const t = c.instructionMs > 0 ? Math.min(1, elapsed / c.instructionMs) : 1;
  const barW = Math.min(360, w * 0.3);
  const barX = w / 2 - barW / 2;
  const barY = h / 2 + Math.max(120, titleSize * 2.2);

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(barX, barY, barW, 4);
  ctx.fillStyle = c.headMotion ? 'rgba(255, 209, 102, 0.9)' : 'rgba(88, 214, 141, 0.9)';
  ctx.fillRect(barX, barY, barW * t, 4);

  // Advertise the controls on the card itself. A skip nobody knows about is
  // not a skip, and this is the one screen where the user is definitely
  // reading.
  ctx.font = '13px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('Click or press Space to start now', w / 2, barY + 28);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('Esc to cancel calibration', w / 2, barY + 50);

  ctx.restore();
}

function drawCalibration(c: CalibrationUiState): void {
  if (!ctx) return;

  if (c.phase === 'instruct') {
    drawInstruction(c);
    return;
  }

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

  // Escape is live for the whole run, not just on the card, so it has to be
  // findable here too — this is where someone decides to give up.
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = '12px -apple-system, system-ui, sans-serif';
  ctx.fillText('Esc to cancel', window.innerWidth / 2, window.innerHeight - 22);
  ctx.restore();
}

/**
 * Validation targets, drawn deliberately unlike calibration targets.
 *
 * A dimmer backdrop and a square marker, because confusing the two would be
 * costly in both directions: fixating a validation dot casually gives a falsely
 * bad score, and treating a calibration dot as a test wastes the run.
 */
function drawValidation(v: ValidationUiState): void {
  if (!ctx) return;

  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 14, 0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const target = v.targets[v.currentIndex];
  if (target) {
    const [x, y] = toCanvas(target.x, target.y);
    const elapsed = performance.now() - validationPhaseAt;

    if (v.phase === 'collect') {
      // A closing square tells you the measurement is live and how long is
      // left — the window during which looking away corrupts the result.
      const t = Math.min(1, elapsed / VALIDATION_TIMING.collectMs);
      const r = 24 - 12 * t;
      ctx.strokeStyle = 'rgba(120, 170, 255, 0.95)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    } else {
      const t = Math.min(1, elapsed / VALIDATION_TIMING.settleMs);
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.3 * t})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 26, y - 26, 52, 52);
    }

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1117';
    ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(120, 170, 255, 0.95)';
  ctx.font = '600 17px -apple-system, system-ui, sans-serif';
  ctx.fillText('Measuring accuracy — look at the dot', window.innerWidth / 2, window.innerHeight - 72);

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '13px -apple-system, system-ui, sans-serif';
  ctx.fillText(
    `${Math.min(v.targets.length, v.currentIndex + 1)} of ${v.targets.length}`,
    window.innerWidth / 2,
    window.innerHeight - 46,
  );

  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = '12px -apple-system, system-ui, sans-serif';
  ctx.fillText('Esc to cancel', window.innerWidth / 2, window.innerHeight - 22);
  ctx.restore();
}

/** The fixed reference dot for the continuous probe (debug mode 4). */
function drawProbe(s: OverlayState): void {
  if (!ctx || !s.probeVisible) return;
  const [x, y] = toCanvas(s.probeX, s.probeY);

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 18, y);
  ctx.lineTo(x + 18, y);
  ctx.moveTo(x, y - 18);
  ctx.lineTo(x, y + 18);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
  ctx.fill();
  ctx.restore();
}

/**
 * The recording indicator (ADR-0022).
 *
 * Deliberately the only thing on this overlay that ignores `state.visible`, and
 * deliberately drawn last so nothing — not the calibration blackout, not an
 * instruction card — can cover it. The overlay is always-on-top, click-through
 * and present on every Space, which makes it the one surface in the app that is
 * guaranteed to be in front of the user while their face is being written to
 * disk. A banner in a window they have minimised is not an indicator.
 *
 * It pulses because a static red dot in a corner is something the eye stops
 * seeing within a minute, and this is exactly the fact that must not fade.
 */
function drawRecordingIndicator(): void {
  if (!ctx) return;

  const pad = 18;
  const w = 108;
  const h = 30;
  const x = window.innerWidth - w - pad;
  const y = pad;

  // ~0.7 Hz, never fully off: dimming to invisible would create moments where
  // the honest answer to "is it recording?" is not on screen.
  const pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(performance.now() / 700));

  ctx.save();
  ctx.fillStyle = 'rgba(20, 4, 8, 0.82)';
  ctx.strokeStyle = `rgba(255, 90, 90, ${pulse.toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 15);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x + 20, y + h / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 70, 70, ${pulse.toFixed(3)})`;
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 235, 235, 0.95)';
  ctx.fillText('RECORDING', x + 33, y + h / 2 + 1);
  ctx.restore();
}

function render(): void {
  requestAnimationFrame(render);
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (calibration?.active) {
    drawCalibration(calibration);
    if (state?.recording) drawRecordingIndicator();
    return;
  }
  if (validation?.active) {
    drawValidation(validation);
    if (state?.recording) drawRecordingIndicator();
    return;
  }
  // The probe sits under the crosshair: seeing both at once is the point —
  // the gap between them IS the reading.
  if (state) drawProbe(state);
  if (state?.visible) drawCrosshair(state);
  if (state?.recording) drawRecordingIndicator();
}

render();
