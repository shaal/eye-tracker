/**
 * Tests for the tuning-group registry.
 *
 * `TUNING_GROUPS` exists because the main process used to forward a tuning
 * patch to the engine through a hand-written list of `if (t.filter) …` lines.
 * When ADR-0021 added the `calibration` group, that list was not updated, and
 * the result was the quietest possible failure: the patch was well-formed, the
 * IPC call succeeded, the setting persisted, and the engine simply never heard
 * about it. `qualityWeighting` was settable and did nothing.
 *
 * There is a compile-time exhaustiveness check next to the constant, which is
 * the real guard. These tests cover what a type cannot: that the values are
 * actually usable as runtime keys, and that the specific group which was
 * dropped is present.
 *
 * Run with `npm run test:core`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TUNING_GROUPS, type TuningPatch } from './types.js';

/**
 * A patch with every group populated.
 *
 * Typed as `TuningPatch`, so adding a group to the interface without adding it
 * here is not an error — that is what the compile-time check is for. What this
 * gives us is a concrete object to enumerate at runtime.
 */
const FULL_PATCH: TuningPatch = {
  filter: { minCutoff: 0.6 },
  blink: { minCloseMs: 120 },
  guard: { minQuality: 0.4 },
  takeover: { enabled: true },
  calibration: { qualityWeighting: true, weightFloor: 0.25 },
  pxPerDegree: 30,
};

test('every grouped key of a populated patch is registered', () => {
  const grouped = Object.entries(FULL_PATCH)
    .filter(([, v]) => typeof v === 'object' && v !== null)
    .map(([k]) => k);

  for (const key of grouped) {
    assert.ok(
      (TUNING_GROUPS as readonly string[]).includes(key),
      `group "${key}" is not in TUNING_GROUPS, so it would be dropped on the way to the engine`,
    );
  }
});

test('calibration is registered', () => {
  // The specific regression. ADR-0021's A/B switch is unreachable without it.
  assert.ok((TUNING_GROUPS as readonly string[]).includes('calibration'));
});

test('pxPerDegree is not a group', () => {
  // It is a scalar and is forwarded separately; listing it here would make the
  // forwarder copy a number under a key the native side expects to be an object.
  assert.ok(!(TUNING_GROUPS as readonly string[]).includes('pxPerDegree'));
});

test('no duplicate groups', () => {
  assert.equal(new Set(TUNING_GROUPS).size, TUNING_GROUPS.length);
});
