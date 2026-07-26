import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, systemPreferences } from 'electron';
import type {
  AppStatus,
  DiagnosticsRendererState,
  EngineFrameState,
  Point,
  TuningPatch,
  VisionStatus,
} from '@eye-tracker/core';
import native from '@eye-tracker/native';

import { EngineBridge, type CalibrationUi } from './engine-bridge.js';
import { exportDiagnostics, revealDiagnostics } from './diagnostics.js';
import {
  RecordingStore,
  type FrameWritePayload,
  type StartRecordingRequest,
} from './recordings.js';
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
/** Reference dot for the continuous accuracy probe (debug mode 4). */
let probePoint: Point | null = null;
/** Opt-in local session recorder (ADR-0022). Starts closed at every launch. */
const recordings = new RecordingStore(settings.recordingCapBytes);

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
//
// Say so before quitting. Exiting silently here is genuinely confusing —
// `npm run dev` prints a successful build, launches, and then appears to do
// nothing at all, with no indication that an older copy is holding the lock.
if (!app.requestSingleInstanceLock()) {
  console.error(
    '\n[eye-tracker] Another instance is already running, so this one is exiting.\n' +
      '              Quit it first (⌘Q in its window), or:\n' +
      '                pkill -f "eye-tracker/node_modules/electron"\n',
  );
  app.quit();
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const IDLE_ENGINE_STATE: EngineFrameState = {
  hasGaze: false,
  quality: 0,
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
  // `unregisterAll` also drops the modal calibration keys. Forget the flags so
  // the re-apply below actually re-registers rather than short-circuiting on a
  // stale "already active".
  cancelKeysActive = false;
  skipKeysActive = false;
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

  // Restore the modal keys if a run is on screen right now — changing the
  // kill-switch binding mid-calibration must not strip Escape.
  if (bridge?.calibrationUi.active || bridge?.validating) setCancelKeys(true);
  if (bridge?.calibrationUi.phase === 'instruct') setSkipKeys(true);
}

// ---------------------------------------------------------------------------
// Modal calibration/validation keys
//
// These have to be *global* shortcuts. During a run the user is looking at a
// full-screen overlay while keyboard focus is wherever it happened to be, and
// the overlay itself is deliberately `focusable: false` so it never steals
// focus (ADR-0002) — so a renderer keydown handler in either window would only
// work by luck.
//
// Grabbing Space/Return/Escape system-wide is only acceptable because a
// calibration run is a modal takeover with a hard end: they are registered when
// one starts and released the moment it stops.
// ---------------------------------------------------------------------------

/**
 * Escape is held for the whole run; the skip keys only while a card is up.
 *
 * The split is deliberate. Escape needs to work at any moment — that is the
 * point of a bail-out. Space and Return, however, are ordinary keys that other
 * apps want, so they are grabbed for the few seconds a card is actually on
 * screen rather than for the whole forty-second run.
 */
const CANCEL_KEYS = ['Escape'] as const;
const SKIP_KEYS = ['Space', 'Return'] as const;

let cancelKeysActive = false;
let skipKeysActive = false;

function grab(keys: readonly string[], on: boolean, handler: () => void): void {
  for (const key of keys) {
    // Never touch the kill-switch binding. If the user has bound control toggle
    // to Escape or Space, grabbing it here would replace their registration for
    // the run and then *unregister it outright* on release — leaving no kill
    // switch while `shortcutRegistered` still claims there is one. That is
    // exactly the fail-open state ADR-0011 exists to prevent, and losing a
    // convenience key is a trivial price beside it.
    if (key === settings.shortcut) {
      console.warn(
        `[shortcut] "${key}" is the kill switch — not grabbing it for calibration`,
      );
      continue;
    }
    if (!on) {
      globalShortcut.unregister(key);
      continue;
    }
    try {
      if (!globalShortcut.register(key, handler)) {
        console.warn(`[shortcut] "${key}" is held by another app — unavailable this run`);
      }
    } catch (err) {
      // Non-fatal by design: the card still advances on its own timer, so a key
      // we cannot grab costs convenience, not the ability to calibrate.
      console.warn(`[shortcut] could not register "${key}":`, err);
    }
  }
}

function setCancelKeys(on: boolean): void {
  if (on === cancelKeysActive) return;
  cancelKeysActive = on;
  grab(CANCEL_KEYS, on, () => {
    // Escape means "get me out of this", so it applies to whichever modal run
    // is on screen. Cancelling only one of them would be a trap.
    bridge?.cancelCalibration();
    bridge?.cancelValidation();
    pushStatus(true);
  });
}

function setSkipKeys(on: boolean): void {
  if (on === skipKeysActive) return;
  skipKeysActive = on;
  grab(SKIP_KEYS, on, () => bridge?.skipInstruction());
}

/**
 * Let the overlay receive clicks — used only while an instruction card is up.
 *
 * This is the single most dangerous flag in the app. The overlay spans the
 * entire desktop, so while it is not click-through **nothing on the machine is
 * clickable**. It is therefore driven from exactly one place (the calibration
 * emit path, below), so that cancelling, finishing, or erroring all revert it
 * without needing to remember to — plus the watchdog below as a second net.
 */
let overlayInteractive = false;
let overlayInteractiveGuard: NodeJS.Timeout | null = null;

function setOverlayInteractive(on: boolean): void {
  // Both early returns come BEFORE the timer is touched, and that ordering is
  // load-bearing. Clearing first meant a redundant `true` call — any duplicate
  // emit while already in the 'instruct' phase — disarmed the watchdog and then
  // returned without re-arming it, leaving the "desktop nobody can click" case
  // with no recovery at all. The net was being cancelled by the very state it
  // exists to protect.
  if (on === overlayInteractive) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayInteractiveGuard) {
    clearTimeout(overlayInteractiveGuard);
    overlayInteractiveGuard = null;
  }

  overlayInteractive = on;
  if (on) {
    overlayWindow.setIgnoreMouseEvents(false);
    // Belt and braces: an instruction card lasts at most 7 s, so if we are
    // still interactive well past that, something went wrong upstream and a
    // desktop the user cannot click is much worse than a missed skip.
    overlayInteractiveGuard = setTimeout(() => {
      console.warn('[overlay] click-through was not restored in time — forcing it');
      setOverlayInteractive(false);
    }, 12_000);
  } else {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
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
    probeVisible: probePoint !== null,
    probeX: probePoint?.x ?? 0,
    probeY: probePoint?.y ?? 0,
    // Drawn on the always-on-top layer regardless of `visible`, so "am I being
    // recorded?" is answerable from any Space, behind any window (ADR-0022).
    recording: recordings.active,
  });
}

/** Push the recording counters to the control window. */
async function pushRecordingState(): Promise<void> {
  send(controlWindow, 'recording:state', await recordings.stats());
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

  /** Dismiss an instruction card early. No-op in any other phase. */
  ipcMain.handle('calibration:skipInstruction', () => {
    bridge?.skipInstruction();
  });

  // --- validation: measures the model, never modifies it ---
  ipcMain.handle('validation:start', () => {
    const targets = bridge?.startValidation() ?? [];
    pushStatus(true);
    return targets;
  });

  ipcMain.handle('validation:finish', () => {
    const report = bridge?.finishValidation();
    pushStatus(true);
    return report;
  });

  ipcMain.handle('validation:cancel', () => {
    bridge?.cancelValidation();
    pushStatus(true);
  });

  // --- debug probes ---
  ipcMain.handle('debug:scatter', () => bridge?.calibrationScatter() ?? { points: [], gridCount: 0 });

  ipcMain.handle('debug:calibration', () => bridge?.calibrationProfile() ?? null);

  /** Work area of the primary display — the frame the debug error map draws in. */
  ipcMain.handle('debug:bounds', () => screen.getPrimaryDisplay().workArea);

  /**
   * Park the probe dot at a screen point, or pass nothing to hide it. Defaults
   * to the centre of the primary display, which is the least biased place to
   * measure from.
   */
  ipcMain.handle('debug:setProbe', (_e, at?: Point | null) => {
    if (at === null) {
      probePoint = null;
    } else if (at === undefined) {
      const b = screen.getPrimaryDisplay().workArea;
      probePoint = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } else {
      probePoint = at;
    }
    pushOverlay();
    return probePoint;
  });

  ipcMain.handle('debug:sensitivity', (_e, frame: Float64Array | ArrayBufferLike) => {
    const f =
      frame instanceof Float64Array ? frame : new Float64Array(frame as ArrayBufferLike);
    return bridge?.gazeSensitivity(f);
  });

  // ---------------------------------------------------------------------
  // Diagnostics export (ADR-0024) — numbers only, and designed to be shared
  //
  // The mirror image of the recording channels above: those write pixels and
  // must never leave the machine, this writes nothing but numbers and exists to
  // be pasted into a public issue. Neither channel takes a URL or a destination
  // — main writes to one directory it names itself, and the user does the rest.
  // ---------------------------------------------------------------------

  ipcMain.handle('diagnostics:export', async (_e, renderer: DiagnosticsRendererState) => {
    // Everything main contributes is read *now*, from the engine, rather than
    // being cached: the config in particular has to be what Rust is actually
    // running, because the whole point is comparing two runs of the same build
    // with a switch flipped (ADR-0021, ADR-0023).
    return exportDiagnostics(renderer, {
      displayFingerprint: bridge?.displayFingerprint ?? '',
      displayBounds: screen.getPrimaryDisplay().workArea,
      tuning: bridge?.getTuning() ?? {},
      // From the loaded model rather than from whatever the UI last rendered,
      // so a bundle exported after a restart still carries the calibration the
      // engine is using.
      calibration: bridge?.calibrationProfile()?.report ?? null,
      engine: bridge?.state
        ? {
            fps: bridge.state.fps,
            poseDrift: bridge.state.poseDrift,
            headCompensated: bridge.state.headCompensated,
            calibrated: bridge.state.calibrated,
            guardReason: bridge.state.guardReason,
          }
        : null,
    });
  });

  ipcMain.handle('diagnostics:reveal', () => revealDiagnostics());

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

  // ---------------------------------------------------------------------
  // Session recording (ADR-0022) — local disk only, never the network
  // ---------------------------------------------------------------------

  ipcMain.handle('recording:start', async (_e, request: StartRecordingRequest) => {
    const started = await recordings.start(request, {
      // Targets are recorded in screen pixels, so the layout they were measured
      // in is part of the data — the same argument that makes a calibration
      // profile layout-specific (ADR-0006).
      displayFingerprint: bridge?.displayFingerprint ?? '',
    });
    pushOverlay();
    await pushRecordingState();
    return started;
  });

  ipcMain.on(
    'recording:frame',
    (_e, payload: { record: FrameWritePayload['record']; eyeA: BufferLike; eyeB: BufferLike }) => {
      // `send`, not `handle`: the renderer never waits for the disk.
      recordings.write({
        record: payload.record,
        eyeA: asBytes(payload.eyeA),
        eyeB: asBytes(payload.eyeB),
      });
    },
  );

  ipcMain.handle('recording:stop', async () => {
    const stats = await recordings.stop('stopped by the user');
    pushOverlay();
    return stats;
  });

  ipcMain.handle('recording:stats', () => recordings.stats());

  ipcMain.handle('recording:setCap', async (_e, bytes: number) => {
    // A cap below what is already on disk would stop the next session on its
    // first frame with no explanation, so refuse the nonsensical values here
    // rather than letting them look like a bug later.
    const capBytes = Math.max(50_000_000, Math.round(bytes));
    settings = { ...settings, recordingCapBytes: capBytes };
    saveSettings(settings);
    recordings.setCapBytes(capBytes);
    return recordings.stats();
  });

  ipcMain.handle('recording:deleteAll', async () => {
    const removed = await recordings.deleteAll();
    pushOverlay();
    await pushRecordingState();
    return removed;
  });

  ipcMain.handle('recording:reveal', () => recordings.reveal());

  // --- debug helpers for milestone M2 ---
  ipcMain.handle('debug:moveCursor', (_e, x: number, y: number) => native.moveCursor(x, y));
  ipcMain.handle('debug:click', (_e, count: number) => native.clickCursor(count));
}

/**
 * Structured clone hands typed arrays across as `ArrayBuffer` in some Electron
 * versions and as the view in others; both are `fs.writeFile`-able only after
 * being normalized to one of them.
 */
type BufferLike = ArrayBuffer | Uint8Array;

function asBytes(value: BufferLike): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
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

    // Derived from state rather than set at each call site: every way a run can
    // end — finishing, cancelling, Escape, a failed fit — goes through here, so
    // none of them can forget to release the keys or restore click-through.
    const instructing = ui.active && ui.phase === 'instruct';
    setCancelKeys(ui.active || (bridge?.validating ?? false));
    setSkipKeys(instructing);
    setOverlayInteractive(instructing);
  });

  bridge?.onValidation((ui) => {
    send(overlayWindow, 'validation:ui', ui);
    send(controlWindow, 'validation:ui', ui);
    // Validation has no instruction cards, so it wants Escape but neither the
    // skip keys nor click-through.
    setCancelKeys(ui.active || (bridge?.calibrationUi.active ?? false));
  });

  // The disk cap ends a session without the user asking, so it has to say so
  // loudly. A recorder that stopped silently and one that is still running look
  // identical from the outside, and both directions of that confusion are bad.
  recordings.onAutoStop((reason) => {
    send(controlWindow, 'app:notice', {
      level: 'warn',
      message: `Recording stopped: ${reason}. Delete recordings or raise the cap to record again.`,
    });
    pushOverlay();
    void pushRecordingState();
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
    // The camera is gone with the window, so nothing more can be recorded. End
    // the session here rather than leaving an open manifest behind, which would
    // read as "still recording" to anyone who looked at the directory.
    if (recordings.active) {
      void recordings.stop('the control window closed').then(() => pushOverlay());
    }
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
  // Restore click-through before tearing down, in case we are quitting while an
  // instruction card happens to be up.
  setOverlayInteractive(false);
  // Best effort: `will-quit` does not wait for promises, so an interrupted
  // session may lose its final manifest rewrite. That is why the manifest is
  // written at *start* — a killed session is still self-describing, it just
  // lacks the totals.
  void recordings.stop('the app quit');
  bridge?.dispose();
});

app.on('second-instance', () => {
  if (controlWindow) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.focus();
  }
});
