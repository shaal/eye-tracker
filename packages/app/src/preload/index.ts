import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppStatus,
  CalibrationProfile,
  CalibrationReport,
  CalibrationScatter,
  CalibrationUiState,
  FrameRecord,
  GazeSensitivity,
  OverlayState,
  Point,
  RecordedCamera,
  RecordingStats,
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

  // ---------------------------------------------------------------------
  // Session recording (ADR-0022)
  //
  // Opt-in, off at every launch, and local-only. These five channels are the
  // *entire* surface: a directory under `userData` is created, PNGs and a JSONL
  // sidecar are written into it, the byte total is read back, and the whole lot
  // can be deleted. There is deliberately no channel that takes a URL, a
  // destination, or a remote handle of any kind — if this file grows one,
  // something has gone badly wrong.
  // ---------------------------------------------------------------------

  startRecording: (request: {
    camera: RecordedCamera | null;
    video: { width: number; height: number };
    intervalMs: number;
    swapEyes: boolean;
  }): Promise<{ sessionId: string; directory: string }> =>
    ipcRenderer.invoke('recording:start', request),

  stopRecording: (): Promise<RecordingStats> => ipcRenderer.invoke('recording:stop'),

  /**
   * One frame's pixels and metadata, one-way.
   *
   * Not an `invoke`, on purpose: the renderer must never end up awaiting main's
   * disk, for exactly the reason `gaze:frame` is one-way (ADR-0009). The
   * renderer supplies a sequence number and main derives the filenames, so a
   * compromised camera-facing page cannot name a path.
   */
  recordFrame(payload: {
    record: Omit<FrameRecord, 'eyeA' | 'eyeB'>;
    eyeA: ArrayBuffer;
    eyeB: ArrayBuffer;
  }): void {
    ipcRenderer.send('recording:frame', payload);
  },

  getRecordingStats: (): Promise<RecordingStats> => ipcRenderer.invoke('recording:stats'),

  setRecordingCap: (bytes: number): Promise<RecordingStats> =>
    ipcRenderer.invoke('recording:setCap', bytes),

  /** Remove every recorded session on this machine. Not undoable. */
  deleteAllRecordings: (): Promise<{ sessions: number; bytes: number }> =>
    ipcRenderer.invoke('recording:deleteAll'),

  /** Open the recordings folder, so the user can see exactly what is there. */
  revealRecordings: (): Promise<void> => ipcRenderer.invoke('recording:reveal'),

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
  /**
   * Recording state pushed by main.
   *
   * Needed because main can end a session on its own when the disk cap is
   * reached, and a UI still claiming to record would be worse than no UI at
   * all.
   */
  onRecordingState(cb: (s: RecordingStats) => void): () => void {
    const h = (_e: unknown, s: RecordingStats) => cb(s);
    ipcRenderer.on('recording:state', h);
    return () => ipcRenderer.removeListener('recording:state', h);
  },
  onNotice(cb: (n: { level: string; message: string }) => void): () => void {
    const h = (_e: unknown, n: { level: string; message: string }) => cb(n);
    ipcRenderer.on('app:notice', h);
    return () => ipcRenderer.removeListener('app:notice', h);
  },
};

export type EyeTrackerApi = typeof api;

contextBridge.exposeInMainWorld('eyeTracker', api);
