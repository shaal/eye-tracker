/**
 * Tests for the recorder's drop policy.
 *
 * These are small but they guard the one property the recorder must never
 * lose: it is allowed to lose data, and it must lose it *predictably* and
 * without leaking the GPU-backed bitmaps it was holding. A queue that quietly
 * grew instead of dropping would turn a slow disk into dropped tracking frames,
 * which is the failure ADR-0022 exists to prevent.
 *
 * Run with `npm run test:core`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DropOldestQueue } from './queue.js';

test('holds up to capacity without dropping', () => {
  const q = new DropOldestQueue<number>(3);
  assert.equal(q.push(1), true);
  assert.equal(q.push(2), true);
  assert.equal(q.push(3), true);
  assert.equal(q.length, 3);
  assert.equal(q.dropped, 0);
});

test('evicts the oldest entry, not the newest', () => {
  const q = new DropOldestQueue<number>(2);
  q.push(1);
  q.push(2);
  assert.equal(q.push(3), false);

  // 1 is gone; 2 and 3 survive in order. Keeping the newest matters: it is the
  // frame whose pixels still match what the rest of the system is doing.
  assert.equal(q.shift(), 2);
  assert.equal(q.shift(), 3);
  assert.equal(q.shift(), undefined);
  assert.equal(q.dropped, 1);
});

test('hands every evicted item to onDrop so its bitmap can be released', () => {
  const released: string[] = [];
  const q = new DropOldestQueue<string>(2, (item) => released.push(item));

  q.push('a');
  q.push('b');
  q.push('c');
  q.push('d');

  assert.deepEqual(released, ['a', 'b']);
  assert.equal(q.dropped, 2);
});

test('clear releases what is queued but is not counted as dropping', () => {
  const released: number[] = [];
  const q = new DropOldestQueue<number>(4, (item) => released.push(item));

  q.push(1);
  q.push(2);
  q.clear();

  assert.deepEqual(released, [1, 2]);
  assert.equal(q.length, 0);
  // Stopping a recording is not the same event as failing to keep up with one,
  // and the UI reports the second to the user.
  assert.equal(q.dropped, 0);
});

test('the dropped counter survives clear and resets only on request', () => {
  const q = new DropOldestQueue<number>(1);
  q.push(1);
  q.push(2);
  assert.equal(q.dropped, 1);
  q.clear();
  assert.equal(q.dropped, 1);
  q.resetDropped();
  assert.equal(q.dropped, 0);
});

test('a nonsensical capacity fails at construction, not at the first frame', () => {
  assert.throws(() => new DropOldestQueue<number>(0));
  assert.throws(() => new DropOldestQueue<number>(-1));
  assert.throws(() => new DropOldestQueue<number>(1.5));
});
