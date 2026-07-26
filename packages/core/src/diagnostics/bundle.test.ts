/**
 * Tests for the exportable diagnostics bundle (ADR-0024).
 *
 * Two of these are load-bearing in a way the others are not.
 *
 * **The privacy test.** This bundle is designed to be pasted into a public issue
 * without the user stopping to think about it, and that is only defensible while
 * it is arithmetically incapable of carrying a face. The assertion below is the
 * thing standing between "safe to share" and a plausible-sounding future PR that
 * attaches a thumbnail "for context".
 *
 * **The graceful-degradation tests.** A user who cannot get through calibration
 * is reporting the most interesting failure there is. An exporter that refused
 * to produce anything without a calibration would drop exactly that case.
 *
 * Run with `npm run test:core`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AB_SWITCH_KEYS,
  DIAGNOSTICS_SCHEMA,
  biasDirection,
  buildDiagnosticsBundle,
  describeBiasPattern,
  diagnosticsFileName,
  formatBundleSummary,
  serializeBundle,
  type DiagnosticsInput,
} from './bundle.js';
import { summarizeValidation, type ValidationSamples } from '../validation/stats.js';
import type { CalibrationReport } from '../types.js';

const PX_PER_DEG = 42;

/** A fixation cloud centred at target+bias, spread deterministically by ±jitter. */
function cloud(
  target: { x: number; y: number },
  bias: { x: number; y: number },
  jitter: number,
  n = 24,
): ValidationSamples {
  const raw: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    // Symmetric about zero over each group of six, so the centroid lands
    // exactly on target+bias and no phantom bias enters the fixture.
    const k = ((i % 6) - 2.5) / 2.5;
    raw.push({ x: target.x + bias.x + jitter * k, y: target.y + bias.y - jitter * k * 0.6 });
  }
  return { target, raw, filtered: raw.map((p) => ({ x: p.x * 0.5 + target.x * 0.5, y: p.y })) };
}

/** The 13-point validation grid, offset uniformly up-and-left, lightly noisy. */
function uniformOffsetRun() {
  const grid: Array<[number, number]> = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.8],
    [0.5, 0.18],
    [0.35, 0.65],
    [0.82, 0.5],
    [0.2, 0.8],
    [0.65, 0.35],
    [0.5, 0.82],
    [0.8, 0.2],
    [0.35, 0.35],
    [0.18, 0.5],
    [0.65, 0.65],
  ];
  return grid.map(([fx, fy], i) =>
    cloud(
      { x: 1512 * fx, y: 945 * fy },
      // A constant displacement plus a small per-point wobble, so the pattern
      // is uniform without being suspiciously exact.
      { x: -34 + (i % 3) * 4, y: -21 + (i % 4) * 3 },
      26,
    ),
  );
}

const CALIBRATION: CalibrationReport = {
  tierName: 'quadratic + head',
  samples: 253,
  targets: 12,
  meanErrorPx: 61.4,
  p95ErrorPx: 118.9,
  meanErrorDeg: 1.4619047,
  perTargetErrorPx: [44.2, 51.8, 73.1, 39.5, 88.4, 62.0, 57.7, 49.3, 91.2, 66.8, 45.1, 71.6],
  lambdaX: 0.0031622777,
  lambdaY: 0.01,
  crossValidated: true,
  qualityWeighted: true,
  meanWeight: 0.8123,
  minWeight: 0.4012,
  effectiveSamples: 231.44,
};

const TUNING: Record<string, unknown> = {
  mode: 'blink',
  minCutoff: 0.6,
  beta: 0.02,
  dCutoff: 1,
  saccadePx: 90,
  clampRadius: 18,
  clampMs: 220,
  clampMaxHoldMs: 1200,
  medianWindow: 3,
  adaptiveClamp: true,
  clampNoiseScale: 2.5,
  clampRadiusMax: 90,
  confidenceTrust: true,
  trustFloor: 0.35,
  minQuality: 0.4,
  trackSettleMs: 300,
  maxFrameAgeMs: 120,
  armingMs: 400,
  takeoverEnabled: true,
  takeoverEpsilonPx: 2,
  takeoverResumeAfterMs: 1500,
  takeoverRequireManualResume: false,
  qualityWeighting: true,
  weightFloor: 0.25,
  pxPerDegree: 42.1,
};

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    capturedIso: '2026-07-25T14:32:05.123Z',
    appVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    displayFingerprint: '1512x945@2:0,0',
    displayBounds: { x: 0, y: 0, width: 1512, height: 945 },
    camera: {
      width: 1280,
      height: 720,
      frameRate: 30,
      exposureMode: 'manual',
      exposureTimeMs: 12.5,
    },
    vision: { delegate: 'GPU', inferenceMs: 7.42, cameraFps: 29.8, quality: 0.87 },
    engine: {
      fps: 29.6,
      poseDrift: 1.4,
      headCompensated: true,
      calibrated: true,
      guardReason: 'ok',
    },
    signal: {
      noiseGx: 0.0041,
      noiseGy: 0.0052,
      travelGx: 0.412,
      travelGy: 0.187,
      meanDgx: 0.0091,
      samples: 1840,
      pxPerGx: 2980,
      pxPerGy: 3420,
    },
    tuning: TUNING,
    calibration: CALIBRATION,
    validation: summarizeValidation(uniformOffsetRun(), PX_PER_DEG),
    includeClouds: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Privacy — the property the whole design rests on
// ---------------------------------------------------------------------------

test('the bundle carries no image or landmark data, even when handed some', () => {
  // A caller that has been extended carelessly: the input object carries a
  // thumbnail, a landmark array and a base64 blob. None of them are declared on
  // `DiagnosticsInput`, which is exactly how they would arrive in practice —
  // someone widening a struct upstream without reading this file.
  const contaminated = {
    ...input(),
    thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
    landmarks: [{ x: 0.41, y: 0.38, z: -0.02 }],
    frame: new Array(64).fill(0.5),
  } as unknown as DiagnosticsInput;

  const json = serializeBundle(buildDiagnosticsBundle(contaminated));

  assert.doesNotMatch(json, /thumbnail|landmark|base64|data:image/i);
  assert.doesNotMatch(json, /iVBORw0KGgo/, 'a PNG header must never appear');

  // Belt and braces on the key names rather than only the values: a future
  // field called `eyeCrop` or `faceImage` would be caught here even if its
  // value happened to be numeric.
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        assert.doesNotMatch(
          key,
          /image|landmark|thumb|pixel|crop|png|jpe?g|bitmap|base64|dataurl/i,
          `field ${path}.${key} looks like it carries pixels`,
        );
        walk(v, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') {
      // Prose in `advice`/`notes` is long by design; an encoded payload is long
      // *and* has no spaces. That is the distinction worth policing.
      assert.ok(
        value.length < 200 || value.includes(' '),
        `${path} is a long unbroken string, which is what an encoded blob looks like`,
      );
    }
  };
  walk(JSON.parse(json), 'bundle');
});

test('the raw clouds are cursor coordinates only, and are off by default', () => {
  const without = buildDiagnosticsBundle(input());
  assert.equal(without.validation?.targets[0]?.cloud, undefined);

  const withClouds = buildDiagnosticsBundle(input({ includeClouds: true }));
  const first = withClouds.validation?.targets[0];
  assert.ok(first?.cloud && first.cloud.length > 0);
  // Each entry is a screen point and nothing else. A cloud sample that grew a
  // third field would be carrying something that is not a cursor position.
  for (const p of first.cloud) {
    assert.deepEqual(Object.keys(p).sort(), ['x', 'y']);
  }

  // The size argument for the flag, asserted rather than claimed.
  assert.ok(
    serializeBundle(withClouds).length > serializeBundle(without).length * 3,
    'clouds should dominate the size — that is why they are behind a flag',
  );
});

// ---------------------------------------------------------------------------
// Degrading rather than refusing
// ---------------------------------------------------------------------------

test('a bundle with nothing measured yet is still produced, and says what is missing', () => {
  const bare = buildDiagnosticsBundle(
    input({ calibration: null, validation: null, signal: null, camera: null, engine: null, vision: null }),
  );

  assert.equal(bare.schemaVersion, DIAGNOSTICS_SCHEMA);
  assert.equal(bare.calibration, null);
  assert.equal(bare.validation, null);
  // The tuning read back from the engine is valid regardless, and it is what a
  // reader needs to know which build behaviour they are looking at.
  assert.equal(bare.tuning['confidenceTrust'], true);
  assert.ok(bare.notes.some((n) => /No calibration report/.test(n)));
  assert.ok(bare.notes.some((n) => /No validation run/.test(n)));
  assert.ok(bare.notes.some((n) => /No signal statistics/.test(n)));

  // And the summary must render without throwing on any of those nulls — the
  // clipboard path has no other error handling.
  const text = formatBundleSummary(bare, '/tmp/x.json');
  assert.match(text, /not run/);
  assert.match(text, /none on this display layout/);
});

test('an unsettled signal estimate is reported as unsettled, not quoted as fact', () => {
  const early = buildDiagnosticsBundle(
    input({
      signal: {
        noiseGx: 0.002,
        noiseGy: 0.002,
        travelGx: 0.03,
        travelGy: 0.01,
        meanDgx: 0.004,
        samples: 12,
        pxPerGx: 3000,
        pxPerGy: 3000,
      },
    }),
  );
  assert.equal(early.signal?.settled, false);
  assert.ok(early.notes.some((n) => /have not settled/.test(n)));
  assert.match(formatBundleSummary(early), /NOT SETTLED/);
});

test('a pre-ADR-0021 calibration reports "not recorded", not "unweighted"', () => {
  // The optional weight fields are absent on a profile saved before ADR-0021.
  // Reporting `false` would assert something the file does not say.
  const { qualityWeighted, meanWeight, minWeight, effectiveSamples, ...old } = CALIBRATION;
  void qualityWeighted;
  void meanWeight;
  void minWeight;
  void effectiveSamples;

  const b = buildDiagnosticsBundle(input({ calibration: old }));
  assert.equal(b.calibration?.qualityWeighted, null);
  assert.equal(b.calibration?.meanWeight, null);
  assert.match(formatBundleSummary(b), /quality weighting: not recorded/);
});

// ---------------------------------------------------------------------------
// The A/B story
// ---------------------------------------------------------------------------

test('the A/B switches are a projection of the engine tuning and cannot disagree with it', () => {
  const b = buildDiagnosticsBundle(input());
  for (const key of AB_SWITCH_KEYS) {
    assert.equal(b.abSwitches[key], b.tuning[key], `${key} disagrees with the tuning it came from`);
  }
  // The switches ADR-0021 and ADR-0023 shipped specifically to be A/B'd.
  assert.equal(b.abSwitches['qualityWeighting'], true);
  assert.equal(b.abSwitches['confidenceTrust'], true);
  assert.equal(b.abSwitches['weightFloor'], 0.25);
  assert.equal(b.abSwitches['trustFloor'], 0.35);
});

test('two bundles differing only in one flag differ in only a few lines', () => {
  // The reason every float is rounded. Unrounded f64s differ in the last digit
  // on every line, and a hundred-line diff hides the one line that matters.
  const on = serializeBundle(buildDiagnosticsBundle(input())).split('\n');
  const off = serializeBundle(
    buildDiagnosticsBundle(input({ tuning: { ...TUNING, confidenceTrust: false } })),
  ).split('\n');

  assert.equal(on.length, off.length, 'the shape must be identical');
  const differing = on.filter((line, i) => line !== off[i]);
  assert.equal(
    differing.length,
    2,
    `expected only abSwitches.confidenceTrust and tuning.confidenceTrust to move, got:\n${differing.join('\n')}`,
  );
});

test('the engine tuning is copied whole, with only primitives surviving', () => {
  const b = buildDiagnosticsBundle(
    input({
      tuning: {
        ...TUNING,
        // The shapes a future napi widening could introduce.
        nested: { secret: 1 },
        payload: 'x'.repeat(4096),
        fn: () => 1,
      },
    }),
  );
  assert.equal(b.tuning['minCutoff'], 0.6);
  assert.equal(b.tuning['mode'], 'blink');
  assert.equal(b.tuning['nested'], undefined);
  assert.equal(b.tuning['payload'], undefined);
  assert.equal(b.tuning['fn'], undefined);
});

// ---------------------------------------------------------------------------
// NaN, which is a normal outcome here
// ---------------------------------------------------------------------------

test('an ungraded run serializes as null, never as a confident number', () => {
  // px_per_degree of 0 reaches `summarizeValidation` whenever the engine has no
  // display geometry, and every degree figure is then NaN. JSON has no NaN, so
  // the type says `null` and the file agrees with the type.
  const b = buildDiagnosticsBundle(
    input({ validation: summarizeValidation(uniformOffsetRun(), 0) }),
  );
  assert.equal(b.validation?.meanAccuracyDeg, null);
  assert.equal(b.validation?.targets[0]?.accuracyDeg, null);
  assert.equal(b.validation?.accuracyVerdict, 'unknown', 'unscored is not the same as poor');
  // The pixel figures are real and must survive.
  assert.ok(typeof b.validation?.meanAccuracyPx === 'number');
  assert.doesNotMatch(serializeBundle(b), /NaN|Infinity/);
});

// ---------------------------------------------------------------------------
// Reading the arrow map without the picture
// ---------------------------------------------------------------------------

test('bias direction is named in screen coordinates, where +y is down', () => {
  assert.equal(biasDirection({ x: 0, y: 60 }), 'down');
  assert.equal(biasDirection({ x: -50, y: -50 }), 'up-left');
  assert.equal(biasDirection({ x: 40, y: 0 }), 'right');
  assert.equal(biasDirection({ x: 0.2, y: -0.1 }), 'centred', 'sub-pixel bias has no direction');
});

test('a uniform offset is described as one, with its direction', () => {
  const r = summarizeValidation(uniformOffsetRun(), PX_PER_DEG);
  const pattern = describeBiasPattern(r.targets);
  assert.match(pattern, /uniform offset/);
  assert.match(pattern, /up-left/);
  assert.match(pattern, /recalibrat/i);
});

test('errors splaying outward from the centre are described as under-fitted periphery', () => {
  const centre = { x: 756, y: 472 };
  const samples = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
    [0.8, 0.2],
    [0.5, 0.15],
    [0.5, 0.85],
    [0.15, 0.5],
    [0.85, 0.5],
  ].map(([fx, fy]) => {
    const target = { x: 1512 * (fx ?? 0), y: 945 * (fy ?? 0) };
    const rx = target.x - centre.x;
    const ry = target.y - centre.y;
    const r = Math.hypot(rx, ry) || 1;
    // Bias pointing away from the centre, proportional to eccentricity.
    return cloud(target, { x: (rx / r) * 70, y: (ry / r) * 70 }, 8);
  });

  const pattern = describeBiasPattern(summarizeValidation(samples, PX_PER_DEG).targets);
  assert.match(pattern, /splay outward/);
  assert.doesNotMatch(pattern, /uniform offset/);
});

test('one bad point among good ones is called out as a missed calibration dot', () => {
  const samples = [
    cloud({ x: 300, y: 300 }, { x: 6, y: -4 }, 6),
    cloud({ x: 1200, y: 300 }, { x: -5, y: 3 }, 6),
    cloud({ x: 300, y: 700 }, { x: 4, y: 5 }, 6),
    cloud({ x: 1200, y: 700 }, { x: -6, y: -3 }, 6),
    cloud({ x: 756, y: 472 }, { x: 380, y: 40 }, 6),
  ];
  const pattern = describeBiasPattern(summarizeValidation(samples, PX_PER_DEG).targets);
  assert.match(pattern, /one point is far worse/);
});

test('scattered errors are attributed to noise rather than to the mapping', () => {
  // Biases of equal size pointing *tangentially* — neither all the same way nor
  // consistently in or out. That is what a noise-dominated run looks like, and
  // it is the one case where recalibrating is the wrong advice.
  const corners: Array<[number, number]> = [
    [300, 300],
    [1200, 300],
    [300, 700],
    [1200, 700],
  ];
  const centre = { x: 750, y: 500 };
  const samples = corners.map(([x, y]) => {
    const rx = x - centre.x;
    const ry = y - centre.y;
    const r = Math.hypot(rx, ry);
    // Rotate the radial direction by 90°, so its radial component is zero.
    return cloud({ x, y }, { x: (ry / r) * 70, y: (-rx / r) * 70 }, 6);
  });
  samples.push(cloud(centre, { x: -3, y: 4 }, 6));

  const pattern = describeBiasPattern(summarizeValidation(samples, PX_PER_DEG).targets);
  assert.match(pattern, /no consistent direction/);
});

test('a run with too few scored points says so instead of inventing a pattern', () => {
  assert.match(describeBiasPattern([]), /too few points/);
});

// ---------------------------------------------------------------------------
// Shape and summary
// ---------------------------------------------------------------------------

test('the summary reports accuracy and precision separately, never blended', () => {
  const text = formatBundleSummary(buildDiagnosticsBundle(input()), '/tmp/diagnostics.json');

  assert.match(text, /accuracy .*systematic/);
  assert.match(text, /precision .*random/);
  assert.match(text, /noise floor/);
  assert.match(text, /resolvable steps/);
  assert.match(text, /qualityWeighting=on/);
  assert.match(text, /confidenceTrust=on/);
  assert.match(text, /numbers only — no images and no landmarks/);
  assert.match(text, /\/tmp\/diagnostics\.json/);
  // Short enough to paste into a comment box and actually be read.
  assert.ok(text.split('\n').length < 45, `summary is ${text.split('\n').length} lines`);
});

test('the file name sorts chronologically and is readable in a listing', () => {
  assert.equal(
    diagnosticsFileName(new Date(2026, 6, 25, 14, 32, 5)),
    'diagnostics-20260725-143205.json',
  );
});

test('every ADR-0018 per-target figure survives the round trip', () => {
  // The acceptance criterion from #49: complete enough to diagnose without a
  // follow-up question. That means direction, not just magnitude, per point.
  const parsed = JSON.parse(serializeBundle(buildDiagnosticsBundle(input()))) as {
    validation: { targets: Array<Record<string, unknown>> };
  };
  const t = parsed.validation.targets[0];
  assert.ok(t);
  for (const key of [
    'target',
    'samples',
    'mean',
    'bias',
    'biasDirection',
    'accuracyPx',
    'accuracyDeg',
    'precisionPx',
    'precisionDeg',
    'filteredPrecisionPx',
    'sdX',
    'sdY',
  ]) {
    assert.ok(key in t, `per-target field ${key} is missing`);
  }
});
