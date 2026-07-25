/**
 * Calibration timing protocol (ADR-0006).
 *
 * The numbers exist for physiological reasons, not arbitrary ones: a saccade to
 * a new target plus the settling of the subsequent fixation takes a few hundred
 * milliseconds, and samples taken during that transit are of the wrong point.
 */

export const CALIBRATION_TIMING = {
  /** Target animates/shrinks to draw fixation before any sampling. */
  settleMs: 600,
  /** Total sampling duration per target. */
  collectMs: 700,
  /** Leading portion of the collect window thrown away as saccade transit. */
  discardMs: 200,
  /** Pause between targets. */
  gapMs: 150,
} as const;

/**
 * Head-motion targets run longer, because the user is sweeping their head
 * through a range rather than holding a single pose (ADR-0015).
 */
export const HEAD_MOTION_TIMING = {
  settleMs: 800,
  collectMs: 2600,
  discardMs: 300,
  gapMs: 250,
} as const;

/**
 * How long a full-screen instruction card is shown before its targets begin.
 *
 * This is not politeness, it is data quality. A head-motion target samples for
 * 2.6 s; if the user spends the first second of that reading the instruction
 * rather than moving, a third of the samples for that target carry no head
 * variation at all — and ridge then correctly shrinks the very cross-terms the
 * phase exists to identify (ADR-0015). The instruction has to land *before*
 * collection starts, not alongside it.
 */
export function instructionDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // ~3 words/second of reading, plus a beat to notice the screen changed and
  // look up from wherever the last dot was.
  const ms = 1300 + (words / 3) * 1000;
  return Math.max(2400, Math.min(7000, Math.round(ms)));
}

/** A full-screen instruction: short imperative headline, caveat underneath. */
export interface CalibrationInstruction {
  title: string;
  detail: string;
}

/**
 * Where the head-motion targets sit and what to ask for at each.
 *
 * Spread across the screen rather than all at centre so the fit sees head
 * movement combined with *different* gaze directions — which is exactly what
 * the gaze×head cross terms model.
 *
 * Each step carries a headline and a detail line. The headline is what the user
 * reads at a glance from across the room; the detail carries the constraint
 * that makes the movement useful, which is always the same one — the eyes must
 * stay on the dot while the head moves. Movement *with* the gaze teaches the
 * model nothing, because then head pose and gaze direction are confounded.
 */
export const HEAD_MOTION_STEPS = [
  {
    fx: 0.5,
    fy: 0.5,
    title: 'Turn your head slowly left and right',
    detail: 'Keep your eyes locked on the dot the whole time',
  },
  {
    fx: 0.2,
    fy: 0.5,
    title: 'Again — turn left and right',
    detail: 'Eyes stay on the dot, even as your head turns away from it',
  },
  {
    fx: 0.8,
    fy: 0.5,
    title: 'Now nod slowly up and down',
    detail: 'Keep your eyes locked on the dot the whole time',
  },
  {
    fx: 0.5,
    fy: 0.25,
    title: 'Lean closer, then back',
    detail: 'Move about 15 cm each way, eyes still on the dot',
  },
] as const;

export function headMotionTargets(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Array<{ x: number; y: number; title: string; detail: string; prompt: string }> {
  return HEAD_MOTION_STEPS.map((s) => ({
    x: bounds.x + bounds.width * s.fx,
    y: bounds.y + bounds.height * s.fy,
    title: s.title,
    detail: s.detail,
    // Kept short: this one is shown *under the dot* while sampling, as a
    // reminder of a card the user has already read.
    prompt: s.title,
  }));
}

export const FIXATION_PROMPT = 'Look at the dot and keep your head still';

export const FIXATION_INSTRUCTION: CalibrationInstruction = {
  title: 'Look at each dot as it appears',
  detail: 'Sit the way you normally would, and keep your head still for this part',
};

/** Samples we expect per target at a given camera rate, for progress UI. */
export function expectedSamples(cameraFps: number): number {
  const usableMs = CALIBRATION_TIMING.collectMs - CALIBRATION_TIMING.discardMs;
  return Math.max(1, Math.round((usableMs / 1000) * cameraFps));
}

/**
 * Total wall-clock duration of a calibration run, for the progress bar.
 *
 * Includes the instruction cards, which are a real and now sizeable part of the
 * run: one before the fixation dots, and one before each head-motion step that
 * asks for something new.
 */
export function totalDurationMs(targetCount: number, headMotionCount = 0): number {
  const { settleMs, collectMs, gapMs } = CALIBRATION_TIMING;
  const h = HEAD_MOTION_TIMING;

  const cards = [
    ...(targetCount > 0 ? [FIXATION_INSTRUCTION] : []),
    ...HEAD_MOTION_STEPS.slice(0, headMotionCount),
  ];
  // Mirrors `needsInstruction` in the bridge: consecutive identical cards
  // collapse into one, so a duration that counted them all would overstate.
  let cardMs = 0;
  let previous = '';
  for (const c of cards) {
    const key = `${c.title} ${c.detail}`;
    if (key !== previous) cardMs += instructionDurationMs(key);
    previous = key;
  }

  return (
    cardMs +
    targetCount * (settleMs + collectMs + gapMs) +
    headMotionCount * (h.settleMs + h.collectMs + h.gapMs)
  );
}

/**
 * The six head-pose features, in the order `GazeFrame::pose()` packs them.
 *
 * MIRRORED BY HAND from `POSE_STD_FLOOR` in `calibration/model.rs`. The engine
 * reports pose drift as a single worst-axis number, which is the right thing
 * for a guard but useless for diagnosis — "drift 4.2σ" does not tell you
 * whether to sit up, stop turning, or move back. These let the debug HUD say
 * which axis actually moved.
 */
export const POSE_AXES = [
  { key: 'yaw', label: 'Yaw (turn)', floor: 0.035, unit: 'deg' },
  { key: 'pitch', label: 'Pitch (nod)', floor: 0.035, unit: 'deg' },
  { key: 'roll', label: 'Roll (tilt)', floor: 0.035, unit: 'deg' },
  { key: 'hx', label: 'Position ←→', floor: 0.012, unit: 'frac' },
  { key: 'hy', label: 'Position ↑↓', floor: 0.012, unit: 'frac' },
  { key: 'hz', label: 'Distance', floor: 0.35, unit: 'inv' },
] as const;

export interface PoseAxisDrift {
  key: string;
  label: string;
  /** Distance from the calibration mean, in standard deviations. */
  sigma: number;
  /** Signed offset in the axis' own units, for a human-readable caption. */
  delta: number;
  unit: string;
}

/**
 * Per-axis head-pose drift against a fitted model.
 *
 * `pose` is [yaw, pitch, roll, hx, hy, hz] — the same order as `POSE_AXES`.
 * Returns an empty array when the profile has no pose statistics.
 */
export function poseDriftPerAxis(
  pose: readonly number[],
  poseMean: readonly number[],
  poseStd: readonly number[],
): PoseAxisDrift[] {
  if (poseMean.length < 6 || poseStd.length < 6) return [];
  return POSE_AXES.map((axis, i) => {
    const delta = (pose[i] ?? 0) - (poseMean[i] ?? 0);
    // Floor the spread, exactly as the engine does: a user who sat perfectly
    // still would otherwise divide by ~0 and every twitch would read as
    // enormous drift.
    const std = Math.max(poseStd[i] ?? 0, axis.floor);
    return { key: axis.key, label: axis.label, sigma: Math.abs(delta) / std, delta, unit: axis.unit };
  });
}

/**
 * Identifies a display layout. Because the model regresses directly to screen
 * pixels, a fit is only valid for the layout it was made on, so we fingerprint
 * it and invalidate on change (ADR-0006, ADR-0011).
 */
export function displayFingerprint(
  displays: ReadonlyArray<{
    id: number;
    bounds: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  }>,
): string {
  return displays
    .map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`)
    .sort()
    .join('|');
}
