/**
 * A diagnostics bundle — the numbers from ADR-0018, in a form that can leave
 * the machine (ADR-0024).
 *
 * ADR-0018 built six views that produce genuinely diagnostic figures, and then
 * drew every one of them onto a canvas, where they died. That is fine while the
 * person with the camera is also the person who can act on the numbers. It is
 * useless the moment those are two different people, and every accuracy
 * conversation in the issue tracker degrades into prose descriptions of a
 * picture — "the arrows kind of point up-left" — which is the exact ambiguity
 * ADR-0018 exists to eliminate.
 *
 * ## This file contains numbers and nothing else
 *
 * **No images. No landmark coordinates. Nothing from which a face could be
 * reconstructed.** That is not an accident of what happened to be convenient; it
 * is the property that makes the bundle safe to paste into a public issue
 * without stopping to think, and it is enforced structurally: every field below
 * is copied by name from a typed input, so an object that happens to carry a
 * thumbnail cannot leak one through a spread. `bundle.test.ts` asserts it.
 *
 * This is the **opposite posture** from the session recorder (ADR-0022), which
 * writes PNGs of the user's eyes, is off at every launch, and never leaves the
 * machine. Both are deliberate and they are not in tension: one is designed to
 * be shared and therefore must carry no pixels, the other carries pixels and
 * therefore must never be shared. If you are here to add "just a small
 * thumbnail, for context" — that belongs in a recording, not in this file.
 *
 * ## Everything here is pure
 *
 * No Electron, no DOM, no I/O, following `validation/stats.ts`. The caller
 * gathers, this module shapes, and someone else writes the bytes.
 */

import type {
  CalibrationReport,
  CameraLockStatus,
  Point,
  ScreenBounds,
} from '../types.js';
import type { ValidationReport, ValidationTargetResult } from '../validation/stats.js';

/**
 * Bumped whenever a field changes meaning rather than merely being added.
 *
 * The whole point of an exported bundle is that it outlives the build that
 * produced it: someone will paste one into an issue and someone else will read
 * it three months and nine PRs later. A reader that can see the version can at
 * least know *which* meaning of `precisionPx` it is looking at; one that cannot
 * has to guess, and will guess wrong exactly when it matters.
 */
export const DIAGNOSTICS_SCHEMA = 'eye-tracker/diagnostics-bundle@1';

// ---------------------------------------------------------------------------
// Derived signal figures
// ---------------------------------------------------------------------------

/**
 * How many distinguishable positions the signal can resolve across its range.
 *
 * The honest summary of the whole pipeline's ceiling: ten means roughly ten
 * separable columns — a screen split into a coarse grid, not a pointer.
 *
 * Defined here rather than in the renderer's `debug/signal-stats.ts` (which
 * re-exports it) purely so that there is one definition. The bundle has to
 * carry this number — for a cold reader it is the single most decisive field —
 * and a second copy of `travel / noise` would be free to drift from the one the
 * user is looking at on screen while they file the report.
 */
export function resolvableSteps(travel: number, noise: number): number {
  if (!Number.isFinite(travel) || !Number.isFinite(noise) || noise <= 0) return Number.NaN;
  return travel / noise;
}

/**
 * The raw signal measurements, as the renderer's `SignalStats` produces them,
 * plus the sensitivity probe that converts them into cursor pixels.
 *
 * Structurally compatible with `SignalSummary` by design; the renderer's call
 * site is what typechecks that. Deliberately not an `extends` of it, because
 * `SignalStats` is a rolling buffer that belongs to the debug panel and moving
 * it here to share one interface would drag a stateful class into a package of
 * pure functions for no gain.
 */
export interface SignalSnapshot {
  /** Quiet-period standard deviation of gx/gy, in feature units. */
  noiseGx: number;
  noiseGy: number;
  /** Full range seen since the last reset — the usable signal span. */
  travelGx: number;
  travelGy: number;
  /** Mean absolute per-eye disagreement. High means one iris is mis-fit. */
  meanDgx: number;
  /** Frames backing the estimate. Below ~60 the numbers have not settled. */
  samples: number;
  /** Screen px per unit of iris offset, probed through the live model. */
  pxPerGx: number;
  pxPerGy: number;
}

/**
 * The signal section, with the conversions already applied.
 *
 * This is the highest-value section in the bundle for someone reading it cold,
 * and it is the reason the bundle is worth building at all. `noiseGx` alone
 * means nothing to a reader; multiplied by `pxPerGx` it becomes "the cursor
 * cannot sit still to better than 90 px", which decides whether the complaint is
 * *"the sensor cannot resolve the iris"* or *"the mapping is wrong"* — the one
 * distinction ADR-0018 was written to make, and the one that sends the user to
 * buy a camera versus recalibrate.
 *
 * The conversions are done here rather than left to the reader because a reader
 * who has to do arithmetic to reach the finding will not do it.
 */
export interface DiagnosticsSignal {
  noiseGx: number | null;
  noiseGy: number | null;
  travelGx: number | null;
  travelGy: number | null;
  meanDgx: number | null;
  samples: number;
  pxPerGx: number | null;
  pxPerGy: number | null;
  /** Noise floor in cursor pixels, per axis and combined isotropically. */
  noisePxX: number | null;
  noisePxY: number | null;
  noisePx: number | null;
  resolvableStepsX: number | null;
  resolvableStepsY: number | null;
  /**
   * False until the signal estimate has settled (~60 frames) — below that the
   * numbers above are still moving and should not be quoted.
   */
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface DiagnosticsEnvironment {
  platform: string;
  arch: string;
  /**
   * Which display layout the pixel figures are expressed in. A calibration is
   * layout-specific (ADR-0006), so two bundles with different fingerprints are
   * not directly comparable however similar their numbers look.
   */
  displayFingerprint: string;
  displayBounds: ScreenBounds | null;
  delegate: string;
  /** Model inference time, ms, smoothed. */
  inferenceMs: number | null;
  cameraFps: number | null;
  engineFps: number | null;
  /** Tracking confidence at the instant of capture — a spot reading, not a mean. */
  qualityAtCapture: number | null;
  poseDriftAtCapture: number | null;
  headCompensated: boolean | null;
  guardReason: string | null;
}

/**
 * The knobs that exist so a change can be turned off and compared.
 *
 * A strict projection of `tuning` — the same values, hoisted, never sourced
 * independently, so the two cannot disagree (`bundle.test.ts` asserts that).
 * The duplication buys the thing the bundle exists for: two bundles from the
 * same person with one feature flipped differ in a handful of lines near the top
 * of the file instead of somewhere in the middle of forty tuning keys.
 */
export const AB_SWITCH_KEYS = [
  /** ADR-0021 — weight the calibration fit by tracking quality. */
  'qualityWeighting',
  'weightFloor',
  /** ADR-0023 — let per-frame confidence modulate the filter. */
  'confidenceTrust',
  'trustFloor',
  /** ADR-0025 — where vertical gaze is measured from, and what modulates it. */
  'apertureVertical',
  'opennessTerms',
  'axisSpecificVertical',
  /** ADR-0014 — the spread-adaptive fixation clamp. */
  'adaptiveClamp',
  'clampNoiseScale',
  /** ADR-0016 — yield to a physical pointer. */
  'takeoverEnabled',
  /** The cliff ADR-0023 sits above; it changes what "usable frame" means. */
  'minQuality',
  /** Every degree figure in the bundle is divided by this. */
  'pxPerDegree',
] as const;

export type AbSwitchKey = (typeof AB_SWITCH_KEYS)[number];

/** One validation target, flattened and with the degree conversions applied. */
export interface DiagnosticsTarget {
  target: Point;
  samples: number;
  mean: Point;
  /**
   * Centroid minus target — the systematic error **with its direction**, which
   * is the whole content of the arrow map. A magnitude alone cannot tell
   * "everything is shifted up-left" from "the corners splay outward", and those
   * have different fixes.
   */
  bias: Point;
  /** The bias vector as a compass word, so the pattern is legible unaided. */
  biasDirection: string;
  accuracyPx: number | null;
  accuracyDeg: number | null;
  precisionPx: number | null;
  precisionDeg: number | null;
  filteredPrecisionPx: number | null;
  sdX: number | null;
  sdY: number | null;
  /**
   * The raw prediction cloud, only when the exporter was asked for it.
   *
   * Screen coordinates of a cursor estimate — not landmarks, not anything about
   * the face. They are here so a reader can re-derive every statistic above
   * rather than trusting ours, which is worth a lot when the disagreement is
   * about whether the statistics are right. Off by default because they are
   * ~90% of the bytes.
   */
  cloud?: Point[];
}

export interface DiagnosticsValidation {
  targets: DiagnosticsTarget[];
  dropped: number;
  meanAccuracyPx: number | null;
  meanAccuracyDeg: number | null;
  p95AccuracyPx: number | null;
  meanPrecisionPx: number | null;
  meanPrecisionDeg: number | null;
  meanFilteredPrecisionPx: number | null;
  worstIndex: number;
  pxPerDegree: number | null;
  accuracyVerdict: string;
  precisionVerdict: string;
  advice: string;
  /**
   * What the arrow map *looks like*, in words.
   *
   * The picture is the thing a remote reader cannot have, and the four patterns
   * it makes legible (see `debug/validation-view.ts`) each imply a different
   * remedy. Stating the pattern here is what lets someone reach the same
   * conclusion from the file that the user reaches from the canvas.
   */
  biasPattern: string;
  /** Mean bias vector — near zero for a splay, large for a uniform offset. */
  meanBias: Point;
}

/**
 * ADR-0021's weight fields are optional on `CalibrationReport` because a
 * profile saved before that ADR does not carry them. They stay optional here
 * for the same reason, and their absence is itself information: it means the
 * fit was unweighted.
 */
export interface DiagnosticsCalibration {
  tierName: string;
  samples: number;
  targets: number;
  meanErrorPx: number | null;
  p95ErrorPx: number | null;
  meanErrorDeg: number | null;
  perTargetErrorPx: Array<number | null>;
  lambdaX: number | null;
  lambdaY: number | null;
  crossValidated: boolean;
  qualityWeighted: boolean | null;
  meanWeight: number | null;
  minWeight: number | null;
  effectiveSamples: number | null;
  /** Which reference `gy` was measured against (ADR-0025). */
  verticalBasis: string | null;
  opennessTerms: boolean | null;
  axisSpecific: boolean | null;
  openRef: number | null;
  /**
   * Predicted vertical spread over the calibration targets, as a fraction of
   * the targets' own — the number #57 asked to be reported.
   *
   * It answers a question mean error cannot: whether the vertical channel is
   * merely inaccurate or has collapsed to a constant. 0.03 means the model
   * returns the same y wherever the user looks.
   */
  verticalRangeFraction: number | null;
}

export interface DiagnosticsBundle {
  schemaVersion: string;
  capturedIso: string;
  appVersion: string;
  environment: DiagnosticsEnvironment;
  camera: CameraLockStatus | null;
  /** Hoisted from `tuning` so an A/B diff is a handful of lines. */
  abSwitches: Partial<Record<AbSwitchKey, number | boolean | string>>;
  signal: DiagnosticsSignal | null;
  calibration: DiagnosticsCalibration | null;
  validation: DiagnosticsValidation | null;
  /** Read back from the engine, so it is what Rust was running, not what the UI thinks. */
  tuning: Record<string, number | boolean | string>;
  /**
   * What is missing and why.
   *
   * A bundle is never refused — a user reporting "it is inaccurate" before they
   * have managed to calibrate is reporting the *most* interesting failure, and
   * an export that declined to produce anything would drop exactly that case on
   * the floor. Every absent section names itself here instead, so a reader can
   * tell "not measured" from "measured and fine".
   */
  notes: string[];
}

/** What the caller has to gather. Every field is optional in the useful sense. */
export interface DiagnosticsInput {
  capturedIso: string;
  appVersion: string;
  platform: string;
  arch: string;
  displayFingerprint: string;
  displayBounds: ScreenBounds | null;
  camera: CameraLockStatus | null;
  vision: {
    delegate: string;
    inferenceMs: number;
    cameraFps: number;
    quality: number;
  } | null;
  engine: {
    fps: number;
    poseDrift: number;
    headCompensated: boolean;
    calibrated: boolean;
    guardReason: string;
  } | null;
  signal: SignalSnapshot | null;
  /** The engine's own view of its config, flat and camelCased. */
  tuning: Record<string, unknown>;
  calibration: CalibrationReport | null;
  validation: ValidationReport | null;
  /** Include the raw per-target prediction clouds. Multiplies the size by ~10. */
  includeClouds: boolean;
}

/**
 * The half of the bundle only the camera-facing renderer can see.
 *
 * The signal statistics live in the debug panel (ADR-0018 keeps landmarks
 * renderer-local, and the noise floor is computed from them), the camera lock is
 * negotiated by `getUserMedia`, and the last validation report is held there
 * because main hands it over and forgets it. Everything else — the engine's
 * effective config, the calibration model, the app version, the display layout —
 * main is the authority on, and reads for itself.
 */
export interface DiagnosticsRendererState {
  camera: CameraLockStatus | null;
  vision: DiagnosticsInput['vision'];
  signal: SignalSnapshot | null;
  validation: ValidationReport | null;
  includeClouds: boolean;
}

/** What the export action reports back to the UI. */
export interface DiagnosticsExportResult {
  /** Absolute path of the file that was written. */
  path: string;
  bytes: number;
  /** The compact summary, which is also what was put on the clipboard. */
  summary: string;
  /** False when the clipboard could not be written; the file still exists. */
  copied: boolean;
}

// ---------------------------------------------------------------------------
// Number handling
// ---------------------------------------------------------------------------

/**
 * Round, and turn every non-finite value into `null`.
 *
 * Two reasons, and both are about the reader.
 *
 * **NaN.** JSON has no NaN, so `JSON.stringify` writes `null` regardless. Doing
 * it here makes the *type* say so, which means a consumer's typechecker sees
 * what the file actually contains rather than a `number` that is sometimes not
 * one. `meanAccuracyDeg` is NaN whenever the display geometry was unavailable,
 * and that is a normal outcome, not a bug (ADR-0018).
 *
 * **Rounding.** Two bundles from the same person with one flag flipped should
 * differ only where the flag mattered. Unrounded f64s differ in the seventeenth
 * digit on every line, which turns a two-line diff into a hundred-line one and
 * buries the finding. The digit counts below are chosen so nothing legible is
 * lost: pixels to 0.01 is a hundredth of a pixel, feature units to 6 places is
 * well under the noise floor of a good camera (~0.004).
 */
function num(value: number | undefined | null, digits: number): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  // `+0` normalises -0, which JSON writes as `-0` and which reads as a sign
  // change in a diff when it is nothing of the kind.
  return Math.round(value * scale) / scale + 0;
}

/** Pixel-space quantities: cursor coordinates, errors, standard deviations. */
const px = (v: number | undefined | null) => num(v, 2);
/** Degrees of visual angle. Three places is ~0.06 px at a typical scale. */
const dg = (v: number | undefined | null) => num(v, 3);
/** Raw gaze-feature units, whose useful range is ~0.5 in total. */
const feat = (v: number | undefined | null) => num(v, 6);

function point(p: Point): Point {
  return { x: px(p.x) ?? 0, y: px(p.y) ?? 0 };
}

// ---------------------------------------------------------------------------
// Reading the arrow map without the picture
// ---------------------------------------------------------------------------

/**
 * The bias vector as a compass word, in screen coordinates (+y is *down*).
 *
 * Eight-way rather than sixteen: the reader is being told which remedy to reach
 * for, and no remedy differs between "up-left" and "up-up-left".
 */
export function biasDirection(bias: Point): string {
  if (!Number.isFinite(bias.x) || !Number.isFinite(bias.y)) return 'unknown';
  const mag = Math.hypot(bias.x, bias.y);
  // Under a pixel there is no direction to speak of, and naming one would
  // invent a finding out of rounding.
  if (mag < 1) return 'centred';

  const vertical = Math.abs(bias.y) > mag * 0.383 ? (bias.y > 0 ? 'down' : 'up') : '';
  const horizontal = Math.abs(bias.x) > mag * 0.383 ? (bias.x > 0 ? 'right' : 'left') : '';
  return [vertical, horizontal].filter(Boolean).join('-') || 'centred';
}

/**
 * Name the shape the arrows make.
 *
 * `debug/validation-view.ts` documents four readings of the error map, each
 * with a different remedy. A remote reader has the numbers but not the picture,
 * so the shape is computed rather than left to be inferred — a list of thirteen
 * bias vectors is not something a human pattern-matches reliably, and getting it
 * wrong sends the user to the wrong fix.
 *
 * The screen centre is taken as the centroid of the tested targets rather than
 * from display bounds: the validation grid is symmetric about the work area
 * (`validation/protocol.ts`), so the centroid is the same point, and deriving it
 * from the data means the description is still right if the grid ever changes.
 */
export function describeBiasPattern(targets: readonly ValidationTargetResult[]): string {
  if (targets.length < 3) return 'too few points to read a pattern';

  const n = targets.length;
  const meanBias = {
    x: targets.reduce((s, t) => s + t.bias.x, 0) / n,
    y: targets.reduce((s, t) => s + t.bias.y, 0) / n,
  };
  const centre = {
    x: targets.reduce((s, t) => s + t.target.x, 0) / n,
    y: targets.reduce((s, t) => s + t.target.y, 0) / n,
  };

  const accs = targets.map((t) => t.accuracyPx).filter((v) => Number.isFinite(v));
  if (accs.length === 0) return 'no scored points';
  const meanAcc = accs.reduce((a, b) => a + b, 0) / accs.length;
  if (meanAcc < 1) return 'no measurable bias anywhere — the mapping is as good as this test can see';

  // Mean radial component: how much of each bias points away from the centre.
  // Positive means outward, negative inward.
  let radial = 0;
  let radialPoints = 0;
  for (const t of targets) {
    const rx = t.target.x - centre.x;
    const ry = t.target.y - centre.y;
    const r = Math.hypot(rx, ry);
    // The centre target has no radial direction, so it cannot vote on one.
    if (r < 1) continue;
    radial += (t.bias.x * rx + t.bias.y * ry) / r;
    radialPoints++;
  }
  radial = radialPoints > 0 ? radial / radialPoints : 0;

  const uniformity = Math.hypot(meanBias.x, meanBias.y) / meanAcc;
  const radiality = radial / meanAcc;

  // One bad point, tested first and on its own evidence.
  //
  // A single large outlier drags the mean bias with it, so it also scores high
  // on uniformity — checking uniformity first would report "everything is
  // displaced the same way" for a run where twelve of thirteen points are fine.
  // The discriminator is the *spread* of the accuracies rather than their
  // direction: a genuinely uniform offset puts every point within a small factor
  // of the median, while a missed calibration dot leaves one point several times
  // worse than the rest.
  const sorted = [...accs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  if (median > 0 && worst > median * 3) {
    return (
      'one point is far worse than the rest while the others are consistent — usually a ' +
      'calibration dot that was never properly fixated, not a model problem'
    );
  }

  if (uniformity > 0.7) {
    // Phrased as a description rather than an instruction, and so are the arms
    // below. The pattern is a fact about the arrows; whether it is worth acting
    // on is `advice`'s job, which knows the verdict bands. A run can perfectly
    // well be graded good *and* have a uniform offset — saying "recalibrate" in
    // that case would contradict the line above it.
    return (
      `a uniform offset ${biasDirection(meanBias)} — every point is displaced the same way, ` +
      'which is what sitting differently than you calibrated looks like; recalibrating in ' +
      'your normal pose is what removes it'
    );
  }
  if (radiality > 0.5) {
    return (
      'errors splay outward from the centre — the quadratic terms are under-fitting the ' +
      'periphery, which a 9-point calibration and precise fixation of the outermost dots is ' +
      'what corrects'
    );
  }
  if (radiality < -0.5) {
    return (
      'errors point inward toward the centre — the model is compressing the periphery, ' +
      'usually a sign the eccentric calibration dots were under-fixated'
    );
  }
  return (
    'no consistent direction — the errors are scattered, which points at signal noise rather ' +
    'than at the mapping, so the noise floor and the precision figures are where to look first'
  );
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Copy the engine's config, keeping only primitives.
 *
 * `getConfig()` is a napi object of numbers, booleans and one string today, but
 * this bundle is meant to be pasteable without inspection, so the filter is a
 * standing guarantee rather than a description of the current shape: nothing
 * structured, and no string long enough to be an encoded payload, can reach the
 * output by someone later widening the napi surface.
 */
function safeTuning(raw: Record<string, unknown>): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = num(value, 6) ?? 0;
    else if (typeof value === 'string' && value.length <= 64) out[key] = value;
  }
  return out;
}

function buildSignal(s: SignalSnapshot): DiagnosticsSignal {
  const noisePxX = s.noiseGx * s.pxPerGx;
  const noisePxY = s.noiseGy * s.pxPerGy;
  return {
    noiseGx: feat(s.noiseGx),
    noiseGy: feat(s.noiseGy),
    travelGx: feat(s.travelGx),
    travelGy: feat(s.travelGy),
    meanDgx: feat(s.meanDgx),
    samples: s.samples,
    pxPerGx: px(s.pxPerGx),
    pxPerGy: px(s.pxPerGy),
    noisePxX: px(noisePxX),
    noisePxY: px(noisePxY),
    // Isotropic: what matters is how far the cursor is from where it was meant
    // to be, not either axis alone.
    noisePx: px(Math.hypot(noisePxX, noisePxY)),
    resolvableStepsX: num(resolvableSteps(s.travelGx, s.noiseGx), 1),
    resolvableStepsY: num(resolvableSteps(s.travelGy, s.noiseGy), 1),
    // The same threshold the eye-zoom readout uses to say "measuring…".
    settled: s.samples >= 60,
  };
}

function buildTarget(
  t: ValidationTargetResult,
  pxPerDegree: number,
  includeCloud: boolean,
): DiagnosticsTarget {
  const scale = pxPerDegree > 0 ? pxPerDegree : Number.NaN;
  const out: DiagnosticsTarget = {
    target: point(t.target),
    samples: t.samples,
    mean: point(t.mean),
    bias: point(t.bias),
    biasDirection: biasDirection(t.bias),
    accuracyPx: px(t.accuracyPx),
    accuracyDeg: dg(t.accuracyPx / scale),
    precisionPx: px(t.precisionPx),
    precisionDeg: dg(t.precisionPx / scale),
    filteredPrecisionPx: px(t.filteredPrecisionPx),
    sdX: px(t.sdX),
    sdY: px(t.sdY),
  };
  if (includeCloud) out.cloud = t.cloud.map(point);
  return out;
}

function buildValidation(r: ValidationReport, includeClouds: boolean): DiagnosticsValidation {
  const n = Math.max(1, r.targets.length);
  return {
    targets: r.targets.map((t) => buildTarget(t, r.pxPerDegree, includeClouds)),
    dropped: r.dropped,
    meanAccuracyPx: px(r.meanAccuracyPx),
    meanAccuracyDeg: dg(r.meanAccuracyDeg),
    p95AccuracyPx: px(r.p95AccuracyPx),
    meanPrecisionPx: px(r.meanPrecisionPx),
    meanPrecisionDeg: dg(r.meanPrecisionDeg),
    meanFilteredPrecisionPx: px(r.meanFilteredPrecisionPx),
    worstIndex: r.worstIndex,
    pxPerDegree: px(r.pxPerDegree),
    accuracyVerdict: r.accuracyVerdict,
    precisionVerdict: r.precisionVerdict,
    advice: r.advice,
    biasPattern: describeBiasPattern(r.targets),
    meanBias: point({
      x: r.targets.reduce((s, t) => s + t.bias.x, 0) / n,
      y: r.targets.reduce((s, t) => s + t.bias.y, 0) / n,
    }),
  };
}

function buildCalibration(c: CalibrationReport): DiagnosticsCalibration {
  return {
    tierName: c.tierName,
    samples: c.samples,
    targets: c.targets,
    meanErrorPx: px(c.meanErrorPx),
    p95ErrorPx: px(c.p95ErrorPx),
    meanErrorDeg: dg(c.meanErrorDeg),
    perTargetErrorPx: (c.perTargetErrorPx ?? []).map(px),
    // Ridge λ spans orders of magnitude, so it is kept at six places rather
    // than rounded like a pixel figure — 0.0001 and 0.001 are different fits.
    lambdaX: num(c.lambdaX, 6),
    lambdaY: num(c.lambdaY, 6),
    crossValidated: c.crossValidated,
    // `null`, not `false`: a profile from before ADR-0021 does not say, and
    // "we do not know" is a different fact from "it was unweighted".
    qualityWeighted: c.qualityWeighted ?? null,
    meanWeight: num(c.meanWeight, 4),
    minWeight: num(c.minWeight, 4),
    effectiveSamples: num(c.effectiveSamples, 1),
    // `null` again for a profile from before ADR-0025: it was fitted on the
    // corner basis, but it did not record the fact and inventing the record
    // would make a diff between two bundles say something that was not measured.
    verticalBasis: c.verticalBasis ?? null,
    opennessTerms: c.opennessTerms ?? null,
    axisSpecific: c.axisSpecific ?? null,
    openRef: num(c.openRef, 4),
    verticalRangeFraction: num(c.verticalRangeFraction, 3),
  };
}

/**
 * Shape the gathered state into the bundle.
 *
 * Every field is copied by name. There is no `...spread` of a caller-supplied
 * object anywhere in this function, and there must not be one: a spread is how
 * a thumbnail, a landmark array or a base64 blob would get in without anybody
 * deciding that it should.
 */
export function buildDiagnosticsBundle(input: DiagnosticsInput): DiagnosticsBundle {
  const tuning = safeTuning(input.tuning);

  const abSwitches: Partial<Record<AbSwitchKey, number | boolean | string>> = {};
  for (const key of AB_SWITCH_KEYS) {
    const value = tuning[key];
    if (value !== undefined) abSwitches[key] = value;
  }

  const notes: string[] = [];
  if (!input.calibration) {
    notes.push(
      'No calibration report — nothing has been calibrated on this display layout yet, or the ' +
        'stored profile predates the current build. The signal and tuning sections below are ' +
        'still valid and are the ones that matter for "it never worked at all".',
    );
  }
  if (!input.validation) {
    notes.push(
      'No validation run — accuracy and precision have not been measured at points the model ' +
        'was not fitted to. The calibration error, if present, only scores the dots that were ' +
        'looked at during the fit and is optimistic by construction (ADR-0018).',
    );
  }
  if (!input.signal) {
    notes.push('No signal statistics — the debug panel has not been opened this session.');
  } else if (input.signal.samples < 60) {
    notes.push(
      `Signal statistics are from only ${input.signal.samples} frames and have not settled; ` +
        'the noise floor is not yet trustworthy below about 60.',
    );
  } else if (!Number.isFinite(input.signal.pxPerGx)) {
    notes.push(
      'The noise floor could not be converted to cursor pixels because no model was loaded to ' +
        'probe for sensitivity. The raw gx/gy figures are still comparable between bundles.',
    );
  }
  if (!input.camera) {
    notes.push('The camera did not report its format or exposure mode.');
  } else if (input.camera.exposureMode !== 'manual') {
    notes.push(
      `Camera exposure is "${input.camera.exposureMode ?? 'unreported'}", not locked. ` +
        'Auto-exposure re-meters to whatever is on screen, which is correlated with where the ' +
        'user is looking, so this session is not directly comparable with a locked one (ADR-0022).',
    );
  }
  if (input.validation && input.validation.dropped > 0) {
    notes.push(
      `${input.validation.dropped} validation point(s) were dropped for too few usable samples — ` +
        'tracking was lost there, so the means below are taken over the surviving points only.',
    );
  }

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA,
    capturedIso: input.capturedIso,
    appVersion: input.appVersion,
    environment: {
      platform: input.platform,
      arch: input.arch,
      displayFingerprint: input.displayFingerprint,
      displayBounds: input.displayBounds
        ? {
            x: Math.round(input.displayBounds.x),
            y: Math.round(input.displayBounds.y),
            width: Math.round(input.displayBounds.width),
            height: Math.round(input.displayBounds.height),
          }
        : null,
      delegate: input.vision?.delegate ?? 'unknown',
      inferenceMs: num(input.vision?.inferenceMs, 2),
      cameraFps: num(input.vision?.cameraFps, 1),
      engineFps: num(input.engine?.fps, 1),
      qualityAtCapture: num(input.vision?.quality, 3),
      poseDriftAtCapture: num(input.engine?.poseDrift, 2),
      headCompensated: input.engine?.headCompensated ?? null,
      guardReason: input.engine?.guardReason ?? null,
    },
    camera: input.camera
      ? {
          width: input.camera.width,
          height: input.camera.height,
          frameRate: num(input.camera.frameRate, 2) ?? 0,
          exposureMode: input.camera.exposureMode,
          exposureTimeMs: num(input.camera.exposureTimeMs, 3),
        }
      : null,
    abSwitches,
    signal: input.signal ? buildSignal(input.signal) : null,
    calibration: input.calibration ? buildCalibration(input.calibration) : null,
    validation: input.validation ? buildValidation(input.validation, input.includeClouds) : null,
    tuning,
    notes,
  };
}

/**
 * Serialize for the file.
 *
 * Indented, because the file's whole job is to be read by a person and attached
 * to an issue. The size cost is real but so is the readability, and the clouds
 * flag is the lever that actually controls the size.
 */
export function serializeBundle(bundle: DiagnosticsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * `diagnostics-20260725-143205.json` — sortable and readable in a file listing.
 *
 * Local time rather than UTC, matching `sessionIdFor` in the recording schema:
 * the person looking for "the one I exported just now" is in the local timezone,
 * and `capturedIso` inside the file carries the absolute instant.
 */
export function diagnosticsFileName(at: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `diagnostics-${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.json`
  );
}

// ---------------------------------------------------------------------------
// The compact summary
// ---------------------------------------------------------------------------

/**
 * A ~25-line reading of the bundle, for the clipboard and for `scripts/`.
 *
 * The full bundle is 6–10 KB without clouds and upwards of 80 KB with them.
 * Both are fine as a file attachment and neither is something a person will
 * read in a comment box, so the clipboard gets this instead: the numbers a
 * reader needs to form a first opinion, in the order they need them, with the
 * path to the full file at the bottom.
 *
 * One formatter for both consumers on purpose. If the terminal tool and the
 * clipboard could disagree about what a bundle says, a conversation could
 * proceed for several rounds with the two participants looking at different
 * summaries of the same file.
 */
export function formatBundleSummary(bundle: DiagnosticsBundle, filePath?: string): string {
  const lines: string[] = [];
  const n = (v: number | null | undefined, digits = 0, unit = '') =>
    v === null || v === undefined ? '—' : `${v.toFixed(digits)}${unit}`;

  lines.push('— eye-tracker diagnostics —');
  lines.push(
    `${bundle.schemaVersion} · app ${bundle.appVersion} · ` +
      `${bundle.environment.platform}/${bundle.environment.arch} · ${bundle.capturedIso}`,
  );
  lines.push('');

  const sw = bundle.abSwitches;
  const flag = (key: AbSwitchKey) => {
    const v = sw[key];
    return v === undefined ? `${key}=?` : `${key}=${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`;
  };
  lines.push('A/B switches');
  lines.push(`  ${flag('qualityWeighting')}  ${flag('weightFloor')}`);
  lines.push(`  ${flag('confidenceTrust')}  ${flag('trustFloor')}`);
  lines.push(`  ${flag('adaptiveClamp')}  ${flag('clampNoiseScale')}  ${flag('minQuality')}`);
  lines.push('');

  const c = bundle.camera;
  lines.push('Camera & environment');
  lines.push(
    `  ${c && c.width > 0 ? `${c.width}×${c.height} @ ${n(c.frameRate, 0)} fps` : 'format unreported'}` +
      ` · exposure ${c?.exposureMode ?? 'unreported'}` +
      (c?.exposureTimeMs != null ? ` (${n(c.exposureTimeMs, 1)} ms)` : ''),
  );
  lines.push(
    `  ${bundle.environment.delegate} delegate · inference ${n(bundle.environment.inferenceMs, 1, ' ms')}` +
      ` · camera ${n(bundle.environment.cameraFps, 1)} fps · engine ${n(bundle.environment.engineFps, 1)} fps`,
  );
  lines.push(`  displays ${bundle.environment.displayFingerprint || '(unknown)'}`);
  lines.push('');

  lines.push('Signal — can the sensor resolve the iris at all?');
  if (!bundle.signal) {
    lines.push('  not measured');
  } else {
    const s = bundle.signal;
    lines.push(
      `  noise floor ±${n(s.noisePx, 0, ' px')}  (gx ${n(s.noiseGx, 4)}, gy ${n(s.noiseGy, 4)})` +
        (s.settled ? '' : '   [NOT SETTLED]'),
    );
    lines.push(`  travel gx ${n(s.travelGx, 3)}  gy ${n(s.travelGy, 3)}`);
    lines.push(
      `  resolvable steps ${n(s.resolvableStepsX, 0)} × ${n(s.resolvableStepsY, 0)}` +
        `  ·  eye disagreement ${n(s.meanDgx, 4)}  ·  ${s.samples} frames`,
    );
    lines.push(`  sensitivity ${n(s.pxPerGx, 0)} px per unit gx, ${n(s.pxPerGy, 0)} px per gy`);
  }
  lines.push('');

  lines.push('Calibration — the fit, scored on its own dots (optimistic)');
  if (!bundle.calibration) {
    lines.push('  none on this display layout');
  } else {
    const k = bundle.calibration;
    lines.push(
      `  ${k.tierName} · ${k.samples} samples over ${k.targets} targets · ` +
        `held-out ${n(k.meanErrorPx, 0, ' px')} (${n(k.meanErrorDeg, 2, '°')}), p95 ${n(k.p95ErrorPx, 0, ' px')}`,
    );
    lines.push(
      `  λ ${n(k.lambdaX, 4)} / ${n(k.lambdaY, 4)} · ` +
        (k.crossValidated ? 'cross-validated' : 'NOT cross-validated — optimistic'),
    );
    // Printed unconditionally, and directly under the error line, because a
    // collapsed vertical channel is invisible in mean error and is the single
    // most useful thing to look at first (#57).
    lines.push(
      `  vertical: ${k.verticalBasis ?? 'not recorded'} basis, ` +
        `range ${n(k.verticalRangeFraction, 2)} of target span` +
        (k.opennessTerms ? ` · openness terms on (ref ${n(k.openRef, 3)})` : '') +
        (k.axisSpecific ? ' · reduced vertical column set' : ''),
    );
    if (k.qualityWeighted) {
      lines.push(
        `  quality-weighted: mean ${n(k.meanWeight, 2)}, worst ${n(k.minWeight, 2)} — ` +
          `worth ${n(k.effectiveSamples, 0)} of ${k.samples} frames`,
      );
    } else {
      lines.push(`  quality weighting: ${k.qualityWeighted === null ? 'not recorded' : 'off'}`);
    }
  }
  lines.push('');

  lines.push('Validation — measured at 13 points the model was NOT fitted to');
  if (!bundle.validation) {
    lines.push('  not run');
  } else {
    const v = bundle.validation;
    lines.push(
      `  accuracy  ${n(v.meanAccuracyPx, 0, ' px')} (${n(v.meanAccuracyDeg, 2, '°')})  ` +
        `[${v.accuracyVerdict}]   systematic — recalibration can fix this`,
    );
    lines.push(
      `  precision ±${n(v.meanPrecisionPx, 0, ' px')} (${n(v.meanPrecisionDeg, 2, '°')})  ` +
        `[${v.precisionVerdict}]   random — recalibration cannot`,
    );
    lines.push(
      `  after smoothing ±${n(v.meanFilteredPrecisionPx, 0, ' px')} · ` +
        `${v.targets.length} points scored, ${v.dropped} dropped · ${n(v.pxPerDegree, 1)} px/°`,
    );
    lines.push(`  mean bias ${n(v.meanBias.x, 0)}, ${n(v.meanBias.y, 0)} px`);
    lines.push(`  pattern: ${v.biasPattern}`);
    const worst = v.targets[v.worstIndex];
    if (worst) {
      lines.push(
        `  worst point ${n(worst.target.x, 0)},${n(worst.target.y, 0)} — ` +
          `off by ${n(worst.accuracyPx, 0, ' px')} ${worst.biasDirection}`,
      );
    }
    lines.push(`  advice: ${v.advice}`);
  }

  if (bundle.notes.length > 0) {
    lines.push('');
    lines.push('Notes');
    for (const note of bundle.notes) lines.push(`  · ${note}`);
  }

  lines.push('');
  lines.push(
    filePath
      ? `Full bundle (every per-target number): ${filePath}`
      : 'Full bundle: every per-target number is in the JSON this was read from.',
  );
  lines.push('This bundle contains numbers only — no images and no landmarks.');

  return lines.join('\n');
}
