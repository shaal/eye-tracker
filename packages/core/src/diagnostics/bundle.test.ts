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
  verticalBasis: 'aperture',
  opennessTerms: false,
  axisSpecific: false,
  openRef: 0.3117,
  verticalRangeFraction: 0.91,
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
  apertureVertical: true,
  opennessTerms: false,
  axisSpecificVertical: false,
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
  // …and the three ADR-0025 shipped for the same reason.
  assert.equal(b.abSwitches['apertureVertical'], true);
  assert.equal(b.abSwitches['opennessTerms'], false);
  assert.equal(b.abSwitches['axisSpecificVertical'], false);
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
// Axis collapse (#58) — a dead channel is not a displaced one
// ---------------------------------------------------------------------------

/**
 * One axis collapsed to a near-constant prediction, the other functional.
 * The collapsing axis's target/predicted pairs are #57's measured row means
 * from the real session that #58 was filed against — predicted y stayed in
 * 369-393 while target y swept 239-1090. The live axis has no published
 * per-point data (the issue reports only that horizontal "recovered"), so it
 * is a representative small residual, kept well clear of a -1 slope.
 */
function axisCollapseRun(collapseAxis: 'x' | 'y') {
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
  const predicted: Record<string, number> = {
    '0.18': 369,
    '0.2': 374,
    '0.35': 376,
    '0.5': 380,
    '0.65': 391,
    '0.8': 378,
    '0.82': 393,
  };
  return grid.map(([fx, fy]) => {
    const collapseFrac = collapseAxis === 'y' ? fy : fx;
    const liveFrac = collapseAxis === 'y' ? fx : fy;
    const collapsePos = 1329 * collapseFrac;
    const livePos = 1512 * liveFrac;
    const collapseBias = (predicted[String(collapseFrac)] ?? 380) - collapsePos;
    const liveBias = -12 + 0.02 * (livePos - 756);
    const target =
      collapseAxis === 'y' ? { x: livePos, y: collapsePos } : { x: collapsePos, y: livePos };
    const bias =
      collapseAxis === 'y' ? { x: liveBias, y: collapseBias } : { x: collapseBias, y: liveBias };
    return cloud(target, bias, 10);
  });
}

test('the #58 session classifies the collapsed vertical axis as a collapse, not a uniform offset', () => {
  const pattern = describeBiasPattern(summarizeValidation(axisCollapseRun('y'), PX_PER_DEG).targets);
  assert.match(pattern, /y axis has collapsed/);
  assert.doesNotMatch(pattern, /uniform offset/);
  assert.doesNotMatch(pattern, /recalibrat/i);
});

test('the other axis is reported as not collapsed, independently, per axis', () => {
  const pattern = describeBiasPattern(summarizeValidation(axisCollapseRun('y'), PX_PER_DEG).targets);
  assert.match(pattern, /y axis has collapsed/);
  assert.match(pattern, /x axis is not collapsed/);
});

test('axis collapse is detected on x symmetrically with y', () => {
  const pattern = describeBiasPattern(summarizeValidation(axisCollapseRun('x'), PX_PER_DEG).targets);
  assert.match(pattern, /x axis has collapsed/);
  assert.match(pattern, /y axis is not collapsed/);
  assert.doesNotMatch(pattern, /recalibrat/i);
});

test('a genuine uniform offset is unaffected by the collapse check', () => {
  // Regression guard for #58's own fix: the synthetic uniform-offset fixture
  // above has near-zero bias/target slope on both axes, so it must keep
  // classifying as a uniform offset rather than tripping the new check.
  const pattern = describeBiasPattern(summarizeValidation(uniformOffsetRun(), PX_PER_DEG).targets);
  assert.doesNotMatch(pattern, /collapsed/);
  assert.match(pattern, /uniform offset/);
});

/**
 * Same vertical collapse as #58, but the live horizontal axis carries a
 * material offset of its own (a constant ~150 px, not proportional to
 * position) rather than a small residual. This is the case CodeRabbit flagged
 * on PR #61: "not collapsed" is not the same claim as "healthy", and the
 * pattern text must not call a badly-offset live axis normal just because its
 * slope isn't near -1.
 */
function axisCollapseWithLiveOffsetRun() {
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
  const predictedY: Record<string, number> = {
    '0.18': 369,
    '0.2': 374,
    '0.35': 376,
    '0.5': 380,
    '0.65': 391,
    '0.8': 378,
    '0.82': 393,
  };
  return grid.map(([fx, fy]) => {
    const target = { x: 1512 * fx, y: 1329 * fy };
    const biasY = (predictedY[String(fy)] ?? 380) - target.y;
    const biasX = -150 + (fx > 0.5 ? 6 : -6);
    return cloud(target, { x: biasX, y: biasY }, 10);
  });
}

test('a live axis with its own material offset is never called healthy just because it is not collapsed', () => {
  const pattern = describeBiasPattern(
    summarizeValidation(axisCollapseWithLiveOffsetRun(), PX_PER_DEG).targets,
  );
  assert.match(pattern, /y axis has collapsed/);
  assert.doesNotMatch(pattern, /tracking normally/);
  assert.doesNotMatch(pattern, /healthy/);
  assert.match(pattern, /x axis is not collapsed/);
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

/**
 * The failure #48 fixed, one step downstream: a switch that is settable but
 * invisible.
 *
 * The clipboard summary is the artefact that gets pasted into an issue, and the
 * entire purpose of the next hardware session is comparing aperture-on against
 * aperture-off. A summary that does not state which mode produced the numbers
 * makes that comparison unreadable — and it fails silently, which is why this is
 * asserted rather than left to review.
 */
test('the summary states every A/B switch, including the vertical feature ones', () => {
  const text = formatBundleSummary(buildDiagnosticsBundle(input()));
  for (const key of AB_SWITCH_KEYS) {
    assert.match(text, new RegExp(`\\b${key}=`), `${key} is settable but invisible in the summary`);
  }
  assert.match(text, /apertureVertical=on/);
  assert.match(text, /opennessTerms=off/);
  assert.match(text, /axisSpecificVertical=off/);
});

/**
 * The primary metric of #57 has to be findable by someone skimming, because it
 * is the one number that separates "the vertical channel is inaccurate" from
 * "the vertical channel returns a constant" — a distinction mean error cannot
 * make at all.
 */
test('the summary leads the fit with the vertical range fraction', () => {
  const text = formatBundleSummary(buildDiagnosticsBundle(input()));
  assert.match(text, /VERTICAL RANGE 0\.91 of target span/);
  assert.match(text, /fitted on the aperture basis/);
});

/**
 * A switch changes what the *next* calibration is fitted on and does nothing to
 * a model already loaded, so "engine set to aperture, profile fitted on corner"
 * is a normal state a user will pass through — and one where the numbers on
 * screen belong to the *other* mode.
 *
 * Reading that as a successful A/B is the specific mistake this warning exists
 * to prevent, and nothing else in the bundle would reveal it.
 */
test('the summary flags a profile fitted under different switches than the engine now has', () => {
  const stale = formatBundleSummary(
    buildDiagnosticsBundle(
      input({ calibration: { ...CALIBRATION, verticalBasis: 'corner', axisSpecific: true } }),
    ),
  );
  assert.match(stale, /STALE: this profile was fitted on the corner basis/);
  assert.match(stale, /set to aperture/);
  assert.match(stale, /reduced vertical column set is off now but was on/);

  // …and stays quiet when they agree, or the warning becomes wallpaper.
  const agreeing = formatBundleSummary(buildDiagnosticsBundle(input()));
  assert.doesNotMatch(agreeing, /STALE/);
});

/**
 * A profile from before ADR-0025 does not record what it was fitted with, and
 * the honest response to that is silence rather than a comparison against a
 * value we would have had to invent.
 */
test('a profile that predates the vertical switches is not compared against them', () => {
  const { verticalBasis, opennessTerms, axisSpecific, openRef, verticalRangeFraction, ...old } =
    CALIBRATION;
  const text = formatBundleSummary(buildDiagnosticsBundle(input({ calibration: old })));
  assert.doesNotMatch(text, /STALE/);
  assert.match(text, /not recorded basis/);
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
