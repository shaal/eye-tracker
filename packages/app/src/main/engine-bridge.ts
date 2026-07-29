import {
  CALIBRATION_SAMPLING,
  CALIBRATION_TIMING,
  FIXATION_INSTRUCTION,
  FIXATION_PROMPT,
  FRAME_SLOTS,
  FRAME_WIDTH,
  HEAD_MOTION_TIMING,
  instructionDurationMs,
  VALIDATION_PROMPT,
  VALIDATION_TIMING,
  assertFrameLayout,
  headMotionTargets,
  summarizeValidation,
  validationTargets,
  TUNING_GROUPS,
  type CalibrationInstruction,
  type CalibrationProfile,
  type CalibrationReport,
  type CalibrationScatter,
  type EngineFrameState,
  type GazeSensitivity,
  type Point,
  type TuningPatch,
  type ValidationReport,
  type ValidationSamples,
  type ValidationUiState,
} from '@eye-tracker/core';
import native from '@eye-tracker/native';

import { currentFingerprint, estimatePxPerDegree, primaryBounds, unionBounds } from './displays.js';
import { loadProfile, saveProfile } from './settings.js';

/** Disable control if no frame arrives within this window (ADR-0011). */
const WATCHDOG_MS = 500;
const WATCHDOG_TICK_MS = 150;

export type CalibrationPhase = 'idle' | 'instruct' | 'settle' | 'collect' | 'done';

export interface CalibrationUi {
  active: boolean;
  targets: Point[];
  currentIndex: number;
  phase: CalibrationPhase;
  progress: number;
  samples: number;
  headMotion: boolean;
  prompt: string;
  title: string;
  detail: string;
  instructionMs: number;
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
  title: '',
  detail: '',
  instructionMs: 0,
};

const IDLE_VALIDATION: ValidationUiState = {
  active: false,
  targets: [],
  currentIndex: -1,
  phase: 'idle',
  samples: 0,
  prompt: '',
};

type FrameListener = (state: EngineFrameState) => void;
type CalibrationListener = (ui: CalibrationUi) => void;
type ValidationListener = (ui: ValidationUiState) => void;

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
  private instructions: CalibrationInstruction[] = [];
  private calibrationTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  private validation: ValidationUiState = { ...IDLE_VALIDATION };
  /** Armed target index while validation is sampling, or -1. */
  private validationArmed = -1;
  private validationSamples: ValidationSamples[] = [];
  private validationTimer: NodeJS.Timeout | null = null;
  private validationMinQuality = 0;

  private frameListeners = new Set<FrameListener>();
  private calibrationListeners = new Set<CalibrationListener>();
  private validationListeners = new Set<ValidationListener>();

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
    this.clearValidationTimer();
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

  onValidation(cb: ValidationListener): () => void {
    this.validationListeners.add(cb);
    return () => this.validationListeners.delete(cb);
  }

  // ---- hot path ------------------------------------------------------

  pushFrame(frame: Float64Array): EngineFrameState | null {
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

    // Stamped only after the engine has actually accepted the frame. Doing it
    // on arrival would let a stream of frames the engine is rejecting keep the
    // watchdog satisfied indefinitely, which defeats the whole point of it
    // (ADR-0011).
    this.lastFrameAtMs = Date.now();

    this.lastState = state;
    this.collectValidationSample(state);
    for (const cb of this.frameListeners) cb(state);
    return state;
  }

  /**
   * Record one prediction against the armed validation target.
   *
   * Both the unfiltered model output and the filtered cursor are kept. Scoring
   * the raw values measures the *model*, which is what recalibration can fix;
   * comparing the two shows what the smoothing pipeline bought, which is what
   * the filter sliders can fix. One number could not answer both.
   */
  private collectValidationSample(state: EngineFrameState): void {
    if (this.validationArmed < 0) return;
    const bucket = this.validationSamples[this.validationArmed];
    if (!bucket) return;

    // The same admissions test the calibration collector applies: a prediction
    // made while the eyes are shut or the face is lost is not a measurement of
    // accuracy, it is a measurement of the guard.
    if (!state.hasGaze || state.blinkPhase !== 0) return;
    // Snapshotted at run start rather than read per frame: `getConfig()`
    // allocates a JS object across the napi boundary, and this runs at camera
    // rate.
    if (state.quality < this.validationMinQuality) return;

    bucket.raw.push({ x: state.rawX, y: state.rawY });
    bucket.filtered.push({ x: state.x, y: state.y });
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
      // A cursor moving under the validation dots would both distract the user
      // and corrupt the measurement (ADR-0011).
      if (this.validation.active) return false;
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
    // Validation targets are absolute screen coordinates from the old layout,
    // so anything still in flight is measuring against the wrong points.
    if (this.validation.active) this.cancelValidation();
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
    // Starting again while a run is in flight would leave the previous timer
    // chain alive, and two chains racing on `setCalibrationTarget` would arm
    // the wrong target.
    this.clearCalibrationTimer();
    if (this.calibration.active) this.engine.cancelCalibration();
    // A validation run in flight would keep arming targets and stealing frames
    // into buckets that no longer mean anything once the model is refitted.
    if (this.validation.active) this.cancelValidation();

    this.setControlEnabled(false);
    const bounds = primaryBounds();
    const grid = native.calibrationTargets(bounds, points) as Point[];
    const prompts = grid.map(() => FIXATION_PROMPT);
    // All nine fixation dots share one instruction, which is what makes the
    // "only show it when it changes" rule collapse them into a single card.
    const instructions: CalibrationInstruction[] = grid.map(() => FIXATION_INSTRUCTION);

    let targets = grid;
    this.headMotionFrom = -1;
    if (withHeadMotion) {
      const extra = headMotionTargets(bounds);
      this.headMotionFrom = grid.length;
      targets = [...grid, ...extra.map((t) => ({ x: t.x, y: t.y }))];
      prompts.push(...extra.map((t) => t.prompt));
      instructions.push(...extra.map((t) => ({ title: t.title, detail: t.detail })));
    }

    this.prompts = prompts;
    this.instructions = instructions;
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

  /**
   * Whether target `index` needs its own instruction card.
   *
   * True for the first target, and thereafter only when the instruction differs
   * from the previous one. Showing an identical card before each of the nine
   * fixation dots would be nine interruptions carrying one instruction's worth
   * of information — and users correctly learn to dismiss repeated cards
   * without reading them, which would defeat the card that actually matters.
   */
  private needsInstruction(index: number): boolean {
    const here = this.instructions[index];
    if (!here) return false;
    if (index === 0) return true;
    const before = this.instructions[index - 1];
    return !before || before.title !== here.title || before.detail !== here.detail;
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

    const instruction = this.instructions[index] ?? FIXATION_INSTRUCTION;
    const instructionMs = this.needsInstruction(index)
      ? instructionDurationMs(`${instruction.title} ${instruction.detail}`)
      : 0;

    // Nothing is armed during any of this; collection only starts below.
    this.engine.setCalibrationTarget(null);
    this.calibration = {
      ...this.calibration,
      currentIndex: index,
      // Phase 0: instruct. Full-screen card, no dot, nothing collected.
      phase: instructionMs > 0 ? 'instruct' : 'settle',
      progress: index / this.calibration.targets.length,
      headMotion,
      prompt: this.prompts[index] ?? FIXATION_PROMPT,
      title: instruction.title,
      detail: instruction.detail,
      instructionMs,
    };
    this.emitCalibration();

    // The rest of the sequence is identical either way; when there is no card
    // to show, the delay before it is simply zero.
    this.calibrationTimer = setTimeout(() => {
      if (!this.calibration.active) return;
      if (instructionMs > 0) {
        // Phase 1: settle. Target appears and animates; nothing is collected.
        this.calibration = { ...this.calibration, phase: 'settle' };
        this.emitCalibration();
      }
      this.runSettleAndCollect(
        index,
        settleMs,
        collectMs,
        discardMs,
        gapMs,
        headMotion ? null : CALIBRATION_SAMPLING.targetSamples,
      );
    }, instructionMs);
  }

  /**
   * Dismiss the instruction card and go straight to the dot.
   *
   * Only valid during the 'instruct' phase — deliberately. Letting a keypress
   * skip a *settle* or *collect* phase would silently degrade the fit: settle
   * exists so the fixation has landed before sampling, and collect is the
   * sampling. A user mashing space to hurry things along would produce a
   * calibration that looks complete and is quietly worse, which is the failure
   * mode this whole diagnostic effort exists to eliminate.
   *
   * No-op in every other phase, so a stray keypress cannot corrupt a run.
   */
  skipInstruction(): void {
    if (!this.calibration.active || this.calibration.phase !== 'instruct') return;
    const index = this.calibration.currentIndex;
    if (index < 0 || index >= this.calibration.targets.length) return;

    this.clearCalibrationTimer();
    const headMotion = this.isHeadMotionIndex(index);
    const t = headMotion ? HEAD_MOTION_TIMING : CALIBRATION_TIMING;
    this.calibration = { ...this.calibration, phase: 'settle' };
    this.emitCalibration();
    this.runSettleAndCollect(
      index,
      t.settleMs,
      t.collectMs,
      t.discardMs,
      t.gapMs,
      headMotion ? null : CALIBRATION_SAMPLING.targetSamples,
    );
  }

  /**
   * The per-target sampling sequence, once any instruction card has cleared.
   *
   * `wantSamples` switches the collect phase from a fixed duration to "until we
   * have enough, or until the ceiling" — see `CALIBRATION_SAMPLING`. Passing
   * `null` keeps the original time-driven behaviour, which is what the
   * head-motion steps need.
   */
  private runSettleAndCollect(
    index: number,
    settleMs: number,
    collectMs: number,
    discardMs: number,
    gapMs: number,
    wantSamples: number | null = null,
  ): void {
    this.calibrationTimer = setTimeout(() => {
      if (!this.calibration.active) return;

      // Phase 2: collect, after discarding the leading saccade transit.
      this.calibration = { ...this.calibration, phase: 'collect' };
      this.emitCalibration();

      this.calibrationTimer = setTimeout(() => {
        if (!this.calibration.active) return;
        this.engine.setCalibrationTarget(index);

        const done = (): void => {
          if (!this.calibration.active) return;
          this.engine.setCalibrationTarget(null);
          this.calibration = {
            ...this.calibration,
            samples: this.engine.calibrationProgress(index),
          };
          this.emitCalibration();

          this.calibrationTimer = setTimeout(() => this.advanceCalibration(index + 1), gapMs);
        };

        if (wantSamples === null) {
          this.calibrationTimer = setTimeout(done, collectMs - discardMs);
          return;
        }

        // Count-driven. The nominal window is still the floor, so a fast camera
        // does not race through the dots faster than the eye can fixate them.
        const minMs = collectMs - discardMs;
        const startedAt = Date.now();
        const poll = (): void => {
          if (!this.calibration.active) return;
          const elapsed = Date.now() - startedAt;
          const enough =
            elapsed >= minMs && this.engine.calibrationProgress(index) >= wantSamples;
          if (enough || elapsed >= CALIBRATION_SAMPLING.maxCollectMs) {
            done();
            return;
          }
          // Surfacing the running count is what makes a starved camera visible
          // while it is happening rather than only in the post-mortem.
          this.calibration = {
            ...this.calibration,
            samples: this.engine.calibrationProgress(index),
          };
          this.emitCalibration();
          this.calibrationTimer = setTimeout(poll, CALIBRATION_SAMPLING.pollMs);
        };
        this.calibrationTimer = setTimeout(poll, CALIBRATION_SAMPLING.pollMs);
      }, discardMs);
    }, settleMs);
  }

  finishCalibration(): CalibrationReport {
    this.clearCalibrationTimer();
    try {
      const model = this.engine.finishCalibration(this.fingerprint);
      saveProfile(this.fingerprint, model as unknown as CalibrationProfile);
      return model.report as unknown as CalibrationReport;
    } catch (err) {
      // "needs at least 3 distinct targets, got 0" states the symptom and
      // nothing else — it cannot tell a camera that never delivered a frame
      // from one whose every frame was rejected, and those have opposite
      // fixes. The engine counted both, so say which happened.
      const d = this.engine.calibrationDiagnostics();
      console.error(
        `[calibration] failed — frames seen ${d.framesSeen}, stale ${d.framesStale}, ` +
          `accepted ${d.accepted}, rejected: noFace ${d.rejectedNoFace}, ` +
          `blinking ${d.rejectedBlinking}, lowQuality ${d.rejectedLowQuality}, ` +
          `unknownTarget ${d.rejectedUnknownTarget}`,
      );
      if (d.explanation) {
        const base = err instanceof Error ? err.message : String(err);
        throw new Error(`${base} — ${d.explanation}`);
      }
      throw err;
    } finally {
      // The fit can legitimately fail (too few samples, degenerate data). The
      // native side has already dropped its collector by then, so leaving the
      // bridge in a calibrating state would strand the UI *and* keep
      // Guard::Calibrating blocking control indefinitely.
      this.calibration = { ...IDLE_CALIBRATION };
      this.emitCalibration();
    }
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

  // ---- validation ----------------------------------------------------

  get validationUi(): ValidationUiState {
    return this.validation;
  }

  get validating(): boolean {
    return this.validation.active;
  }

  /**
   * Measure the loaded model against fresh fixations at points it was not
   * fitted to.
   *
   * Unlike calibration this collects nothing for the engine — it only watches
   * what the engine already predicts, so it never mutates the model. That is
   * what makes it safe to re-run as often as you like.
   *
   * Returns an empty array when there is nothing to validate.
   */
  startValidation(): Point[] {
    if (!this.engine.calibrated) return [];

    // Symmetric with startCalibration(), which already cancels validation.
    // Without this the calibration timer chain stays alive, keeps arming
    // targets into the collector, and — because the overlay renders
    // calibration in preference to validation — the user never even sees the
    // dots they are being scored against.
    if (this.calibration.active) this.cancelCalibration();

    this.clearValidationTimer();
    // Control stays off for the whole run: a cursor chasing your gaze while you
    // try to fixate a dot is a moving distractor, and it would contaminate the
    // very measurement being taken.
    this.setControlEnabled(false);

    const targets = validationTargets(primaryBounds());
    this.validationSamples = targets.map((t) => ({ target: t, raw: [], filtered: [] }));
    const cfg = this.engine.getConfig() as unknown as { minQuality?: number };
    this.validationMinQuality = cfg.minQuality ?? 0;

    this.validation = {
      ...IDLE_VALIDATION,
      active: true,
      targets,
      prompt: VALIDATION_PROMPT,
    };
    this.advanceValidation(0);
    return targets;
  }

  private advanceValidation(index: number): void {
    if (!this.validation.active) return;

    if (index >= this.validation.targets.length) {
      this.validationArmed = -1;
      // `active: false` at 'done', not just at finish. The run is over: nothing
      // more will be collected, so holding it "active" only kept control
      // blocked and Escape grabbed system-wide until the renderer happened to
      // call finishValidation(). If it never did — panel closed, window
      // reloaded, an exception in the report handler — the user was left unable
      // to enable control, with Escape swallowed app-wide, and nothing on
      // screen to explain why.
      //
      // `validationSamples` is deliberately untouched, so a later
      // finishValidation() still scores this run.
      this.validation = { ...this.validation, active: false, phase: 'done', currentIndex: -1 };
      this.emitValidation();
      return;
    }

    const { settleMs, collectMs, discardMs, gapMs } = VALIDATION_TIMING;

    this.validationArmed = -1;
    this.validation = { ...this.validation, currentIndex: index, phase: 'settle', samples: 0 };
    this.emitValidation();

    this.validationTimer = setTimeout(() => {
      if (!this.validation.active) return;
      this.validation = { ...this.validation, phase: 'collect' };
      this.emitValidation();

      // Discard the saccade transit before arming, exactly as calibration does
      // — samples taken in flight belong to the previous target.
      this.validationTimer = setTimeout(() => {
        if (!this.validation.active) return;
        this.validationArmed = index;

        this.validationTimer = setTimeout(() => {
          if (!this.validation.active) return;
          this.validationArmed = -1;
          this.validation = {
            ...this.validation,
            samples: this.validationSamples[index]?.raw.length ?? 0,
          };
          this.emitValidation();

          this.validationTimer = setTimeout(() => this.advanceValidation(index + 1), gapMs);
        }, collectMs - discardMs);
      }, discardMs);
    }, settleMs);
  }

  finishValidation(): ValidationReport {
    this.clearValidationTimer();
    this.validationArmed = -1;
    const cfg = this.engine.getConfig() as unknown as { pxPerDegree?: number };
    const report = summarizeValidation(this.validationSamples, cfg.pxPerDegree ?? 0);
    this.validation = { ...IDLE_VALIDATION };
    this.emitValidation();
    return report;
  }

  cancelValidation(): void {
    this.clearValidationTimer();
    this.validationArmed = -1;
    this.validationSamples = [];
    this.validation = { ...IDLE_VALIDATION };
    this.emitValidation();
  }

  private clearValidationTimer(): void {
    if (this.validationTimer) {
      clearTimeout(this.validationTimer);
      this.validationTimer = null;
    }
  }

  private emitValidation(): void {
    for (const cb of this.validationListeners) cb(this.validation);
  }

  // ---- debug probes --------------------------------------------------

  /**
   * The loaded model, for the debug HUD's per-axis pose-drift breakdown.
   *
   * The engine reports drift as one worst-axis number, which cannot say
   * *which* axis moved — and "sit up" versus "stop turning" versus "move back"
   * are different instructions (ADR-0015).
   */
  calibrationProfile(): CalibrationProfile | null {
    const m = this.engine.getCalibration();
    return m ? (m as unknown as CalibrationProfile) : null;
  }

  /**
   * Gaze-feature scatter from the last calibration run, with the fixation-grid
   * boundary so the debug view can exclude head-motion targets from its
   * separability metric.
   *
   * `headMotionFrom` and the engine's retained scatter have exactly the same
   * lifetime — both are set by a run and replaced by the next one — so they
   * cannot disagree about which targets were which.
   */
  calibrationScatter(): CalibrationScatter {
    const points = this.engine.calibrationScatter().map((p) => ({
      gx: p.gx,
      gy: p.gy,
      targetIndex: p.targetIndex,
      kept: p.kept,
    }));

    // -1 means the run had no head-motion phase, so every target was grid.
    const gridCount =
      this.headMotionFrom >= 0
        ? this.headMotionFrom
        : points.reduce((max, p) => Math.max(max, p.targetIndex + 1), 0);

    return { points, gridCount };
  }

  /**
   * Screen pixels per unit of iris offset, at the current head pose.
   *
   * Measured by central differences through the real model rather than read off
   * the coefficients, because the mapping is quadratic and has gaze×head cross
   * terms — the local gain genuinely depends on where you are looking and how
   * you are sitting, and the coefficient of `gx` alone would be wrong.
   *
   * `frame` is a live packed frame, so the probe is taken about the user's
   * actual current pose rather than an imagined neutral one.
   */
  gazeSensitivity(frame: Float64Array): GazeSensitivity {
    const NONE: GazeSensitivity = { pxPerGx: Number.NaN, pxPerGy: Number.NaN, calibrated: false };
    if (!this.engine.calibrated || frame.length !== FRAME_WIDTH) return NONE;

    // Step size: small enough to stay local, large enough that the difference
    // is not lost in f64 rounding of a ~1000 px prediction.
    const H = 0.01;
    const probe = (slot: number, delta: number): Point | null => {
      const copy = Float64Array.from(frame);
      copy[slot] = (copy[slot] ?? 0) + delta;
      // Force a valid face, so the probe works even mid-blink.
      copy[FRAME_SLOTS.OK] = 1;
      return this.engine.predictFrame(copy);
    };

    const gxPlus = probe(FRAME_SLOTS.GX, H);
    const gxMinus = probe(FRAME_SLOTS.GX, -H);
    const gyPlus = probe(FRAME_SLOTS.GY, H);
    const gyMinus = probe(FRAME_SLOTS.GY, -H);
    if (!gxPlus || !gxMinus || !gyPlus || !gyMinus) return NONE;

    return {
      // Magnitude of the displacement, not just the x component: tilting the
      // head makes a horizontal eye movement move the cursor diagonally, and
      // the noise budget cares about total distance.
      pxPerGx: Math.hypot(gxPlus.x - gxMinus.x, gxPlus.y - gxMinus.y) / (2 * H),
      pxPerGy: Math.hypot(gyPlus.x - gyMinus.x, gyPlus.y - gyMinus.y) / (2 * H),
      calibrated: true,
    };
  }
}

/**
 * Map the camelCase UI patch onto the native config shape.
 *
 * Driven by `TUNING_GROUPS` rather than a hand-written list of `if`s. The list
 * form silently dropped `calibration` when ADR-0021 added it, and a dropped
 * group is invisible: the patch is well-formed, the IPC call succeeds, the
 * setting persists, and only the engine never hears about it. Iterating a
 * checked constant makes forgetting a group a typecheck failure instead.
 *
 * `pxPerDegree` stays separate because it is a scalar, not a group.
 */
function toNativePatch(t: TuningPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const group of TUNING_GROUPS) {
    const value = t[group];
    if (value) out[group] = value;
  }
  if (t.pxPerDegree !== undefined) out['pxPerDegree'] = t.pxPerDegree;
  return out;
}
