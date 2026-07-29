/**
 * Tests for the calibration instruction protocol.
 *
 * The rule these protect is "show a card only when the instruction changes".
 * It is easy to break in either direction, and both directions are bad: a card
 * before every one of the nine fixation dots trains the user to dismiss cards
 * without reading, which then costs them the head-motion card that actually
 * carries new information; and a missing card means the user reads the
 * instruction *while* the target is already collecting, which is the failure
 * this whole mechanism exists to fix (ADR-0015, ADR-0018).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CALIBRATION_SAMPLING,
  CALIBRATION_TIMING,
  FIXATION_INSTRUCTION,
  HEAD_MOTION_STEPS,
  HEAD_MOTION_TIMING,
  headMotionTargets,
  instructionDurationMs,
  totalDurationMs,
} from './protocol.js';

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

test('an instruction is on screen long enough to actually read', () => {
  for (const step of HEAD_MOTION_STEPS) {
    const ms = instructionDurationMs(`${step.title} ${step.detail}`);
    const words = `${step.title} ${step.detail}`.split(/\s+/).length;
    // At a conservative 3 words/second, plus a beat to look up and register
    // that the screen changed.
    assert.ok(ms >= (words / 3) * 1000, `"${step.title}" gets ${ms}ms for ${words} words`);
    assert.ok(ms >= 2400, `no card should flash by: ${ms}ms`);
    assert.ok(ms <= 7000, `nor stall the run: ${ms}ms`);
  }
});

test('the card clears before collection starts, not during it', () => {
  // The point of the card is that the head is already moving when the
  // head-motion window opens. If the card overlapped collection we would be
  // back to fitting cross-terms against a stationary head.
  const ms = instructionDurationMs('Turn your head slowly left and right x');
  assert.ok(ms > 0);
  assert.ok(
    HEAD_MOTION_TIMING.settleMs > 0,
    'there is still a settle phase after the card, before any sampling',
  );
  assert.equal(HEAD_MOTION_TIMING.discardMs > 0, true, 'and a discarded transit after that');
});

test('head-motion steps carry a short headline and a separate caveat', () => {
  for (const step of HEAD_MOTION_STEPS) {
    // A headline that wraps to three lines at 76px is not a headline.
    assert.ok(step.title.split(/\s+/).length <= 7, `title too long: "${step.title}"`);
    assert.ok(step.detail.length > 0, `"${step.title}" has no detail line`);
    assert.notEqual(step.title, step.detail);
    // The constraint that makes the movement useful must be restated every
    // time: moving the head *with* the gaze teaches the model nothing.
    assert.match(step.detail, /eyes/i, `"${step.title}" must restate the eyes-on-dot rule`);
  }
});

test('consecutive head-motion steps never repeat an identical card', () => {
  // Two adjacent steps with the same wording would collapse into one card under
  // the "only when it changes" rule, silently dropping an instruction.
  const targets = headMotionTargets(BOUNDS);
  for (let i = 1; i < targets.length; i++) {
    const a = `${targets[i - 1]!.title} ${targets[i - 1]!.detail}`;
    const b = `${targets[i]!.title} ${targets[i]!.detail}`;
    assert.notEqual(a, b, `steps ${i - 1} and ${i} would collapse into one card`);
  }
});

test('head-motion targets are spread out, not stacked at centre', () => {
  // Head movement has to be seen against *different* gaze directions, or the
  // cross terms cannot be separated from the plain head terms (ADR-0015).
  const xs = new Set(headMotionTargets(BOUNDS).map((t) => t.x));
  assert.ok(xs.size >= 3, `only ${xs.size} distinct x positions`);
});

test('the quoted duration counts the cards but not duplicates', () => {
  const withoutHead = totalDurationMs(9, 0);
  const dotsOnly = 9 * (CALIBRATION_TIMING.settleMs + CALIBRATION_TIMING.collectMs + CALIBRATION_TIMING.gapMs);
  const oneCard = instructionDurationMs(
    `${FIXATION_INSTRUCTION.title} ${FIXATION_INSTRUCTION.detail}`,
  );

  // Nine dots share one instruction, so exactly one card is counted — not nine.
  assert.equal(withoutHead, dotsOnly + oneCard);

  // Adding the head-motion phase must add both its sampling time and its cards.
  const withHead = totalDurationMs(9, HEAD_MOTION_STEPS.length);
  assert.ok(withHead > withoutHead + HEAD_MOTION_STEPS.length * HEAD_MOTION_TIMING.collectMs);
});

test('an empty run quotes no instruction time', () => {
  assert.equal(totalDurationMs(0, 0), 0);
});

test('the wanted sample count matches what the timed protocol gave at 30 fps', () => {
  // The count is a restatement of the original intent, not a new target: the
  // old fixed window yielded this many samples on a camera that kept up. If
  // someone retunes the window, this should be revisited together with it.
  const usableMs = CALIBRATION_TIMING.collectMs - CALIBRATION_TIMING.discardMs;
  const atThirtyFps = Math.round((usableMs / 1000) * 30);
  assert.equal(
    CALIBRATION_SAMPLING.targetSamples,
    atThirtyFps,
    'sample target drifted away from the timing it was derived from',
  );
});

test('a starved camera still terminates, and a fast one still gets a full fixation', () => {
  const usableMs = CALIBRATION_TIMING.collectMs - CALIBRATION_TIMING.discardMs;

  // The ceiling has to exceed the nominal window, or the count could never be
  // reached and the change would be a no-op that merely renamed a timeout.
  assert.ok(
    CALIBRATION_SAMPLING.maxCollectMs > usableMs,
    'the ceiling must leave room for a slow camera to catch up',
  );

  // ...and it has to be bounded, or a dead camera hangs the run forever.
  assert.ok(CALIBRATION_SAMPLING.maxCollectMs <= 5000, 'ceiling is too loose to be a safety net');

  // Polling has to be fine-grained relative to the window, or the count
  // overshoots and the dots drag.
  assert.ok(
    CALIBRATION_SAMPLING.pollMs < usableMs / 4,
    'poll interval is coarse enough to overshoot the sample target noticeably',
  );
});

test('the worst-case run is bounded by the ceiling, not unbounded', () => {
  // What a user is exposed to if the camera is starved at every dot.
  const worstPerDot =
    CALIBRATION_TIMING.settleMs +
    CALIBRATION_TIMING.discardMs +
    CALIBRATION_SAMPLING.maxCollectMs +
    CALIBRATION_TIMING.gapMs;
  assert.ok(worstPerDot < 4000, `a starved dot would take ${worstPerDot}ms, which reads as a hang`);
});
