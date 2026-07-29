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
const resetStatsBtn = $<HTMLButtonElement>('reset-stats-btn');
const trackingToggle = $<HTMLDivElement>('tracking-toggle');
const trackEyeBtn = $<HTMLButtonElement>('track-eye');
const trackHeadBtn = $<HTMLButtonElement>('track-head');
const trackCombinedBtn = $<HTMLButtonElement>('track-combined');
const combinedLegend = $<HTMLParagraphElement>('combined-legend');
const markerEyeEl = $<HTMLDivElement>('marker-eye');
const markerHeadEl = $<HTMLDivElement>('marker-head');

renderZones(shelfEl, DEFAULT_ZONES);

const dwell = new DwellTracker(shelfEl, DEFAULT_ZONES);
const heatmap = new Heatmap(heatmapCanvas);
heatmap.start();

const vision = new VisionLoop(cameraVideo);
let visionStarted = false;
let latestFeatures: { features: GazeFeatures; tMs: number } | null = null;

let calibration: CalibrationResult | null = null;
let tracking: TrackingKind = 'eye';

// Independent smoothing per signal — both eye and head predictions run live
// at once in 'combined' mode, so they can't share one filter pair without one
// signal's gaps corrupting the other's velocity estimate.
const filterEyeX = new OneEuroFilter();
const filterEyeY = new OneEuroFilter();
const filterHeadX = new OneEuroFilter();
const filterHeadY = new OneEuroFilter();

// Starts as 'replay' so the boot call to switchMode('live') below is a real
// transition rather than a same-state no-op.
let mode: Mode = 'replay';
let replay: ReplayGenerator | null = null;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function trackingStatusSuffix(): string {
  if (!calibration?.headMotionTooSmall) return '';
  if (tracking === 'head') return ' (head barely moved during calibration — this will look like noise)';
  if (tracking === 'combined') return ' (head barely moved during calibration — its marker may look noisy)';
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

/** `x, y` in viewport coordinates, same space the heatmap/dwell tracker use. */
function placeMarker(el: HTMLDivElement, x: number, y: number): void {
  const paneRect = shelfPane.getBoundingClientRect();
  el.style.left = `${x - paneRect.x}px`;
  el.style.top = `${y - paneRect.y}px`;
}

async function startLive(): Promise<void> {
  calibrateBtn.disabled = false;
  if (visionStarted) {
    setStatus(calibration?.eye ? `Live — tracking${trackingStatusSuffix()}` : 'Live — calibrate to begin');
    return;
  }
  visionStarted = true;
  try {
    await vision.start(
      (features, tMs) => {
        latestFeatures = { features, tMs };
        if (mode !== 'live' || !calibration) return;

        const showEye = tracking === 'eye' || tracking === 'combined';
        const showHead = tracking === 'head' || tracking === 'combined';

        // The eye signal always drives dwell/heatmap/stats when it's shown —
        // in 'combined' mode the head marker is a visual comparison only, so
        // it never touches the numbers the sidebar reports.
        if (showEye && calibration.eye) {
          const raw = calibration.eye.predict([features.gx, features.gy]);
          const x = filterEyeX.filter(tMs, raw.x);
          const y = filterEyeY.filter(tMs, raw.y);
          dwell.update(x, y, tMs);
          heatmap.addPoint(x, y);
          if (tracking === 'combined') placeMarker(markerEyeEl, x, y);
        }
        if (showHead && calibration.head) {
          const raw = calibration.head.predict([features.hx, features.hy]);
          const x = filterHeadX.filter(tMs, raw.x);
          const y = filterHeadY.filter(tMs, raw.y);
          if (tracking === 'head') {
            dwell.update(x, y, tMs);
            heatmap.addPoint(x, y);
          } else {
            placeMarker(markerHeadEl, x, y);
          }
        }
      },
      (status) => {
        if (status.kind === 'loading') setStatus(status.message);
        else if (status.kind === 'ready') {
          setStatus(calibration?.eye ? `Live — tracking${trackingStatusSuffix()}` : 'Live — calibrate to begin');
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
  renderStats();

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
  filterEyeX.reset();
  filterEyeY.reset();
  filterHeadX.reset();
  filterHeadY.reset();
  dwell.reset();
  heatmap.clear();
  renderStats();

  trackEyeBtn.setAttribute('aria-pressed', String(next === 'eye'));
  trackHeadBtn.setAttribute('aria-pressed', String(next === 'head'));
  trackCombinedBtn.setAttribute('aria-pressed', String(next === 'combined'));

  markerEyeEl.hidden = next !== 'combined';
  markerHeadEl.hidden = next !== 'combined';
  combinedLegend.hidden = next !== 'combined';

  setStatus(`Live — tracking${trackingStatusSuffix()}`);
}

modeLiveBtn.addEventListener('click', () => switchMode('live'));
modeReplayBtn.addEventListener('click', () => switchMode('replay'));
trackEyeBtn.addEventListener('click', () => switchTracking('eye'));
trackHeadBtn.addEventListener('click', () => switchTracking('head'));
trackCombinedBtn.addEventListener('click', () => switchTracking('combined'));
resetStatsBtn.addEventListener('click', () => {
  dwell.reset();
  heatmap.clear();
  renderStats();
});

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
      // Combined is the interesting default — it's the whole comparison this
      // demo exists to show. Falls back to eye-only when there's no head
      // model to pair it with (rare: it only needs 4+ samples to exist at
      // all, `headMotionTooSmall` is a quality flag, not an availability one).
      tracking = result.head ? 'combined' : 'eye';
      trackEyeBtn.setAttribute('aria-pressed', String(tracking === 'eye'));
      // Never 'head' here — the ternary above only ever produces 'combined' or 'eye'.
      trackHeadBtn.setAttribute('aria-pressed', 'false');
      trackCombinedBtn.setAttribute('aria-pressed', String(tracking === 'combined'));
      // Combined needs both signals to show two markers — if head's fit
      // failed, only the eye-only and head-only(disabled) options make sense.
      trackHeadBtn.disabled = !result.head;
      trackCombinedBtn.disabled = !result.head;
      trackingToggle.hidden = false;
      markerEyeEl.hidden = tracking !== 'combined';
      markerHeadEl.hidden = tracking !== 'combined';
      combinedLegend.hidden = tracking !== 'combined';
      filterEyeX.reset();
      filterEyeY.reset();
      filterHeadX.reset();
      filterHeadY.reset();
      dwell.reset();
      heatmap.clear();
      renderStats();
      calibrateBtn.textContent = 'Recalibrate';
      setStatus(`Live — tracking${trackingStatusSuffix()}`);
    } else {
      setStatus('Calibration failed — try again with better lighting');
    }
  })();
});

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Called on its own interval AND immediately after every reset — a reset
 * that only took effect on the next 250ms tick left a stale, pre-reset list
 * on screen for up to a quarter second, which reads as "did that even work?"
 * particularly in replay mode, where the next data point can already refill
 * a small percentage within that same window.
 */
function renderStats(): void {
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
    const time = document.createElement('span');
    time.className = 'stat-time';
    time.textContent = s.ms > 0 ? formatDuration(s.ms) : '—';
    const pct = document.createElement('span');
    pct.className = 'stat-pct';
    pct.textContent = s.ms > 0 ? `${s.pct.toFixed(0)}%` : '';
    li.append(bar, label, time, pct);
    statsList.appendChild(li);
  }
}

setInterval(renderStats, 250);

calibrateBtn.hidden = false;
switchMode('live');
renderStats();
