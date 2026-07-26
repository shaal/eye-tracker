/**
 * Control window: camera preview, debug overlay, HUD, calibration launcher and
 * live tuning. Plain DOM, no framework (ADR-0012).
 */

import {
  CLICK_MODE_LABELS,
  EYE_A,
  EYE_B,
  HEAD_MOTION_STEPS,
  poseDriftPerAxis,
  scatterAdvice,
  summarizeScatter,
  totalDurationMs,
  validationDurationMs,
  type AppStatus,
  type CalibrationProfile,
  type ClickMode,
  type CameraLockStatus,
  type GazeFeatures,
  type Landmark,
  type RecordedTarget,
  type TuningPatch,
  type ValidationReport,
} from '@eye-tracker/core';
import { VisionLoop, listCameras } from './vision.js';
import { drawDebugOverlay } from './debug-draw.js';
import { SessionRecorder, type RecorderUiState } from './recorder.js';
import { SLIDERS, buildSliders } from './tuning-ui.js';
import { SignalStats } from './debug/signal-stats.js';
import { drawEyeZoom, eyeZoomReadout } from './debug/eye-zoom.js';
import { Scope, type ScopeChannel } from './debug/scope.js';
import { drawValidationMap } from './debug/validation-view.js';
import { drawScatter } from './debug/scatter.js';
import { AccuracyProbe } from './debug/probe.js';

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

/**
 * Snapshot of just the landmarks the eye-zoom view draws.
 *
 * MediaPipe owns the array it hands to `onFrame` and may reuse it, but the draw
 * loop runs on its own animation-frame clock and reads whatever is stored here
 * — so holding the original risks rendering coordinates from a *later* frame
 * than the `GazeFeatures` drawn alongside them, which would show a landmark
 * overlay that disagrees with its own numbers.
 *
 * Only the ~26 indices the view actually uses are copied, into objects
 * allocated once, so the steady-state cost is 26 float writes per frame rather
 * than a 478-element clone.
 */
const ZOOM_INDICES: readonly number[] = [
  ...new Set([
    ...EYE_A.corners,
    EYE_A.irisCenter,
    ...EYE_A.irisRim,
    ...EYE_A.ear,
    ...EYE_B.corners,
    EYE_B.irisCenter,
    ...EYE_B.irisRim,
    ...EYE_B.ear,
  ]),
];

/** Sparse, indexed to match MediaPipe's numbering so the drawing code is unchanged. */
const landmarkSnapshot: Landmark[] = [];
for (const i of ZOOM_INDICES) landmarkSnapshot[i] = { x: 0, y: 0, z: 0 };

let latestLandmarks: readonly Landmark[] | null = null;

function snapshotLandmarks(source: readonly Landmark[] | null): readonly Landmark[] | null {
  if (!source) return null;
  for (const i of ZOOM_INDICES) {
    const src = source[i];
    const dst = landmarkSnapshot[i];
    if (!src || !dst) continue;
    dst.x = src.x;
    dst.y = src.y;
    dst.z = src.z;
  }
  return landmarkSnapshot;
}

/**
 * Newest packed frame, for probing the model's local gain.
 *
 * Unlike the landmarks above this is *deliberately* the live reused buffer.
 * The sensitivity probe runs on a one-second timer and wants the pose the user
 * is in right now, not the one they were in when the timer was armed; the
 * buffer is serialised at `invoke` time, so there is no tearing.
 */
let latestFrame: Float64Array | null = null;
let cameraFps = 0;
/** Smoothed inference time, kept so the diagnostics export can report it. */
let inferenceMs = 0;
let lastFrameAt = 0;
let controlEnabled = false;
let currentDelegate: 'GPU' | 'CPU' | 'none' = 'none';
let clickMode: ClickMode = 'blink';

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

interface Banner {
  id: string;
  /**
   * `recording` is its own level rather than a red `error`, because it is not a
   * fault: it is a statement about what the app is doing to the user right now
   * (ADR-0022). It gets its own treatment so it cannot be mistaken for one of
   * the transient warnings above it.
   */
  level: 'error' | 'warn' | 'info' | 'recording';
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
// Session recording (ADR-0022)
//
// Off at every launch, with no setting that could turn it back on by itself.
// While it runs there is a persistent banner here and a pulsing badge on the
// desktop-wide overlay, because the thing being written to disk is pictures of
// the user's face and no part of that may be ambiguous.
// ---------------------------------------------------------------------------

/**
 * The screen point the user is being asked to look at, or null while free
 * viewing.
 *
 * Only the `collect` phase counts. During `instruct` there is no dot at all and
 * during `settle` the eye is still travelling to it, so labelling those frames
 * with the target would put the wrong answer next to the right pixels — the one
 * kind of error a training set cannot recover from.
 */
let calibrationTarget: RecordedTarget | null = null;
let validationTarget: RecordedTarget | null = null;

function activeTarget(): RecordedTarget | null {
  return calibrationTarget ?? validationTarget;
}

const recToggle = $<HTMLButtonElement>('rec-toggle');
const recDelete = $<HTMLButtonElement>('rec-delete');
const recReveal = $<HTMLButtonElement>('rec-reveal');
const recCap = $<HTMLInputElement>('rec-cap');

const MB = 1_000_000;
const formatBytes = (bytes: number): string =>
  bytes >= 1_000 * MB ? `${(bytes / (1000 * MB)).toFixed(2)} GB` : `${(bytes / MB).toFixed(0)} MB`;

function renderRecordingState(s: RecorderUiState): void {
  recToggle.textContent = s.active ? 'Stop recording' : 'Start recording';
  recToggle.className = s.active ? 'btn btn-danger' : 'btn';
  recDelete.disabled = s.bytes === 0;

  text(
    's-rec-state',
    s.active ? `recording → ${s.sessionId ?? '?'}` : s.sessions > 0 ? 'off' : 'off, nothing recorded',
  );
  text('s-rec-size', `${formatBytes(s.bytes)} of ${formatBytes(s.capBytes)} · ${s.sessions} session(s)`);
  text('s-rec-frames', s.active || s.frames > 0 ? `${s.frames}` : '—');
  // Dropped frames are a health readout, not an error: the recorder is supposed
  // to drop rather than delay the tracker. A large and growing number means the
  // disk or the encoder cannot keep up, and the *data* is thinner than expected
  // — which is worth knowing before training on it.
  text(
    's-rec-dropped',
    s.droppedLocal + s.droppedDisk === 0
      ? '0'
      : `${s.droppedLocal} encoder · ${s.droppedDisk} disk`,
  );
  text('rec-message', s.message ?? '');

  if (s.active) {
    setBanner({
      id: 'recording',
      level: 'recording',
      message:
        `RECORDING — images of your face are being written to disk. ` +
        `${s.frames} frames, ${formatBytes(s.bytes)} of ${formatBytes(s.capBytes)}. Nothing is uploaded.`,
      action: { label: 'Stop', run: () => void recorder.stop() },
    });
  } else {
    clearBanner('recording');
  }
}

const recorder = new SessionRecorder(renderRecordingState);

recToggle.addEventListener('click', async () => {
  // Disabled across the round trip: starting twice would open two session
  // directories and orphan the first.
  recToggle.disabled = true;
  try {
    if (recorder.active) {
      await recorder.stop();
    } else {
      await recorder.start(video, {
        camera: cameraLock,
        cameraLabel: cameraSelect.selectedOptions[0]?.textContent ?? 'unknown camera',
        swapEyes: optSwapEyes.checked,
      });
    }
  } catch (err) {
    setBanner({
      id: 'rec-fail',
      level: 'error',
      message: `Recording could not start: ${(err as Error).message}`,
    });
  } finally {
    recToggle.disabled = false;
  }
});

recDelete.addEventListener('click', async () => {
  const removed = await window.eyeTracker.deleteAllRecordings();
  await recorder.refresh();
  setBanner({
    id: 'rec-deleted',
    level: 'info',
    message: `Deleted ${removed.sessions} recorded session(s), freeing ${formatBytes(removed.bytes)}.`,
  });
  setTimeout(() => clearBanner('rec-deleted'), 6000);
});

recReveal.addEventListener('click', () => void window.eyeTracker.revealRecordings());

recCap.addEventListener('change', async () => {
  const stats = await window.eyeTracker.setRecordingCap(Number(recCap.value) * 1000 * MB);
  recCap.value = (stats.capBytes / (1000 * MB)).toFixed(1);
  recorder.apply(stats);
});

// Main is the authority on whether a session is open — it is the side that
// stops when the cap is reached — so its pushes win over local state.
window.eyeTracker.onRecordingState((s) => recorder.apply(s));

// ---------------------------------------------------------------------------
// Vision loop
// ---------------------------------------------------------------------------

/**
 * Report what the camera settled on, not what was asked of it.
 *
 * Both halves are things you act on. The format says whether you are getting
 * the sensor's full resolution — iris localisation is sensor-limited, and the
 * error budget in `debug/eye-zoom.ts` is quoted per camera pixel. The exposure
 * mode says whether the auto-exposure lock took: a camera left on `continuous`
 * keeps re-metering to whatever is on screen, and that shows up as jitter no
 * amount of filter tuning will remove, because it is not zero-mean noise.
 */
/**
 * The last reported lock state, kept because a recorded session's manifest has
 * to say which one produced it — data taken with exposure hunting is not the
 * same data as data taken with it pinned (ADR-0022).
 */
let cameraLock: CameraLockStatus | null = null;

function showCameraLock(c: CameraLockStatus): void {
  cameraLock = c;
  text(
    's-camera-format',
    c.width > 0 ? `${c.width}×${c.height} @ ${c.frameRate.toFixed(0)} fps` : '—',
  );
  text(
    's-exposure',
    c.exposureMode === null
      ? 'not reported by this camera'
      : c.exposureMode === 'manual'
        ? `locked${c.exposureTimeMs === null ? '' : ` · ${c.exposureTimeMs.toFixed(1)} ms`}`
        : `${c.exposureMode} — this camera will not hold it`,
  );
}

const vision = new VisionLoop(video, {
  onFrame(frame, features, frameInferenceMs, landmarks, transform) {
    latestFeatures = features;
    inferenceMs = frameInferenceMs;
    // Copied, not retained: the array belongs to MediaPipe and the draw loop
    // reads it on a different clock (see `snapshotLandmarks`).
    latestLandmarks = snapshotLandmarks(landmarks);
    latestFrame = frame;

    // Feed the noise-floor estimate only when there is a real measurement to
    // feed it. Zeros from a lost face would read as a perfectly quiet signal
    // and make the tracker look far better than it is.
    //
    // The vertical value has to be the one the fit consumes (ADR-0025). "Is
    // there a usable signal at all?" is the first question the tuning playbook
    // sends people to, and answering it about a feature the model never sees
    // would be worse than not answering it.
    if (features.ok) {
      signalStats.push(
        features.gx,
        apertureVertical ? features.gyAperture : features.gy,
        features.dgx,
      );
    }

    const now = performance.now();
    if (lastFrameAt > 0) {
      const inst = 1000 / Math.max(1, now - lastFrameAt);
      cameraFps = cameraFps === 0 ? inst : cameraFps * 0.9 + inst * 0.1;
    }
    lastFrameAt = now;

    // Before `sendFrame`, so a recorded frame's `tMs` is the same instant that
    // the packed frame carries into the engine (ADR-0009) — that shared stamp
    // is what lets a recording be joined to anything the engine did with it.
    // Costs nothing while recording is off, which is the normal case: the first
    // line of `capture` is a boolean test.
    recorder.capture(video, features, transform, activeTarget(), now);

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
    if (patch.camera) showCameraLock(patch.camera);
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

const signalStats = new SignalStats();
const scope = new Scope();
const probe = new AccuracyProbe();

const debugPanel = $<HTMLDetailsElement>('debug-panel');
const eyeZoomCanvas = $<HTMLCanvasElement>('eye-zoom');
const scopeCanvas = $<HTMLCanvasElement>('scope');
const scatterCanvas = $<HTMLCanvasElement>('scatter');
const valMapCanvas = $<HTMLCanvasElement>('val-map');
const scopeChannel = $<HTMLSelectElement>('scope-channel');
const scopeWindow = $<HTMLSelectElement>('scope-window');

/**
 * Screen px per unit of iris offset. Refreshed on a slow timer rather than per
 * frame: it changes only with head pose, each probe is four IPC round trips,
 * and this figure is read by a human at reading speed.
 */
let sensitivity = { pxPerGx: Number.NaN, pxPerGy: Number.NaN };
let lastValidationReport: ValidationReport | null = null;
let calibrationProfile: CalibrationProfile | null = null;

/**
 * The signal summary for this animation frame.
 *
 * Recomputed once per frame and shared: it sorts a 300-entry history, and the
 * draw loop and the status handler both want it, on different clocks. Computing
 * it in each would sort well over a hundred times a second for a number a human
 * reads a few times a minute.
 */
let frameSummary = signalStats.summary();

function drawLoop(): void {
  requestAnimationFrame(drawLoop);
  if (!latestFeatures) return;
  drawDebugOverlay(debugCanvas, video, latestFeatures, { EYE_A, EYE_B });

  // Everything below is inside a collapsed <details> most of the time. Skipping
  // it while closed keeps the debug views from costing anything in normal use.
  if (!debugPanel.open) return;

  frameSummary = signalStats.summary();
  drawEyeZoom(eyeZoomCanvas, video, {
    features: latestFeatures,
    landmarks: latestLandmarks,
    summary: frameSummary,
    pxPerGx: sensitivity.pxPerGx,
    pxPerGy: sensitivity.pxPerGy,
  });

  scope.draw(scopeCanvas, scopeChannel.value as ScopeChannel, Number(scopeWindow.value));
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

  // The scope samples from the status stream rather than the vision loop,
  // because raw-vs-filtered is a property of the engine and only main has both.
  if (e.hasGaze) {
    scope.push({
      t: performance.now(),
      gx: latestFeatures?.gx ?? 0,
      gy: latestFeatures?.gy ?? 0,
      rawX: e.rawX,
      rawY: e.rawY,
      x: e.x,
      y: e.y,
      clamped: e.clamped,
      quality: e.quality,
    });
    probe.push(e.rawX, e.rawY);
  }

  if (debugPanel.open) updateDebugReadouts(e);

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
  const seconds = Math.round(
    totalDurationMs(points, optHeadMotion.checked ? HEAD_MOTION_STEPS.length : 0) / 1000,
  );
  calProgress.textContent = `Starting… about ${seconds}s`;
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
  // Label the recorder's frames, before any of the early returns below.
  const collecting = c.active && c.phase === 'collect' ? c.targets[c.currentIndex] : undefined;
  calibrationTarget = collecting
    ? {
        kind: 'calibration',
        x: collecting.x,
        y: collecting.y,
        index: c.currentIndex,
        headMotion: c.headMotion,
      }
    : null;

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
      // Samples are weighted by tracking quality, so "how many frames" is no
      // longer the whole story — a session of marginal frames is worth fewer
      // than it collected, and that is a different diagnosis for a mediocre
      // error than a bad fit (ADR-0021).
      const weights =
        report.qualityWeighted && report.meanWeight !== undefined
          ? `<div>Sample quality: mean ${report.meanWeight.toFixed(2)}, worst
              ${(report.minWeight ?? 0).toFixed(2)} — worth
              ${Math.round(report.effectiveSamples ?? report.samples)} of
              ${report.samples} frames</div>`
          : '';
      calReport.innerHTML = `
        <strong>Calibration ${quality}</strong>
        <div>Held-out error: <b>${report.meanErrorPx.toFixed(0)} px</b>
          (~${report.meanErrorDeg.toFixed(2)}°)</div>
        <div>95th percentile: ${report.p95ErrorPx.toFixed(0)} px</div>
        <div>Model: ${report.tierName}, ${report.samples} samples, ${report.targets} targets</div>
        ${weights}
        <div class="hint">${
          report.crossValidated
            ? 'Cross-validated — this is a genuine held-out estimate.'
            : 'NOT cross-validated (too few targets) — this number is optimistic.'
        }</div>
        ${
          report.meanErrorDeg >= 2.5
            ? '<div class="hint warn">Try again: sit squarely, keep the room evenly lit, and look directly at each dot.</div>'
            : ''
        }
        <div class="hint">Open <b>Debug &amp; diagnostics → Validation</b> to measure this at points
          the model was not fitted to — the number above only scores the dots you just looked at.</div>`;

      // Both the scatter and the pose baseline belong to the run that just
      // finished; the debug panel would otherwise show the previous one.
      if (debugPanel.open) {
        await refreshScatter();
        await refreshSlowDebug();
      }
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

  if (c.phase === 'instruct') {
    // Naming the card explicitly keeps the pause from reading as a stall — the
    // control window is often on a second display where the card is not visible.
    calProgress.textContent = `“${c.title}” — click or press Space to start now, Esc to cancel`;
    return;
  }

  const label = c.headMotion ? 'head motion' : c.phase;
  calProgress.textContent = `Point ${c.currentIndex + 1} of ${c.targets.length} — ${label} · Esc to cancel`;
});

// --- behaviour toggles ---
const optTakeover = $<HTMLInputElement>('opt-takeover');
const optConfidenceTrust = $<HTMLInputElement>('opt-confidence-trust');
const optApertureVertical = $<HTMLInputElement>('opt-aperture-vertical');
/**
 * Mirrors the engine's `apertureVertical`, so the signal diagnostic measures the
 * same vertical feature the fit does (ADR-0025). Set from the resolved engine
 * config, never guessed.
 */
let apertureVertical = true;
const optOpennessTerms = $<HTMLInputElement>('opt-openness-terms');
const optShowRaw = $<HTMLInputElement>('opt-show-raw');
const optOverlay = $<HTMLInputElement>('opt-overlay');

optTakeover.addEventListener('change', () => {
  void window.eyeTracker.setTuning({ takeover: { enabled: optTakeover.checked } });
});
// The A/B switch for ADR-0023. Off restores the pre-ADR-0023 pipeline exactly,
// so a suspected regression can be attributed without a rebuild (ADR-0004).
optConfidenceTrust.addEventListener('change', () => {
  void window.eyeTracker.setTuning({ filter: { confidenceTrust: optConfidenceTrust.checked } });
});
// The two A/B switches for ADR-0025. Both change what the calibration fit is
// fitted *on*, so neither does anything to the model already loaded — the label
// says so rather than leaving the user to wonder why nothing moved.
optApertureVertical.addEventListener('change', () => {
  apertureVertical = optApertureVertical.checked;
  // The noise floor and travel are measured over a rolling window, so keeping
  // the old samples would mix two different features into one statistic.
  signalStats.reset();
  void window.eyeTracker.setTuning({
    calibration: { apertureVertical: optApertureVertical.checked },
  });
});
optOpennessTerms.addEventListener('change', () => {
  void window.eyeTracker.setTuning({ calibration: { opennessTerms: optOpennessTerms.checked } });
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
// Debug panel
// ---------------------------------------------------------------------------

const zoomStats = $<HTMLDListElement>('zoom-stats');
const probeStats = $<HTMLDListElement>('probe-stats');
const poseAxes = $<HTMLDivElement>('pose-axes');

/** Render a `<dl class="stats">` from rows, colouring the value by verdict. */
function renderStats(
  into: HTMLElement,
  rows: ReadonlyArray<[string, string, 'good' | 'warn' | 'bad' | 'plain']>,
): void {
  into.replaceChildren();
  for (const [label, value, level] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (level !== 'plain') dd.className = level;
    into.append(dt, dd);
  }
}

function updateDebugReadouts(e: AppStatus['engine']): void {
  if (latestFeatures) {
    const readout = eyeZoomReadout({
      features: latestFeatures,
      landmarks: latestLandmarks,
      summary: frameSummary,
      pxPerGx: sensitivity.pxPerGx,
      pxPerGy: sensitivity.pxPerGy,
    });
    renderStats(zoomStats, readout.rows);
    text('zoom-verdict', readout.verdict);
  }

  const lag = scope.estimateLagMs();
  text(
    'scope-lag',
    Number.isFinite(lag)
      ? `Smoothing lag ≈ ${lag.toFixed(0)} ms${lag > 120 ? ' — high; lower minCutoff’s effect by raising beta, or reduce the median window' : ''}`
      : 'Smoothing lag: move your gaze around for a few seconds to measure it.',
  );

  updateProbeReadout();
  updatePoseAxes(e);
}

// --- 4 · live probe ---

const probeToggle = $<HTMLButtonElement>('probe-toggle');
const probeHere = $<HTMLButtonElement>('probe-here');

function updateProbeReadout(): void {
  if (!probe.targetPoint) {
    renderStats(probeStats, [['Probe', 'off', 'plain']]);
    return;
  }
  const r = probe.read();
  if (r.samples < 10) {
    renderStats(probeStats, [['Probe', `collecting… (${r.samples})`, 'plain']]);
    return;
  }

  // Only available once a validation run has told us the px-per-degree scale.
  const asDegrees = (px: number) =>
    lastValidationReport && lastValidationReport.pxPerDegree > 0
      ? ` (${(px / lastValidationReport.pxPerDegree).toFixed(2)}°)`
      : '';

  renderStats(probeStats, [
    [
      'Offset',
      `${r.accuracyPx.toFixed(0)} px${asDegrees(r.accuracyPx)} — ${r.direction}`,
      r.accuracyPx < 40 ? 'good' : r.accuracyPx < 100 ? 'warn' : 'bad',
    ],
    ['Components', `x ${r.offsetX.toFixed(0)}  y ${r.offsetY.toFixed(0)}`, 'plain'],
    [
      'Scatter',
      `±${r.precisionPx.toFixed(0)} px`,
      r.precisionPx < 30 ? 'good' : r.precisionPx < 70 ? 'warn' : 'bad',
    ],
  ]);
}

probeToggle.addEventListener('click', async () => {
  if (probe.targetPoint) {
    await window.eyeTracker.setProbePoint(null);
    probe.setTarget(null);
    probeToggle.textContent = 'Show probe dot';
    probeHere.hidden = true;
  } else {
    const at = await window.eyeTracker.setProbePoint();
    probe.setTarget(at);
    probeToggle.textContent = 'Hide probe dot';
    probeHere.hidden = false;
  }
  updateProbeReadout();
});

probeHere.addEventListener('click', async () => {
  // Re-parking resets the window: the old samples were taken against a
  // different reference point and averaging across the move would be wrong.
  const at = await window.eyeTracker.setProbePoint();
  probe.setTarget(at);
  updateProbeReadout();
});

// --- 6 · pose drift ---

function updatePoseAxes(e: AppStatus['engine']): void {
  if (!e.calibrated || !calibrationProfile || !latestFeatures) {
    poseAxes.replaceChildren();
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = e.calibrated
      ? 'Loading calibration…'
      : 'Calibrate first — drift is measured against the pose you calibrated in.';
    poseAxes.append(p);
    return;
  }

  const f = latestFeatures;
  const pose = [f.yaw, f.pitch, f.roll, f.hx, f.hy, f.hz];
  const drifts = poseDriftPerAxis(pose, calibrationProfile.poseMean, calibrationProfile.poseStd);

  poseAxes.replaceChildren();
  for (const d of drifts) {
    const row = document.createElement('div');
    row.className = 'pose-axis';

    const label = document.createElement('span');
    label.textContent = d.label;

    const bar = document.createElement('div');
    bar.className = 'pose-bar';
    const fill = document.createElement('div');
    // The bar tops out at 5σ, with the 3σ extrapolation mark drawn at 60%.
    fill.className = `pose-fill${d.sigma > 3 ? ' bad' : d.sigma > 2 ? ' warn' : ''}`;
    fill.style.width = `${Math.min(100, (d.sigma / 5) * 100)}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.className = 'value';
    const human =
      d.unit === 'deg'
        ? `${((d.delta * 180) / Math.PI).toFixed(0)}°`
        : d.unit === 'inv'
          ? `${d.delta > 0 ? 'nearer' : 'further'}`
          : `${(d.delta * 100).toFixed(0)}%`;
    value.textContent = `${d.sigma.toFixed(1)}σ ${human}`;

    row.append(label, bar, value);
    poseAxes.append(row);
  }
}

// --- 1 · eye zoom controls ---

$('zoom-reset').addEventListener('click', () => {
  signalStats.reset();
  scope.clear();
});

// --- 3 · validation ---

const valStart = $<HTMLButtonElement>('val-start');
const valCancel = $<HTMLButtonElement>('val-cancel');
const valProgress = $<HTMLDivElement>('val-progress');
const valReport = $<HTMLDivElement>('val-report');

valStart.addEventListener('click', async () => {
  valReport.hidden = true;
  valMapCanvas.hidden = true;
  // The exported summary describes the run that is about to be replaced.
  // Leaving it on screen next to a fresh result is how someone attaches the
  // previous run's file to a report about this one.
  diagResult.hidden = true;
  // Disabled before the round trip, not after: awaiting first leaves the button
  // live long enough for a double click to start two runs, and the second would
  // reset the sample buckets the first is still filling.
  valStart.disabled = true;

  const targets = await window.eyeTracker.startValidation();
  if (targets.length === 0) {
    valStart.disabled = false;
    setBanner({
      id: 'val-uncalibrated',
      level: 'warn',
      message: 'Calibrate before validating — there is no model to measure yet.',
    });
    return;
  }
  clearBanner('val-uncalibrated');
  valCancel.hidden = false;
  valProgress.hidden = false;
  valProgress.textContent = `Starting… about ${Math.round(validationDurationMs() / 1000)}s`;
});

valCancel.addEventListener('click', () => {
  void window.eyeTracker.cancelValidation();
  valStart.disabled = false;
  valCancel.hidden = true;
  valProgress.hidden = true;
});

window.eyeTracker.onValidationUi(async (v) => {
  const collecting = v.active && v.phase === 'collect' ? v.targets[v.currentIndex] : undefined;
  validationTarget = collecting
    ? {
        kind: 'validation',
        x: collecting.x,
        y: collecting.y,
        index: v.currentIndex,
        headMotion: false,
      }
    : null;

  if (!v.active && v.phase !== 'done') {
    valStart.disabled = false;
    valCancel.hidden = true;
    valProgress.hidden = true;
    return;
  }

  if (v.phase === 'done') {
    valProgress.textContent = 'Scoring…';
    try {
      const report = await window.eyeTracker.finishValidation();
      lastValidationReport = report;
      renderValidationReport(report);
    } catch (err) {
      setBanner({
        id: 'val-fail',
        level: 'error',
        message: `Validation failed: ${(err as Error).message}`,
      });
    } finally {
      valStart.disabled = false;
      valCancel.hidden = true;
      valProgress.hidden = true;
    }
    return;
  }

  valProgress.textContent = `Point ${v.currentIndex + 1} of ${v.targets.length} — ${v.phase}`;
});

function renderValidationReport(report: ValidationReport): void {
  valReport.hidden = false;
  valMapCanvas.hidden = false;

  const bounds = probeBounds ?? { x: 0, y: 0, width: 1920, height: 1080 };
  drawValidationMap(valMapCanvas, report, bounds);

  const worst = report.targets[report.worstIndex];
  // 'unknown' means the run could not be graded, which is not the same as being
  // graded badly — it gets no colour rather than the failure colour.
  const cls = (v: string) =>
    v === 'good' ? 'good' : v === 'usable' ? 'warn' : v === 'poor' ? 'bad' : '';
  const px = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '—');
  const dg = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

  // Accuracy and precision are shown side by side, never summed: the whole
  // point of the run is that they lead to different fixes.
  valReport.innerHTML = `
    <strong>Validated on ${report.targets.length} fresh points</strong>
    <div>Accuracy (systematic): <b class="${cls(report.accuracyVerdict)}">${px(report.meanAccuracyPx)} px</b>
      — ${dg(report.meanAccuracyDeg)}°, worst point ${px(report.p95AccuracyPx)} px</div>
    <div>Precision (random): <b class="${cls(report.precisionVerdict)}">±${px(report.meanPrecisionPx)} px</b>
      — ${dg(report.meanPrecisionDeg)}°</div>
    <div class="hint">After smoothing the cursor scatters ±${px(report.meanFilteredPrecisionPx)} px${
      Number.isFinite(report.meanFilteredPrecisionPx) && Number.isFinite(report.meanPrecisionPx)
        ? ` (${((1 - report.meanFilteredPrecisionPx / report.meanPrecisionPx) * 100).toFixed(0)}% of the jitter removed by the filter)`
        : ''
    }.</div>
    ${
      worst
        ? `<div class="hint">Worst point: ${px(worst.target.x)},${px(worst.target.y)} — off by ${px(worst.accuracyPx)} px.</div>`
        : ''
    }
    ${report.dropped > 0 ? `<div class="hint warn">${report.dropped} point(s) dropped for too few usable samples — tracking was lost there.</div>` : ''}
    <div class="hint">${report.advice}</div>`;
}

// --- 3b · diagnostics export (ADR-0024) ---
//
// Next to "Run validation" because that is where a user is standing when they
// decide the tracker is not good enough: the arrow map is the moment the numbers
// become a complaint, and this is the button that turns the complaint into
// something another person can act on.
//
// Everything it sends is a measurement. There is no path to add pixels here —
// see the preload comment and `diagnostics/bundle.ts`. Images belong to the
// recorder (ADR-0022), which is off by default and never leaves the machine;
// this is the mirror image and is meant to be shared.

const diagExport = $<HTMLButtonElement>('diag-export');
const diagReveal = $<HTMLButtonElement>('diag-reveal');
const diagClouds = $<HTMLInputElement>('diag-clouds');
const diagResult = $<HTMLDivElement>('diag-result');

diagExport.addEventListener('click', async () => {
  // Disabled across the round trip, like the validation button: a second click
  // would write a second near-identical file and leave the user unsure which of
  // the two paths on screen is the one they should attach.
  diagExport.disabled = true;
  diagExport.textContent = 'Copying…';
  try {
    const result = await window.eyeTracker.exportDiagnostics({
      camera: cameraLock,
      vision: {
        delegate: currentDelegate,
        inferenceMs,
        cameraFps,
        quality: latestFeatures?.quality ?? 0,
      },
      // Read fresh rather than reusing `frameSummary`, which only updates while
      // the panel is drawing. A bundle exported from a stalled draw loop would
      // otherwise carry a noise floor from some seconds ago.
      signal: {
        ...signalStats.summary(),
        pxPerGx: sensitivity.pxPerGx,
        pxPerGy: sensitivity.pxPerGy,
      },
      // Whatever the last run produced, or null. Null is a perfectly good
      // bundle — it just says so, and "never validated" is itself the finding
      // when someone reports an accuracy problem.
      validation: lastValidationReport,
      includeClouds: diagClouds.checked,
    });

    diagResult.hidden = false;
    diagResult.replaceChildren();

    const head = document.createElement('strong');
    head.textContent = result.copied
      ? `Summary copied to the clipboard · full bundle ${(result.bytes / 1024).toFixed(1)} KB`
      : `Bundle written (${(result.bytes / 1024).toFixed(1)} KB) — the clipboard could not be set, so copy it from the file`;
    diagResult.append(head);

    const where = document.createElement('div');
    where.className = 'hint';
    // textContent, not innerHTML: this is a filesystem path, and a home
    // directory is the one string here the app did not author.
    where.textContent = result.path;
    diagResult.append(where);

    // Show exactly what is on the clipboard. Someone about to paste into a
    // public issue should be able to read it first — a privacy promise the user
    // cannot check is not worth much.
    const pre = document.createElement('pre');
    pre.className = 'diag-summary';
    pre.textContent = result.summary;
    diagResult.append(pre);
  } catch (err) {
    setBanner({
      id: 'diag-fail',
      level: 'error',
      message: `Could not export diagnostics: ${(err as Error).message}`,
    });
  } finally {
    diagExport.disabled = false;
    diagExport.textContent = 'Copy diagnostics';
  }
});

diagReveal.addEventListener('click', () => void window.eyeTracker.revealDiagnostics());

// --- 5 · calibration scatter ---

const scatterStats = $<HTMLDListElement>('scatter-stats');
const scatterHeadMotion = $<HTMLInputElement>('scatter-head-motion');

async function refreshScatter(): Promise<void> {
  const { points, gridCount } = await window.eyeTracker.getCalibrationScatter();
  const s = summarizeScatter(points, gridCount);

  drawScatter(scatterCanvas, points, s, {
    showHeadMotion: scatterHeadMotion.checked,
    gridCount,
  });

  if (points.length === 0) {
    renderStats(scatterStats, [['Scatter', 'no calibration samples yet', 'plain']]);
    text('scatter-verdict', 'Run a calibration to populate this.');
    return;
  }

  const band = (v: number): 'good' | 'warn' | 'bad' | 'plain' =>
    !Number.isFinite(v) ? 'plain' : v >= 3 ? 'good' : v >= 1.5 ? 'warn' : 'bad';
  const num = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');

  // Per axis, because horizontal and vertical separability fail for different
  // reasons and imply different fixes.
  renderStats(scatterStats, [
    [
      'Horizontal (gx)',
      `${num(s.x.ratio)}× — gap ${num(s.x.separation, 3)} vs spread ${num(s.x.spread, 3)}`,
      band(s.x.ratio),
    ],
    [
      'Vertical (gy)',
      `${num(s.y.ratio)}× — gap ${num(s.y.separation, 3)} vs spread ${num(s.y.spread, 3)}`,
      band(s.y.ratio),
    ],
    [
      'Vertical vs horizontal',
      `gy range is ${
        Number.isFinite(s.y.range / s.x.range) ? ((s.y.range / s.x.range) * 100).toFixed(0) : '—'
      }% of gx range`,
      s.y.range / s.x.range < 0.4 ? 'warn' : 'plain',
    ],
    [
      'Grid order',
      s.x.monotonic && s.y.monotonic ? 'intact' : 'FOLDED — clusters out of order',
      s.x.monotonic && s.y.monotonic ? 'good' : 'bad',
    ],
    [
      'Clusters',
      `${s.gridClusters} fixation` +
        (s.headMotionClusters > 0 ? ` + ${s.headMotionClusters} head-motion (excluded)` : ''),
      'plain',
    ],
    [
      'Outliers rejected',
      `${s.rejected} of ${s.total} (${((s.rejected / Math.max(1, s.total)) * 100).toFixed(0)}%)`,
      s.rejected / Math.max(1, s.total) > 0.25 ? 'warn' : 'plain',
    ],
  ]);

  text('scatter-verdict', scatterAdvice(s));
}

$('scatter-refresh').addEventListener('click', () => void refreshScatter());
scatterHeadMotion.addEventListener('change', () => void refreshScatter());

/** Work-area bounds of the primary display, for drawing the error map to scale. */
let probeBounds: { x: number; y: number; width: number; height: number } | null = null;

/**
 * Refresh the slow-moving debug inputs.
 *
 * All three are read by a human at reading speed and cost an IPC round trip, so
 * polling them at frame rate would be pure waste.
 */
async function refreshSlowDebug(): Promise<void> {
  if (!debugPanel.open) return;
  if (latestFrame) {
    const s = await window.eyeTracker.getGazeSensitivity(latestFrame);
    if (s?.calibrated) sensitivity = { pxPerGx: s.pxPerGx, pxPerGy: s.pxPerGy };
  }
  calibrationProfile = await window.eyeTracker.getCalibrationProfile();
  probeBounds ??= await window.eyeTracker.getDisplayBounds();
}

setInterval(() => void refreshSlowDebug(), 1000);

debugPanel.addEventListener('toggle', () => {
  if (!debugPanel.open) return;
  void refreshSlowDebug();
  void refreshScatter();
});

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
    recordingCapBytes?: number;
  };
  optShowRaw.checked = settings.showRawGaze ?? false;
  optOverlay.checked = settings.overlayVisible ?? true;
  optHeadMotion.checked = settings.calibrationHeadMotion ?? true;
  optSwapEyes.checked = settings.swapEyes ?? false;

  // Only the cap is restored. There is no persisted "recording was on" flag to
  // restore, by design (ADR-0022) — this panel always comes up off.
  recCap.value = ((settings.recordingCapBytes ?? 2_000_000_000) / (1000 * MB)).toFixed(1);
  await recorder.refresh();

  applyMode(((tuning['mode'] as string) ?? 'blink') as ClickMode);
  optTakeover.checked = (tuning['takeoverEnabled'] as boolean) ?? true;
  optConfidenceTrust.checked = (tuning['confidenceTrust'] as boolean) ?? true;
  optApertureVertical.checked = (tuning['apertureVertical'] as boolean) ?? true;
  apertureVertical = optApertureVertical.checked;
  optOpennessTerms.checked = (tuning['opennessTerms'] as boolean) ?? false;

  await startVision(settings.cameraDeviceId ?? '', settings.swapEyes ?? false);
})();
