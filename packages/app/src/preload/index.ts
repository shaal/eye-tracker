import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppStatus,
  CalibrationProfile,
  CalibrationReport,
  CalibrationScatter,
  CalibrationUiState,
  GazeSensitivity,
  OverlayState,
  Point,
  ScreenBounds,
  TuningPatch,
  ValidationReport,
  ValidationUiState,
  VisionStatus,
} from '@eye-tracker/core';

/**
 * The entire surface the renderers get (ADR-0002). Nothing else crosses: no
 * Node, no filesystem, no direct access to the native addon. A compromised page
 * in the camera-facing process cannot synthesize input.
 */
const api = {
  // --- streaming, renderer → main (one-way, no round trip) ---
  sendFrame(frame: Float64Array): void {
    ipcRenderer.send('gaze:frame', frame);
  },
  reportVision(status: VisionStatus): void {
    ipcRenderer.send('vision:status', status);
  },

  // --- commands ---
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:status'),
  setControlEnabled: (on: boolean): Promise<boolean> => ipcRenderer.invoke('control:set', on),

  requestCamera: (): Promise<'granted' | 'denied'> => ipcRenderer.invoke('permissions:camera'),
  checkAccessibility: (prompt: boolean): Promise<boolean> =>
    ipcRenderer.invoke('permissions:accessibility', prompt),
  openAccessibilitySettings: (): Promise<void> => ipcRenderer.invoke('permissions:openSettings'),

  resumeFromManual: (): Promise<void> => ipcRenderer.invoke('control:resumeFromManual'),

  startCalibration: (points: 5 | 9, headMotion?: boolean): Promise<Point[]> =>
    ipcRenderer.invoke('calibration:start', points, headMotion),
  finishCalibration: (): Promise<CalibrationReport> => ipcRenderer.invoke('calibration:finish'),
  cancelCalibration: (): Promise<void> => ipcRenderer.invoke('calibration:cancel'),
  /** Dismiss an instruction card early. Ignored outside the 'instruct' phase. */
  skipInstruction: (): Promise<void> => ipcRenderer.invoke('calibration:skipInstruction'),

  startValidation: (): Promise<Point[]> => ipcRenderer.invoke('validation:start'),
  finishValidation: (): Promise<ValidationReport> => ipcRenderer.invoke('validation:finish'),
  cancelValidation: (): Promise<void> => ipcRenderer.invoke('validation:cancel'),

  setTuning: (patch: TuningPatch): Promise<Record<string, number | boolean | string>> =>
    ipcRenderer.invoke('tuning:set', patch),
  getTuning: (): Promise<Record<string, number | boolean | string>> => ipcRenderer.invoke('tuning:get'),

  getSettings: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('settings:set', patch),

  // --- debug (milestone M2) ---
  debugMoveCursor: (x: number, y: number): Promise<void> =>
    ipcRenderer.invoke('debug:moveCursor', x, y),
  debugClick: (count: number): Promise<void> => ipcRenderer.invoke('debug:click', count),

  /** Calibration samples in gaze-feature space, for the scatter plot. */
  getCalibrationScatter: (): Promise<CalibrationScatter> => ipcRenderer.invoke('debug:scatter'),
  /**
   * Screen pixels per unit of iris offset, probed about the supplied live
   * frame. This is what converts raw feature jitter into a cursor-noise figure.
   */
  getGazeSensitivity: (frame: Float64Array): Promise<GazeSensitivity> =>
    ipcRenderer.invoke('debug:sensitivity', frame),
  /** Work area of the primary display, so the debug map can draw to scale. */
  getDisplayBounds: (): Promise<ScreenBounds> => ipcRenderer.invoke('debug:bounds'),
  /** The loaded model, for the per-axis pose-drift breakdown. */
  getCalibrationProfile: (): Promise<CalibrationProfile | null> =>
    ipcRenderer.invoke('debug:calibration'),
  /**
   * Park the continuous-probe dot. `null` hides it; omitting the argument puts
   * it at the centre of the primary display.
   */
  setProbePoint: (at?: Point | null): Promise<Point | null> =>
    ipcRenderer.invoke('debug:setProbe', at),

  // --- subscriptions ---
  onStatus(cb: (s: AppStatus) => void): () => void {
    const h = (_e: unknown, s: AppStatus) => cb(s);
    ipcRenderer.on('hud:state', h);
    return () => ipcRenderer.removeListener('hud:state', h);
  },
  onOverlay(cb: (s: OverlayState) => void): () => void {
    const h = (_e: unknown, s: OverlayState) => cb(s);
    ipcRenderer.on('overlay:state', h);
    return () => ipcRenderer.removeListener('overlay:state', h);
  },
  onCalibrationUi(cb: (s: CalibrationUiState) => void): () => void {
    const h = (_e: unknown, s: CalibrationUiState) => cb(s);
    ipcRenderer.on('calibration:ui', h);
    return () => ipcRenderer.removeListener('calibration:ui', h);
  },
  onValidationUi(cb: (s: ValidationUiState) => void): () => void {
    const h = (_e: unknown, s: ValidationUiState) => cb(s);
    ipcRenderer.on('validation:ui', h);
    return () => ipcRenderer.removeListener('validation:ui', h);
  },
  onNotice(cb: (n: { level: string; message: string }) => void): () => void {
    const h = (_e: unknown, n: { level: string; message: string }) => cb(n);
    ipcRenderer.on('app:notice', h);
    return () => ipcRenderer.removeListener('app:notice', h);
  },
};

export type EyeTrackerApi = typeof api;

contextBridge.exposeInMainWorld('eyeTracker', api);
