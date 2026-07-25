import {
  CALIBRATION_TIMING,
  FIXATION_PROMPT,
  HEAD_MOTION_TIMING,
  assertFrameLayout,
  headMotionTargets,
  type CalibrationProfile,
  type CalibrationReport,
  type EngineFrameState,
  type Point,
  type TuningPatch,
} from '@eye-tracker/core';
import native from '@eye-tracker/native';

import { currentFingerprint, estimatePxPerDegree, primaryBounds, unionBounds } from './displays.js';
import { loadProfile, saveProfile } from './settings.js';

/** Disable control if no frame arrives within this window (ADR-0011). */
const WATCHDOG_MS = 500;
const WATCHDOG_TICK_MS = 150;

export type CalibrationPhase = 'idle' | 'settle' | 'collect' | 'done';

export interface CalibrationUi {
  active: boolean;
  targets: Point[];
  currentIndex: number;
  phase: CalibrationPhase;
  progress: number;
  samples: number;
  headMotion: boolean;
  prompt: string;
}

const IDLE_CALIBRATION: CalibrationUi = {
  active: false,
  targets: [],
  currentIndex: -1,
  phase: 'idle',
  progress: 0,
  samples: 0,
  headMotion: false,
  prompt: '',
};

type FrameListener = (state: EngineFrameState) => void;
type CalibrationListener = (ui: CalibrationUi) => void;

/**
 * Owns the native engine and every piece of state that must survive a renderer
 * crash: control enablement, the calibration model, and the watchdog.
 */
export class EngineBridge {
  private engine: InstanceType<typeof native.Engine>;
  private fingerprint: string;

  /** Desired control state. Applied to the engine on the next frame so the
   *  arming clock is stamped in the renderer's clock domain, not main's. */
  private wantControl = false;
  private lastFrameAtMs = 0;
  private lastState: EngineFrameState | null = null;

  private calibration: CalibrationUi = { ...IDLE_CALIBRATION };
  /** Index at which the head-motion targets begin, or -1 when there are none. */
  private headMotionFrom = -1;
  private prompts: string[] = [];
  private calibrationTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  private frameListeners = new Set<FrameListener>();
  private calibrationListeners = new Set<CalibrationListener>();

  constructor(tuning: TuningPatch) {
    // Fail loudly if the packed layout has drifted (ADR-0009).
    assertFrameLayout(native.frameWidth());

    this.fingerprint = currentFingerprint();
    this.engine = new native.Engine(unionBounds(), {
      ...toNativePatch(tuning),
      pxPerDegree: estimatePxPerDegree(),
    });

    this.restoreProfile();
    this.startWatchdog();
  }

  // ---- lifecycle -----------------------------------------------------

  private startWatchdog(): void {
    // Deliberately in main: a watchdog inside the renderer cannot fire when the
    // renderer is the thing that has hung (ADR-0011).
    this.watchdog = setInterval(() => {
      if (!this.wantControl) return;
      const age = Date.now() - this.lastFrameAtMs;
      if (this.lastFrameAtMs > 0 && age > WATCHDOG_MS) {
        console.warn(`[engine] no frames for ${age}ms — disabling control`);
        this.setControlEnabled(false);
      }
    }, WATCHDOG_TICK_MS);
  }

  dispose(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.calibrationTimer) clearTimeout(this.calibrationTimer);
    this.setControlEnabled(false);
  }

  onFrame(cb: FrameListener): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onCalibration(cb: CalibrationListener): () => void {
    this.calibrationListeners.add(cb);
    return () => this.calibrationListeners.delete(cb);
  }

  // ---- hot path ------------------------------------------------------

  pushFrame(frame: Float64Array): EngineFrameState | null {
    this.lastFrameAtMs = Date.now();

    // Apply a pending enable using this frame's timestamp, so the engine's
    // arming window is measured in the same clock domain as the frames it is
    // comparing against.
    if (this.wantControl !== this.engine.controlEnabled) {
      const ts = frame[0] ?? 0;
      this.engine.setControlEnabled(this.wantControl, ts);
    }

    let state: EngineFrameState;
    try {
      state = this.engine.pushFrame(frame) as unknown as EngineFrameState;
    } catch (err) {
      console.error('[engine] pushFrame failed:', err);
      return null;
    }

    this.lastState = state;
    for (const cb of this.frameListeners) cb(state);
    return state;
  }

  get state(): EngineFrameState | null {
    return this.lastState;
  }

  // ---- control -------------------------------------------------------

  setControlEnabled(on: boolean): boolean {
    if (on) {
      // Refuse rather than pretend: without Accessibility permission,
      // CGEventPost silently no-ops (ADR-0010).
      if (!native.checkAccessibilityPermission(false)) return false;
      if (!this.engine.calibrated) return false;
      if (this.calibration.active) return false;
      this.wantControl = true;
      return true;
    }
    this.wantControl = false;
    // Disabling takes effect immediately; the timestamp is irrelevant.
    this.engine.setControlEnabled(false, 0);
    return true;
  }

  get controlEnabled(): boolean {
    return this.wantControl && this.engine.controlEnabled;
  }

  get calibrated(): boolean {
    return this.engine.calibrated;
  }

  get displayFingerprint(): string {
    return this.fingerprint;
  }

  setTuning(patch: TuningPatch): void {
    this.engine.setConfig(toNativePatch(patch));
  }

  /** Resume gaze after the user took the trackpad (ADR-0016). */
  resumeFromManual(): void {
    this.engine.resumeFromManual();
  }

  getTuning(): Record<string, number | boolean> {
    return this.engine.getConfig() as unknown as Record<string, number | boolean>;
  }

  /**
   * A display change invalidates the model, because it regresses directly to
   * screen pixels. Disable and prompt rather than continue with a fit that is
   * confidently wrong (ADR-0011).
   */
  handleDisplayChange(): void {
    const next = currentFingerprint();
    this.engine.setBounds(unionBounds());
    if (next === this.fingerprint) return;

    console.warn('[engine] display layout changed — calibration invalidated');
    this.fingerprint = next;
    this.setControlEnabled(false);
    this.engine.clearCalibration();
    this.restoreProfile();
  }

  private restoreProfile(): void {
    const profile = loadProfile(this.fingerprint);
    if (!profile) return;
    try {
      this.engine.loadCalibration(profile as never);
      console.log(
        `[engine] restored calibration (${profile.report.meanErrorDeg.toFixed(2)}° held-out)`,
      );
    } catch (err) {
      console.warn('[engine] stored profile rejected:', err);
    }
  }

  // ---- calibration ---------------------------------------------------

  get calibrationUi(): CalibrationUi {
    return this.calibration;
  }

  /**
   * @param withHeadMotion append targets where the user holds gaze while moving
   *   their head. Without these the head-compensation terms have no variance to
   *   fit and ridge correctly zeroes them, so the model only works at the pose
   *   it was calibrated in (ADR-0015).
   */
  startCalibration(points: 5 | 9, withHeadMotion = true): Point[] {
    this.setControlEnabled(false);
    const bounds = primaryBounds();
    const grid = native.calibrationTargets(bounds, points) as Point[];
    const prompts = grid.map(() => FIXATION_PROMPT);

    let targets = grid;
    this.headMotionFrom = -1;
    if (withHeadMotion) {
      const extra = headMotionTargets(bounds);
      this.headMotionFrom = grid.length;
      targets = [...grid, ...extra.map((t) => ({ x: t.x, y: t.y }))];
      prompts.push(...extra.map((t) => t.prompt));
    }

    this.prompts = prompts;
    this.engine.beginCalibration(targets);

    this.calibration = {
      ...IDLE_CALIBRATION,
      active: true,
      targets,
      prompt: prompts[0] ?? FIXATION_PROMPT,
    };
    this.advanceCalibration(0);
    return targets;
  }

  private isHeadMotionIndex(i: number): boolean {
    return this.headMotionFrom >= 0 && i >= this.headMotionFrom;
  }

  /**
   * Drives the per-target sequence: animate to draw fixation, discard the
   * saccade transit, then sample (ADR-0006).
   */
  private advanceCalibration(index: number): void {
    if (!this.calibration.active) return;

    if (index >= this.calibration.targets.length) {
      this.engine.setCalibrationTarget(null);
      this.calibration = { ...this.calibration, phase: 'done', currentIndex: -1, progress: 1 };
      this.emitCalibration();
      return;
    }

    const headMotion = this.isHeadMotionIndex(index);
    // Head-motion targets sample for much longer, because the user is sweeping
    // through a range of poses rather than holding one.
    const { settleMs, collectMs, discardMs, gapMs } = headMotion
      ? HEAD_MOTION_TIMING
      : CALIBRATION_TIMING;

    // Phase 1: settle. Target is shown and animates; nothing is collected.
    this.engine.setCalibrationTarget(null);
    this.calibration = {
      ...this.calibration,
      currentIndex: index,
      phase: 'settle',
      progress: index / this.calibration.targets.length,
      headMotion,
      prompt: this.prompts[index] ?? FIXATION_PROMPT,
    };
    this.emitCalibration();

    this.calibrationTimer = setTimeout(() => {
      if (!this.calibration.active) return;

      // Phase 2: collect, after discarding the leading saccade transit.
      this.calibration = { ...this.calibration, phase: 'collect' };
      this.emitCalibration();

      this.calibrationTimer = setTimeout(() => {
        if (!this.calibration.active) return;
        this.engine.setCalibrationTarget(index);

        this.calibrationTimer = setTimeout(() => {
          if (!this.calibration.active) return;
          this.engine.setCalibrationTarget(null);
          this.calibration = {
            ...this.calibration,
            samples: this.engine.calibrationProgress(index),
          };
          this.emitCalibration();

          this.calibrationTimer = setTimeout(() => this.advanceCalibration(index + 1), gapMs);
        }, collectMs - discardMs);
      }, discardMs);
    }, settleMs);
  }

  finishCalibration(): CalibrationReport {
    this.clearCalibrationTimer();
    const model = this.engine.finishCalibration(this.fingerprint);
    this.calibration = { ...IDLE_CALIBRATION };
    this.emitCalibration();

    saveProfile(this.fingerprint, model as unknown as CalibrationProfile);
    return model.report as unknown as CalibrationReport;
  }

  cancelCalibration(): void {
    this.clearCalibrationTimer();
    this.engine.cancelCalibration();
    this.calibration = { ...IDLE_CALIBRATION };
    this.emitCalibration();
  }

  private clearCalibrationTimer(): void {
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
  }

  private emitCalibration(): void {
    for (const cb of this.calibrationListeners) cb(this.calibration);
  }
}

/** Map the camelCase UI patch onto the native config shape. */
function toNativePatch(t: TuningPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (t.filter) out['filter'] = t.filter;
  if (t.blink) out['blink'] = t.blink;
  if (t.guard) out['guard'] = t.guard;
  if (t.takeover) out['takeover'] = t.takeover;
  if (t.pxPerDegree !== undefined) out['pxPerDegree'] = t.pxPerDegree;
  return out;
}
