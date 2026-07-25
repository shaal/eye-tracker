/**
 * Control window: camera preview, debug overlay, HUD, calibration launcher and
 * live tuning. Plain DOM, no framework (ADR-0012).
 */

import {
  CLICK_MODE_LABELS,
  EYE_A,
  EYE_B,
  type AppStatus,
  type ClickMode,
  type GazeFeatures,
  type TuningPatch,
} from '@eye-tracker/core';
import { VisionLoop, listCameras } from './vision.js';
import { drawDebugOverlay } from './debug-draw.js';
import { SLIDERS, buildSliders } from './tuning-ui.js';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const video = $<HTMLVideoElement>('video');
const debugCanvas = $<HTMLCanvasElement>('debug-canvas');
const banners = $<HTMLDivElement>('banners');
const guardPill = $<HTMLSpanElement>('guard-pill');
const toggleBtn = $<HTMLButtonElement>('toggle-control');

const text = (id: string, value: string) => {
  $(id).textContent = value;
};
const meter = (id: string, frac: number) => {
  $(id).style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
};

let latestFeatures: GazeFeatures | null = null;
let cameraFps = 0;
let lastFrameAt = 0;
let controlEnabled = false;
let currentDelegate: 'GPU' | 'CPU' | 'none' = 'none';
let clickMode: ClickMode = 'blink';

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

interface Banner {
  id: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  action?: { label: string; run: () => void };
}

const activeBanners = new Map<string, Banner>();

function renderBanners(): void {
  banners.replaceChildren();
  for (const b of activeBanners.values()) {
    const div = document.createElement('div');
    div.className = `banner banner-${b.level}`;
    const span = document.createElement('span');
    span.textContent = b.message;
    div.append(span);
    if (b.action) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = b.action.label;
      btn.addEventListener('click', b.action.run);
      div.append(btn);
    }
    banners.append(div);
  }
}

function setBanner(b: Banner): void {
  activeBanners.set(b.id, b);
  renderBanners();
}

function clearBanner(id: string): void {
  if (activeBanners.delete(id)) renderBanners();
}

// ---------------------------------------------------------------------------
// Vision loop
// ---------------------------------------------------------------------------

const vision = new VisionLoop(video, {
  onFrame(frame, features, inferenceMs) {
    latestFeatures = features;

    const now = performance.now();
    if (lastFrameAt > 0) {
      const inst = 1000 / Math.max(1, now - lastFrameAt);
      cameraFps = cameraFps === 0 ? inst : cameraFps * 0.9 + inst * 0.1;
    }
    lastFrameAt = now;

    window.eyeTracker.sendFrame(frame);
    window.eyeTracker.reportVision({
      cameraReady: true,
      modelReady: true,
      delegate: currentDelegate,
      inferenceMs,
      cameraFps,
      faceVisible: features.ok,
      quality: features.quality,
      interocular: features.interocular,
    });
  },
  onStatus(patch) {
    if (patch.delegate) currentDelegate = patch.delegate;
    if (patch.message) text('vision-message', patch.message);
    if (patch.delegate === 'CPU') {
      setBanner({
        id: 'cpu',
        level: 'warn',
        message:
          'Running the face model on CPU — the GPU delegate failed to initialise. Expect a lower frame rate.',
      });
    }
  },
});

async function startVision(deviceId: string, swapEyes: boolean): Promise<void> {
  const camera = await window.eyeTracker.requestCamera();
  if (camera !== 'granted') {
    setBanner({
      id: 'camera',
      level: 'error',
      message: 'Camera access was denied. Grant it in System Settings → Privacy & Security → Camera.',
    });
    return;
  }
  clearBanner('camera');

  vision.setOptions({ deviceId, swapEyes });
  try {
    await vision.start();
    await populateCameras(deviceId);
  } catch (err) {
    setBanner({
      id: 'vision',
      level: 'error',
      message: `Could not start the vision pipeline: ${(err as Error).message}`,
    });
  }
}

const cameraSelect = $<HTMLSelectElement>('camera-select');

async function populateCameras(selected: string): Promise<void> {
  // Labels are only populated once permission has been granted, so this has to
  // run after the stream is open.
  const cams = await listCameras();
  cameraSelect.replaceChildren();
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  cameraSelect.append(def);
  for (const c of cams) {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label;
    cameraSelect.append(opt);
  }
  cameraSelect.value = selected;
}

cameraSelect.addEventListener('change', async () => {
  const deviceId = cameraSelect.value;
  await window.eyeTracker.setSettings({ cameraDeviceId: deviceId });
  try {
    await vision.switchCamera(deviceId);
    setBanner({
      id: 'camera-changed',
      level: 'info',
      message: 'Camera changed — recalibrate, the previous calibration no longer applies.',
    });
  } catch (err) {
    setBanner({
      id: 'camera-changed',
      level: 'error',
      message: `Could not open that camera: ${(err as Error).message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Debug draw loop — decoupled from the vision loop so a slow paint cannot
// throttle inference.
// ---------------------------------------------------------------------------

function drawLoop(): void {
  requestAnimationFrame(drawLoop);
  if (!latestFeatures) return;
  drawDebugOverlay(debugCanvas, video, latestFeatures, { EYE_A, EYE_B });
}
drawLoop();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const GUARD_OK = 0;
const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);

window.eyeTracker.onStatus((s: AppStatus) => {
  const e = s.engine;
  controlEnabled = e.controlEnabled;

  guardPill.textContent = e.controlEnabled && e.guard === GUARD_OK
    ? 'controlling cursor'
    : e.guardReason;
  guardPill.className = `pill ${
    e.manualOverride ? 'pill-warn' : e.controlEnabled && e.guard === GUARD_OK ? 'pill-on' : 'pill-off'
  }`;

  toggleBtn.textContent = e.controlEnabled ? 'Disable control' : 'Enable control';
  toggleBtn.disabled = !s.permissions.accessibility || !e.calibrated || e.calibrating;

  text('s-guard', e.guardReason);
  text('s-fps', `${s.vision.cameraFps.toFixed(1)} (engine ${e.fps.toFixed(1)})`);
  text('s-inference', `${s.vision.inferenceMs.toFixed(1)} ms`);
  text('s-delegate', s.vision.delegate);
  text('s-quality', s.vision.quality.toFixed(2));
  text('s-cursor', e.hasGaze ? `${e.x.toFixed(0)}, ${e.y.toFixed(0)}` : '—');
  text('s-clamp', e.clamped ? 'held' : e.saccade ? 'saccade' : 'tracking');
  text('s-spread', e.gazeSpread > 0 ? `${e.gazeSpread.toFixed(1)} px` : '—');
  text('s-clamp-radius', e.clampRadius > 0 ? `${e.clampRadius.toFixed(0)} px` : '—');

  // Pose drift is the answer to "it worked a moment ago" — above ~3 the model
  // is extrapolating beyond where it was calibrated (ADR-0015).
  const drift = e.poseDrift;
  text('s-drift', e.calibrated ? `${drift.toFixed(1)} σ${drift > 3 ? '  ⚠ far from calibration pose' : ''}` : '—');

  meter('m-left', e.closureLeft);
  meter('m-right', e.closureRight);
  meter('m-quality', s.vision.quality);

  updateWinkLamps(e.closureLeft, e.closureRight);

  if (latestFeatures) {
    const f = latestFeatures;
    text('s-gaze', `${f.gx.toFixed(3)}, ${f.gy.toFixed(3)}`);
    text('s-head', `${deg(f.yaw)}° / ${deg(f.pitch)}° / ${deg(f.roll)}°`);
  }

  if (e.calibrated && !e.headCompensated) {
    setBanner({
      id: 'no-head-comp',
      level: 'info',
      message:
        'This calibration has no head compensation — your head barely moved while calibrating, so turning it will reduce accuracy. Recalibrate with the head-motion phase enabled to fix that.',
    });
  } else {
    clearBanner('no-head-comp');
  }

  if (!s.permissions.accessibility) {
    setBanner({
      id: 'accessibility',
      level: 'error',
      message:
        'Accessibility permission is required to move the cursor. Without it macOS silently ignores synthetic input.',
      action: {
        label: 'Open Settings',
        run: () => {
          void window.eyeTracker.checkAccessibility(true);
          void window.eyeTracker.openAccessibilitySettings();
        },
      },
    });
  } else {
    clearBanner('accessibility');
  }

  if (!s.shortcutRegistered) {
    setBanner({
      id: 'shortcut',
      level: 'warn',
      message: `The kill-switch shortcut (${s.shortcut}) could not be registered — another app may be using it. Control stays disabled until there is a way to turn it off without the pointer.`,
    });
  } else {
    clearBanner('shortcut');
  }

  if (e.error) {
    setBanner({ id: 'engine-error', level: 'warn', message: `Engine: ${e.error}` });
  }
});

window.eyeTracker.onNotice((n) => {
  setBanner({ id: `notice-${n.level}`, level: n.level as Banner['level'], message: n.message });
  setTimeout(() => clearBanner(`notice-${n.level}`), 6000);
});

// ---------------------------------------------------------------------------
// Gesture mode
// ---------------------------------------------------------------------------

const modeSelect = $<HTMLSelectElement>('mode-select');
const winkTest = $<HTMLDivElement>('wink-test');
const lampLeft = $<HTMLDivElement>('lamp-left');
const lampRight = $<HTMLDivElement>('lamp-right');
const optSwapEyes = $<HTMLInputElement>('opt-swap-eyes');

let updateSliderVisibility: (mode: ClickMode) => void = () => {};

function applyMode(mode: ClickMode): void {
  clickMode = mode;
  modeSelect.value = mode;
  text('mode-hint', CLICK_MODE_LABELS[mode]);
  winkTest.hidden = mode !== 'wink';
  updateSliderVisibility(mode);
}

function updateWinkLamps(left: number, right: number): void {
  if (clickMode !== 'wink') return;
  // Light the lamp when that eye is closed *and* the other is clearly open —
  // the same asymmetry test the detector uses, so what you see matches what
  // will actually fire.
  const CLOSED = 0.55;
  const OPEN = 0.35;
  lampLeft.classList.toggle('lit', left > CLOSED && right < OPEN);
  lampRight.classList.toggle('lit', right > CLOSED && left < OPEN);
}

modeSelect.addEventListener('change', () => {
  const mode = modeSelect.value as ClickMode;
  applyMode(mode);
  void window.eyeTracker.setTuning({ blink: { mode } });
});

optSwapEyes.addEventListener('change', () => {
  vision.setOptions({ swapEyes: optSwapEyes.checked });
  void window.eyeTracker.setSettings({ swapEyes: optSwapEyes.checked });
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

toggleBtn.addEventListener('click', async () => {
  const ok = await window.eyeTracker.setControlEnabled(!controlEnabled);
  if (!ok && !controlEnabled) {
    setBanner({
      id: 'enable-refused',
      level: 'warn',
      message: 'Control could not be enabled — calibrate first and grant Accessibility permission.',
    });
  }
});

const calCancel = $<HTMLButtonElement>('cal-cancel');
const calProgress = $<HTMLDivElement>('cal-progress');
const calReport = $<HTMLDivElement>('cal-report');
const optHeadMotion = $<HTMLInputElement>('opt-head-motion');

async function runCalibration(points: 5 | 9): Promise<void> {
  calReport.hidden = true;
  calCancel.hidden = false;
  calProgress.hidden = false;
  calProgress.textContent = 'Starting…';
  await window.eyeTracker.startCalibration(points, optHeadMotion.checked);
}

$('cal-9').addEventListener('click', () => void runCalibration(9));
$('cal-5').addEventListener('click', () => void runCalibration(5));
calCancel.addEventListener('click', () => {
  void window.eyeTracker.cancelCalibration();
  calCancel.hidden = true;
  calProgress.hidden = true;
});

window.eyeTracker.onCalibrationUi(async (c) => {
  if (!c.active && c.phase !== 'done') {
    calCancel.hidden = true;
    calProgress.hidden = true;
    return;
  }

  if (c.phase === 'done') {
    calProgress.textContent = 'Fitting model…';
    try {
      const report = await window.eyeTracker.finishCalibration();
      calCancel.hidden = true;
      calProgress.hidden = true;
      calReport.hidden = false;

      const quality =
        report.meanErrorDeg < 1.5 ? 'good' : report.meanErrorDeg < 2.5 ? 'usable' : 'poor';
      calReport.innerHTML = `
        <strong>Calibration ${quality}</strong>
        <div>Held-out error: <b>${report.meanErrorPx.toFixed(0)} px</b>
          (~${report.meanErrorDeg.toFixed(2)}°)</div>
        <div>95th percentile: ${report.p95ErrorPx.toFixed(0)} px</div>
        <div>Model: ${report.tierName}, ${report.samples} samples, ${report.targets} targets</div>
        <div class="hint">${
          report.crossValidated
            ? 'Cross-validated — this is a genuine held-out estimate.'
            : 'NOT cross-validated (too few targets) — this number is optimistic.'
        }</div>
        ${
          report.meanErrorDeg >= 2.5
            ? '<div class="hint warn">Try again: sit squarely, keep the room evenly lit, and look directly at each dot.</div>'
            : ''
        }`;
    } catch (err) {
      calProgress.hidden = true;
      setBanner({
        id: 'cal-fail',
        level: 'error',
        message: `Calibration failed: ${(err as Error).message}`,
      });
    }
    return;
  }

  const label = c.headMotion ? 'head motion' : c.phase;
  calProgress.textContent = `Point ${c.currentIndex + 1} of ${c.targets.length} — ${label}`;
});

// --- behaviour toggles ---
const optTakeover = $<HTMLInputElement>('opt-takeover');
const optShowRaw = $<HTMLInputElement>('opt-show-raw');
const optOverlay = $<HTMLInputElement>('opt-overlay');

optTakeover.addEventListener('change', () => {
  void window.eyeTracker.setTuning({ takeover: { enabled: optTakeover.checked } });
});
optShowRaw.addEventListener('change', () => {
  void window.eyeTracker.setSettings({ showRawGaze: optShowRaw.checked });
});
optOverlay.addEventListener('change', () => {
  void window.eyeTracker.setSettings({ overlayVisible: optOverlay.checked });
});

$('dbg-click').addEventListener('click', () => void window.eyeTracker.debugClick(1));
$('dbg-dblclick').addEventListener('click', () => void window.eyeTracker.debugClick(2));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  // Fetch the live config first: the sliders must show what the engine is
  // actually running, not the hardcoded defaults.
  const tuning = await window.eyeTracker.getTuning();

  updateSliderVisibility = buildSliders(
    $<HTMLDivElement>('sliders'),
    SLIDERS,
    (patch: TuningPatch) => {
      void window.eyeTracker.setTuning(patch);
    },
    tuning,
  );

  const settings = (await window.eyeTracker.getSettings()) as {
    showRawGaze?: boolean;
    overlayVisible?: boolean;
    calibrationHeadMotion?: boolean;
    swapEyes?: boolean;
    cameraDeviceId?: string;
  };
  optShowRaw.checked = settings.showRawGaze ?? false;
  optOverlay.checked = settings.overlayVisible ?? true;
  optHeadMotion.checked = settings.calibrationHeadMotion ?? true;
  optSwapEyes.checked = settings.swapEyes ?? false;

  applyMode(((tuning['mode'] as string) ?? 'blink') as ClickMode);
  optTakeover.checked = (tuning['takeoverEnabled'] as boolean) ?? true;

  await startVision(settings.cameraDeviceId ?? '', settings.swapEyes ?? false);
})();
