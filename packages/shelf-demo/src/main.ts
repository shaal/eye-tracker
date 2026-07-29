import type { GazeFeatures } from '@eye-tracker/core';
import { runCalibration } from './calibration-ui.js';
import { OneEuroFilter, type CalibrationResult, type GazeModel } from './gaze-model.js';
import { ReplayGenerator } from './replay.js';
import { DEFAULT_ZONES, DwellTracker, Heatmap, renderZones } from './shelf.js';
import { VisionLoop } from './vision.js';

type Mode = 'live' | 'replay';
type TrackingKind = 'eye' | 'head' | 'combined';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const shelfPane = document.querySelector('.shelf-pane') as HTMLElement;
const shelfEl = $<HTMLDivElement>('shelf');
const heatmapCanvas = $<HTMLCanvasElement>('heatmap');
const calibrationOverlay = $<HTMLDivElement>('calibration-overlay');
const statusLine = $<HTMLParagraphElement>('status-line');
const calibrateBtn = $<HTMLButtonElement>('calibrate-btn');
const modeLiveBtn = $<HTMLButtonElement>('mode-live');
const modeReplayBtn = $<HTMLButtonElement>('mode-replay');
const cameraVideo = $<HTMLVideoElement>('camera');
const statsList = $<HTMLOListElement>('stats-list');
const trackingToggle = $<HTMLDivElement>('tracking-toggle');
const trackEyeBtn = $<HTMLButtonElement>('track-eye');
const trackHeadBtn = $<HTMLButtonElement>('track-head');
const trackCombinedBtn = $<HTMLButtonElement>('track-combined');

renderZones(shelfEl, DEFAULT_ZONES);

const dwell = new DwellTracker(shelfEl, DEFAULT_ZONES);
const heatmap = new Heatmap(heatmapCanvas);
heatmap.start();

const vision = new VisionLoop(cameraVideo);
let visionStarted = false;
let latestFeatures: { features: GazeFeatures; tMs: number } | null = null;

let calibration: CalibrationResult | null = null;
let tracking: TrackingKind = 'eye';
const filterX = new OneEuroFilter();
const filterY = new OneEuroFilter();

// Starts as 'replay' so the boot call to switchMode('live') below is a real
// transition rather than a same-state no-op.
let mode: Mode = 'replay';
let replay: ReplayGenerator | null = null;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function activeModel(): GazeModel | null {
  if (!calibration) return null;
  return calibration[tracking];
}

function featuresFor(kind: TrackingKind, f: GazeFeatures): readonly number[] {
  if (kind === 'eye') return [f.gx, f.gy];
  if (kind === 'head') return [f.hx, f.hy];
  return [f.gx, f.gy, f.hx, f.hy];
}

function trackingStatusSuffix(): string {
  if (!calibration || !calibration.headMotionTooSmall) return '';
  if (tracking === 'head') return ' (head barely moved during calibration — this will look like noise)';
  if (tracking === 'combined') return ' (little head motion in calibration — mostly riding on eyes)';
  return '';
}

function resize(): void {
  const box = shelfEl.getBoundingClientRect();
  heatmap.resize(box.width, box.height);
  dwell.recomputeRects();
}

new ResizeObserver(resize).observe(shelfPane);
window.addEventListener('resize', resize);
resize();

async function startLive(): Promise<void> {
  calibrateBtn.disabled = false;
  if (visionStarted) {
    setStatus(activeModel() ? `Live — tracking${trackingStatusSuffix()}` : 'Live — calibrate to begin');
    return;
  }
  visionStarted = true;
  try {
    await vision.start(
      (features, tMs) => {
        latestFeatures = { features, tMs };
        const active = activeModel();
        if (mode !== 'live' || !active) return;
        const raw = active.predict(featuresFor(tracking, features));
        const x = filterX.filter(tMs, raw.x);
        const y = filterY.filter(tMs, raw.y);
        dwell.update(x, y, tMs);
        heatmap.addPoint(x, y);
      },
      (status) => {
        if (status.kind === 'loading') setStatus(status.message);
        else if (status.kind === 'ready') {
          setStatus(activeModel() ? `Live — tracking${trackingStatusSuffix()}` : 'Live — calibrate to begin');
        } else if (status.kind === 'error') setStatus(`Camera unavailable: ${status.message}`);
      },
    );
  } catch {
    visionStarted = false;
    calibrateBtn.disabled = true;
  }
}

function stopLive(): void {
  vision.stop();
  visionStarted = false;
  latestFeatures = null;
}

function startReplay(): void {
  replay = new ReplayGenerator(DEFAULT_ZONES, () => shelfEl.getBoundingClientRect());
  replay.start((x, y, tMs) => {
    if (mode !== 'replay') return;
    dwell.update(x, y, tMs);
    heatmap.addPoint(x, y);
  });
  setStatus('Replay — simulated shopper');
}

function stopReplay(): void {
  replay?.stop();
  replay = null;
}

function switchMode(next: Mode): void {
  if (mode === next) return;
  mode = next;
  dwell.reset();
  heatmap.clear();

  modeLiveBtn.setAttribute('aria-pressed', String(next === 'live'));
  modeReplayBtn.setAttribute('aria-pressed', String(next === 'replay'));
  calibrateBtn.hidden = next !== 'live';
  trackingToggle.hidden = next !== 'live' || !calibration;

  if (next === 'live') {
    stopReplay();
    void startLive();
  } else {
    stopLive();
    startReplay();
  }
}

function switchTracking(next: TrackingKind): void {
  if (tracking === next) return;
  tracking = next;
  filterX.reset();
  filterY.reset();
  dwell.reset();
  heatmap.clear();
  trackEyeBtn.setAttribute('aria-pressed', String(next === 'eye'));
  trackHeadBtn.setAttribute('aria-pressed', String(next === 'head'));
  trackCombinedBtn.setAttribute('aria-pressed', String(next === 'combined'));
  setStatus(`Live — tracking${trackingStatusSuffix()}`);
}

modeLiveBtn.addEventListener('click', () => switchMode('live'));
modeReplayBtn.addEventListener('click', () => switchMode('replay'));
trackEyeBtn.addEventListener('click', () => switchTracking('eye'));
trackHeadBtn.addEventListener('click', () => switchTracking('head'));
trackCombinedBtn.addEventListener('click', () => switchTracking('combined'));

calibrateBtn.addEventListener('click', () => {
  void (async () => {
    calibrateBtn.disabled = true;
    trackingToggle.hidden = true;
    const rect = shelfEl.getBoundingClientRect();
    const result = await runCalibration(
      calibrationOverlay,
      rect,
      () => latestFeatures,
      (i, total) => setStatus(`Calibrating… point ${i + 1} of ${total}`),
    );
    calibrateBtn.disabled = false;
    if (result?.eye) {
      calibration = result;
      tracking = 'eye';
      trackEyeBtn.setAttribute('aria-pressed', 'true');
      trackHeadBtn.setAttribute('aria-pressed', 'false');
      trackCombinedBtn.setAttribute('aria-pressed', 'false');
      trackHeadBtn.disabled = !result.head;
      trackCombinedBtn.disabled = !result.combined;
      trackingToggle.hidden = false;
      filterX.reset();
      filterY.reset();
      calibrateBtn.textContent = 'Recalibrate';
      setStatus('Live — tracking');
    } else {
      setStatus('Calibration failed — try again with better lighting');
    }
  })();
});

setInterval(() => {
  const stats = dwell.stats();
  statsList.innerHTML = '';
  for (const s of stats) {
    const li = document.createElement('li');
    li.className = 'stat-row';
    const bar = document.createElement('div');
    bar.className = 'stat-bar';
    bar.style.width = `${Math.max(s.pct, 0)}%`;
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = s.label;
    const pct = document.createElement('span');
    pct.className = 'stat-pct';
    pct.textContent = s.ms > 0 ? `${s.pct.toFixed(0)}%` : '—';
    li.append(bar, label, pct);
    statsList.appendChild(li);
  }
}, 250);

calibrateBtn.hidden = false;
switchMode('live');
