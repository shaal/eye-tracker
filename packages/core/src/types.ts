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
  /**
   * This frame's tracking confidence. Distinct from `guardReason`, which
   * reports only the first blocking condition — while control is disabled it
   * says so and hides a quality problem completely.
   */
  quality: number;
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

/**
 * What the camera actually settled on, as opposed to what we asked it for.
 *
 * Reported rather than assumed because every field here is negotiable: the
 * driver picks the format, and whether the exposure lock took at all depends on
 * the camera and the Chromium build.
 *
 * Shared rather than renderer-local because it is also a property of any data
 * recorded from that camera — a session recorded with exposure unlocked is not
 * the same data as one recorded with it locked (ADR-0022).
 */
export interface CameraLockStatus {
  width: number;
  height: number;
  frameRate: number;
  /** `'manual'` once the lock takes; `null` when the camera reports no mode. */
  exposureMode: string | null;
  /** Pinned integration time, or `null` when the camera does not report one. */
  exposureTimeMs: number | null;
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
  /**
   * Whether tracking quality weighted the fit (ADR-0021).
   *
   * These four are optional because a profile saved before ADR-0021 does not
   * carry them; absent means the fit was unweighted.
   */
  qualityWeighted?: boolean;
  /** Mean sample weight — "were my samples mostly good?". */
  meanWeight?: number;
  /** Weight of the worst sample that still made it into the fit. */
  minWeight?: number;
  /**
   * Kish's effective sample size, `(Σw)² / Σw²`. Against `samples` it says
   * whether the weight spread was material: 250 of 253 means a uniformly good
   * session, 180 of 253 means a lot of the data was being trusted much less.
   */
  effectiveSamples?: number;
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

/** One calibration sample in gaze-feature space. Mirrors `ScatterPointJs`. */
export interface CalibrationScatterPoint {
  gx: number;
  gy: number;
  targetIndex: number;
  /** False when the outlier filter dropped it from the fit. */
  kept: boolean;
}

export interface CalibrationScatter {
  points: CalibrationScatterPoint[];
  /**
   * How many of the targets were fixation-grid points; indices at or above this
   * are head-motion targets.
   *
   * Essential rather than cosmetic. Head-motion targets sit at the *same*
   * screen positions as fixation targets and have deliberately enormous spread,
   * so any separability metric that includes them reports failure regardless of
   * how good the signal is (ADR-0018).
   */
  gridCount: number;
}

/**
 * How many screen pixels one unit of iris offset is worth, measured from the
 * loaded model by finite differences.
 *
 * This is the conversion that makes raw feature noise legible: a jitter of
 * 0.004 in `gx` means nothing on its own, but multiplied by `pxPerGx` it
 * becomes "your cursor cannot sit still to better than 90 px" (ADR-0005).
 */
export interface GazeSensitivity {
  pxPerGx: number;
  pxPerGy: number;
  /** False when nothing is calibrated, in which case the values are NaN. */
  calibrated: boolean;
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
    /**
     * Let per-frame tracking confidence modulate smoothing continuously
     * (ADR-0023). Off restores the pre-ADR-0023 pipeline exactly.
     */
    confidenceTrust: boolean;
    /** Lower bound on the trust scalar, and so on all three modulations. */
    trustFloor: number;
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
  /** How the calibration fit treats the samples it was given (ADR-0021). */
  calibration?: Partial<{
    /** Weight samples by tracking quality. Off restores the unweighted fit. */
    qualityWeighting: boolean;
    /** Lower bound on a sample's weight, so marginal is discounted, not deleted. */
    weightFloor: number;
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
  /**
   * A fixed reference dot for the continuous accuracy probe (debug mode 4).
   *
   * Unlike a validation run this never sequences or blocks anything: the dot
   * just sits there, and the debug panel reports the live offset between it and
   * the gaze estimate. It is the tool for "it was fine a minute ago" — lean
   * back, turn your head, change the lighting, and watch the offset move.
   */
  probeVisible: boolean;
  probeX: number;
  probeY: number;
  /**
   * A session recording is writing images of the user's face to disk
   * (ADR-0022).
   *
   * On the overlay rather than only in the control window because the overlay
   * is always-on-top, spans every display, and is visible when the control
   * window is minimised or behind something. "Am I being recorded?" must be
   * answerable without going to look for the answer, so this draws even when
   * `visible` is false — the crosshair is a preference, this is not.
   */
  recording: boolean;
}

export interface CalibrationUiState {
  active: boolean;
  targets: Point[];
  currentIndex: number;
  /**
   * 'instruct' shows a full-screen card and collects nothing; 'settle' draws an
   * attracting animation; 'collect' is sampling.
   */
  phase: 'idle' | 'instruct' | 'settle' | 'collect' | 'done';
  progress: number;
  samples: number;
  /**
   * True for the head-motion targets, where the user holds gaze on the dot
   * while moving their head. This is what gives the model's head-compensation
   * terms something to fit (ADR-0015).
   */
  headMotion: boolean;
  /** Short reminder shown under the target while sampling. */
  prompt: string;
  /**
   * Full-screen card shown during the 'instruct' phase.
   *
   * Only shown when the instruction actually *changes* — the nine fixation dots
   * share one instruction, so they get a single card between them rather than
   * nine identical interruptions, which users learn to ignore.
   */
  title: string;
  detail: string;
  /** How long the current instruction card lasts, for the countdown. */
  instructionMs: number;
}
