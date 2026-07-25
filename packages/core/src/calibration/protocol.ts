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
 * Where the head-motion targets sit and what to ask for at each.
 *
 * Spread across the screen rather than all at centre so the fit sees head
 * movement combined with *different* gaze directions — which is exactly what
 * the gaze×head cross terms model.
 */
export const HEAD_MOTION_STEPS = [
  { fx: 0.5, fy: 0.5, prompt: 'Keep looking at the dot — turn your head slowly left and right' },
  { fx: 0.2, fy: 0.5, prompt: 'Keep looking at the dot — turn your head slowly left and right' },
  { fx: 0.8, fy: 0.5, prompt: 'Keep looking at the dot — nod slowly up and down' },
  { fx: 0.5, fy: 0.25, prompt: 'Keep looking at the dot — lean slightly closer, then back' },
] as const;

export function headMotionTargets(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Array<{ x: number; y: number; prompt: string }> {
  return HEAD_MOTION_STEPS.map((s) => ({
    x: bounds.x + bounds.width * s.fx,
    y: bounds.y + bounds.height * s.fy,
    prompt: s.prompt,
  }));
}

export const FIXATION_PROMPT = 'Look at the dot and keep your head still';

/** Samples we expect per target at a given camera rate, for progress UI. */
export function expectedSamples(cameraFps: number): number {
  const usableMs = CALIBRATION_TIMING.collectMs - CALIBRATION_TIMING.discardMs;
  return Math.max(1, Math.round((usableMs / 1000) * cameraFps));
}

/** Total wall-clock duration of a calibration run, for the progress bar. */
export function totalDurationMs(targetCount: number, headMotionCount = 0): number {
  const { settleMs, collectMs, gapMs } = CALIBRATION_TIMING;
  const h = HEAD_MOTION_TIMING;
  return (
    targetCount * (settleMs + collectMs + gapMs) +
    headMotionCount * (h.settleMs + h.collectMs + h.gapMs)
  );
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
