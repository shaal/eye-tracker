import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, systemPreferences } from 'electron';
import type {
  AppStatus,
  EngineFrameState,
  Point,
  TuningPatch,
  VisionStatus,
} from '@eye-tracker/core';
import native from '@eye-tracker/native';

import { EngineBridge, type CalibrationUi } from './engine-bridge.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { createControlWindow, createOverlayWindow, resizeOverlay } from './windows.js';

/** HUD text gains nothing from 60 Hz updates; the crosshair needs every frame. */
const HUD_INTERVAL_MS = 50;

let controlWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let bridge: EngineBridge | null = null;
let settings: Settings = loadSettings();
let shortcutRegistered = false;
let lastHudAt = 0;
let clickPulseUntil = 0;

let vision: VisionStatus = {
  cameraReady: false,
  modelReady: false,
  delegate: 'none',
  inferenceMs: 0,
  cameraFps: 0,
  faceVisible: false,
  quality: 0,
  interocular: 0,
};

// Single instance: two copies fighting over the cursor would be unrecoverable.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const IDLE_ENGINE_STATE: EngineFrameState = {
  hasGaze: false,
  x: 0,
  y: 0,
  rawX: 0,
  rawY: 0,
  moved: false,
  click: 0,
  clickButton: 0,
  clickX: 0,
  clickY: 0,
  blinkPhase: 0,
  closure: 0,
  closureLeft: 0,
  closureRight: 0,
  poseDrift: 0,
  headCompensated: false,
  clampRadius: 0,
  gazeSpread: 0,
  manualOverride: false,
  guard: 1,
  guardReason: 'starting up',
  controlEnabled: false,
  calibrated: false,
  clamped: false,
  saccade: false,
  fps: 0,
  stale: false,
  calibrating: false,
  calibrationSamples: 0,
};

function buildStatus(): AppStatus {
  return {
    engine: bridge?.state ?? IDLE_ENGINE_STATE,
    vision,
    permissions: {
      camera: systemPreferences.getMediaAccessStatus('camera') as AppStatus['permissions']['camera'],
      accessibility: native.checkAccessibilityPermission(false),
    },
    shortcut: settings.shortcut,
    shortcutRegistered,
    displayFingerprint: bridge?.displayFingerprint ?? '',
    calibrationStale: !(bridge?.calibrated ?? false),
  };
}

function registerShortcut(): void {
  globalShortcut.unregisterAll();
  shortcutRegistered = false;
  try {
    shortcutRegistered = globalShortcut.register(settings.shortcut, () => {
      const next = !(bridge?.controlEnabled ?? false);
      const ok = bridge?.setControlEnabled(next) ?? false;
      if (!ok && next) {
        // Surface *why* it refused rather than silently doing nothing.
        send(controlWindow, 'app:notice', {
          level: 'warn',
          message: !native.checkAccessibilityPermission(false)
            ? 'Accessibility permission is required before control can be enabled.'
            : 'Calibrate before enabling control.',
        });
      }
      pushStatus(true);
    });
  } catch (err) {
    console.error('[shortcut] registration threw:', err);
  }

  if (!shortcutRegistered) {
    // Fail closed: without a pointer-free kill switch we do not enable control
    // (ADR-0011).
    console.error(
      `[shortcut] could not register "${settings.shortcut}" — control starts disabled`,
    );
    bridge?.setControlEnabled(false);
  }
}

function pushStatus(force = false): void {
  const now = Date.now();
  if (!force && now - lastHudAt < HUD_INTERVAL_MS) return;
  lastHudAt = now;
  send(controlWindow, 'hud:state', buildStatus());
}

function pushOverlay(): void {
  const s = bridge?.state;
  if (!s) return;
  send(overlayWindow, 'overlay:state', {
    visible: settings.overlayVisible,
    x: s.x,
    y: s.y,
    rawX: s.rawX,
    rawY: s.rawY,
    showRaw: settings.showRawGaze,
    hasGaze: s.hasGaze,
    controlEnabled: s.controlEnabled,
    blinkPhase: s.blinkPhase,
    clamped: s.clamped,
    clickPulse: Date.now() < clickPulseUntil ? 1 : 0,
    guardReason: s.guardReason,
  });
}

function wireIpc(): void {
  // --- streaming: one-way, never a round trip (ADR-0009) ---
  ipcMain.on('gaze:frame', (_e, payload: Float64Array | ArrayBufferLike) => {
    const frame =
      payload instanceof Float64Array ? payload : new Float64Array(payload as ArrayBufferLike);
    const state = bridge?.pushFrame(frame);
    if (!state) return;
    if (state.click !== 0) clickPulseUntil = Date.now() + 220;
    pushOverlay();
    pushStatus();
  });

  ipcMain.on('vision:status', (_e, s: VisionStatus) => {
    vision = s;
    pushStatus();
  });

  // --- commands: request/response ---
  ipcMain.handle('app:status', () => buildStatus());

  ipcMain.handle('control:set', (_e, on: boolean) => {
    const ok = bridge?.setControlEnabled(on) ?? false;
    pushStatus(true);
    return ok;
  });

  ipcMain.handle('permissions:camera', async () => {
    if (process.platform !== 'darwin') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('camera');
    if (status === 'granted') return 'granted';
    const granted = await systemPreferences.askForMediaAccess('camera');
    return granted ? 'granted' : 'denied';
  });

  ipcMain.handle('permissions:accessibility', (_e, prompt: boolean) =>
    native.checkAccessibilityPermission(prompt),
  );

  ipcMain.handle('permissions:openSettings', async () => {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  });

  ipcMain.handle('calibration:start', (_e, points: 5 | 9, headMotion?: boolean) => {
    const withHeadMotion = headMotion ?? settings.calibrationHeadMotion;
    settings = { ...settings, calibrationPoints: points, calibrationHeadMotion: withHeadMotion };
    saveSettings(settings);
    const targets: Point[] = bridge?.startCalibration(points, withHeadMotion) ?? [];
    pushStatus(true);
    return targets;
  });

  ipcMain.handle('control:resumeFromManual', () => {
    bridge?.resumeFromManual();
    pushStatus(true);
  });

  ipcMain.handle('calibration:finish', () => {
    const report = bridge?.finishCalibration();
    pushStatus(true);
    return report;
  });

  ipcMain.handle('calibration:cancel', () => {
    bridge?.cancelCalibration();
    pushStatus(true);
  });

  ipcMain.handle('tuning:set', (_e, patch: TuningPatch) => {
    bridge?.setTuning(patch);
    settings = { ...settings, tuning: mergeTuning(settings.tuning, patch) };
    saveSettings(settings);
    return bridge?.getTuning();
  });

  ipcMain.handle('tuning:get', () => bridge?.getTuning());

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    if (patch.shortcut) registerShortcut();
    pushStatus(true);
    return settings;
  });

  // --- debug helpers for milestone M2 ---
  ipcMain.handle('debug:moveCursor', (_e, x: number, y: number) => native.moveCursor(x, y));
  ipcMain.handle('debug:click', (_e, count: number) => native.clickCursor(count));
}

function mergeTuning(base: TuningPatch, patch: TuningPatch): TuningPatch {
  return {
    filter: { ...base.filter, ...patch.filter },
    blink: { ...base.blink, ...patch.blink },
    guard: { ...base.guard, ...patch.guard },
    // Omitting `takeover` here silently discarded the yield-to-pointer setting
    // on every save, so it never survived a restart.
    takeover: { ...base.takeover, ...patch.takeover },
    pxPerDegree: patch.pxPerDegree ?? base.pxPerDegree,
  };
}

app.whenReady().then(() => {
  app.setName('Eye Tracker');

  try {
    bridge = new EngineBridge(settings.tuning);
  } catch (err) {
    console.error('[main] engine failed to initialize:', err);
  }

  controlWindow = createControlWindow();
  overlayWindow = createOverlayWindow();

  bridge?.onCalibration((ui: CalibrationUi) => {
    send(overlayWindow, 'calibration:ui', ui);
    send(controlWindow, 'calibration:ui', ui);
  });

  wireIpc();
  registerShortcut();

  // A display change invalidates a pixel-space calibration (ADR-0011).
  const onDisplayChange = () => {
    bridge?.handleDisplayChange();
    resizeOverlay(overlayWindow);
    pushStatus(true);
  };
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);

  // Losing the camera renderer means we are no longer receiving frames; the
  // watchdog would catch it, but do not wait 500 ms for something we know now.
  controlWindow.on('closed', () => {
    bridge?.setControlEnabled(false);
    controlWindow = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      controlWindow = createControlWindow();
      overlayWindow = createOverlayWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge?.dispose();
});

app.on('second-instance', () => {
  if (controlWindow) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.focus();
  }
});
