/** Contracts shared between the main process and both renderers. */

export interface Point {
  x: number;
  y: number;
}

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mirrors `Guard` in `engine.rs`. Kept in sync by value, not by name. */
export const GUARD_LABELS = [
  'ok',
  'control disabled',
  'calibrating',
  'not calibrated',
  'no face detected',
  'tracking quality too low',
  'frame gap too large',
  'blink in progress',
  'arming',
  'waiting for stable tracking',
  'yielded to mouse/trackpad',
] as const;

export const BLINK_PHASE = { OPEN: 0, CLOSED: 1, LONG_CLOSE: 2 } as const;
export const CLICK_KIND = { NONE: 0, SINGLE: 1, DOUBLE: 2 } as const;
export const CLICK_BUTTON = { LEFT: 0, RIGHT: 1, MIDDLE: 2 } as const;

/** How eyelid gestures map to clicks (ADR-0013). */
export type ClickMode = 'blink' | 'wink';

export const CLICK_MODE_LABELS: Record<ClickMode, string> = {
  blink: 'Blink — both eyes (1 = click, 2 = double-click)',
  wink: 'Wink — left eye = click, left twice = double-click, right eye = right-click',
};

/** Per-frame result from the native engine, forwarded to the UI. */
export interface EngineFrameState {
  hasGaze: boolean;
  x: number;
  y: number;
  rawX: number;
  rawY: number;
  moved: boolean;
  click: number;
  clickButton: number;
  clickX: number;
  clickY: number;
  blinkPhase: number;
  closure: number;
  closureLeft: number;
  closureRight: number;
  /** Head-pose distance from the calibration pose, in standard deviations. */
  poseDrift: number;
  /** Whether the loaded model contains head compensation at all (ADR-0015). */
  headCompensated: boolean;
  clampRadius: number;
  gazeSpread: number;
  /** Gaze has yielded to a physical mouse or trackpad (ADR-0016). */
  manualOverride: boolean;
  guard: number;
  guardReason: string;
  controlEnabled: boolean;
  calibrated: boolean;
  clamped: boolean;
  saccade: boolean;
  fps: number;
  stale: boolean;
  calibrating: boolean;
  calibrationSamples: number;
  error?: string | null;
}

/** Vision-side status, which main cannot know on its own. */
export interface VisionStatus {
  cameraReady: boolean;
  modelReady: boolean;
  delegate: 'GPU' | 'CPU' | 'none';
  /** Model inference time, ms, smoothed. */
  inferenceMs: number;
  cameraFps: number;
  faceVisible: boolean;
  quality: number;
  interocular: number;
  message?: string;
}

export interface PermissionState {
  camera: 'granted' | 'denied' | 'unknown';
  accessibility: boolean;
}

export interface AppStatus {
  engine: EngineFrameState;
  vision: VisionStatus;
  permissions: PermissionState;
  shortcut: string;
  shortcutRegistered: boolean;
  displayFingerprint: string;
  calibrationStale: boolean;
}

export interface CalibrationReport {
  tierName: string;
  samples: number;
  targets: number;
  meanErrorPx: number;
  p95ErrorPx: number;
  meanErrorDeg: number;
  perTargetErrorPx: number[];
  lambdaX: number;
  lambdaY: number;
  crossValidated: boolean;
}

export interface CalibrationProfile {
  tier: string;
  mean: number[];
  scale: number[];
  betaX: number[];
  betaY: number[];
  interceptX: number;
  interceptY: number;
  lambdaX: number;
  lambdaY: number;
  displayFingerprint: string;
  report: CalibrationReport;
  /** Mean head pose during calibration (yaw, pitch, roll, hx, hy, hz). */
  poseMean: number[];
  /** Head-pose spread. Near-zero means no head compensation (ADR-0015). */
  poseStd: number[];
}

/** Live-tunable engine parameters (ADR-0007, ADR-0008, ADR-0013, ADR-0016). */
export interface TuningPatch {
  filter?: Partial<{
    minCutoff: number;
    beta: number;
    dCutoff: number;
    saccadePx: number;
    clampRadius: number;
    clampMs: number;
    clampMaxHoldMs: number;
    medianWindow: number;
    adaptiveClamp: boolean;
    clampNoiseScale: number;
    clampRadiusMax: number;
  }>;
  blink?: Partial<{
    mode: ClickMode;
    closeThresh: number;
    openThresh: number;
    minCloseMs: number;
    maxCloseMs: number;
    winkMinCloseMs: number;
    winkMaxCloseMs: number;
    winkAsymmetry: number;
    doubleWindowMs: number;
    refractoryMs: number;
    preBlinkLookbackMs: number;
    useGeometricFallback: boolean;
    restOpenRatio: number;
  }>;
  guard?: Partial<{
    minQuality: number;
    trackSettleMs: number;
    maxFrameAgeMs: number;
    armingMs: number;
  }>;
  takeover?: Partial<{
    enabled: boolean;
    epsilonPx: number;
    resumeAfterMs: number;
    requireManualResume: boolean;
  }>;
  pxPerDegree?: number;
}

/** Overlay draw state, sent at full frame rate. */
export interface OverlayState {
  visible: boolean;
  x: number;
  y: number;
  rawX: number;
  rawY: number;
  showRaw: boolean;
  hasGaze: boolean;
  controlEnabled: boolean;
  blinkPhase: number;
  clamped: boolean;
  /** Non-zero briefly after a click, for the click flash. */
  clickPulse: number;
  guardReason: string;
}

export interface CalibrationUiState {
  active: boolean;
  targets: Point[];
  currentIndex: number;
  /** 'settle' draws an attracting animation; 'collect' is sampling. */
  phase: 'idle' | 'settle' | 'collect' | 'done';
  progress: number;
  samples: number;
  /**
   * True for the head-motion targets, where the user holds gaze on the dot
   * while moving their head. This is what gives the model's head-compensation
   * terms something to fit (ADR-0015).
   */
  headMotion: boolean;
  /** Instruction shown under the target. */
  prompt: string;
}
