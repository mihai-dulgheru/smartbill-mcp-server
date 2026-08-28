import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindow, type Clock } from '../src/ratelimit.ts';

/**
 * A clock whose time only moves when a sleep is awaited, and - critically - only mutates `time`
 * and `slept` after yielding a microtask, not synchronously inside the call.
 *
 * A synchronous mutation here would hide a real bug: without the `#queue` serialisation in
 * SlidingWindow, two concurrent acquire() calls that both read the window before either sleeps
 * would each compute the same wait and both push to `slept`, so a naive fake clock still lands on
 * the right `slept.length` by accident even with no serialisation at all. Yielding first forces
 * a second, unserialised caller to actually observe the first caller's pre-sleep state, which is
 * what exposes the oversubscription this test exists to catch.
 */
function fakeClock(): Clock & { slept: number[]; time: number } {
  const c = {
    time: 1_000_000,
    slept: [] as number[],
    now: () => c.time,
    sleep: async (ms: number) => {
      await Promise.resolve();
      c.slept.push(ms);
      c.time += ms;
    },
  };
  return c;
}

test('lets the first `max` calls through without sleeping', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  await w.acquire();
  await w.acquire();
  await w.acquire();
  assert.deepEqual(clock.slept, []);
});

test('delays the call that would breach the window', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  for (let i = 0; i < 3; i += 1) await w.acquire();
  await w.acquire();
  assert.equal(clock.slept.length, 1);
  assert.ok(clock.slept[0]! > 0 && clock.slept[0]! <= 10_000);
});

test('does not delay once the window has rolled past', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  for (let i = 0; i < 3; i += 1) await w.acquire();
  clock.time += 10_001;
  await w.acquire();
  assert.deepEqual(clock.slept, []);
});

test('the V1 window delays the 31st call in 10 seconds', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(30, 10_000, clock);
  for (let i = 0; i < 30; i += 1) await w.acquire();
  assert.deepEqual(clock.slept, []);
  await w.acquire();
  assert.equal(clock.slept.length, 1);
});

test('the V3 window delays the 61st call in 10 seconds', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(60, 10_000, clock);
  for (let i = 0; i < 60; i += 1) await w.acquire();
  assert.deepEqual(clock.slept, []);
  await w.acquire();
  assert.equal(clock.slept.length, 1);
});

test('serialises concurrent acquires so the window is never oversubscribed', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(2, 10_000, clock);
  await Promise.all([w.acquire(), w.acquire(), w.acquire(), w.acquire()]);
  // Four calls through a window of two means the 3rd waits out the full window (10000ms) behind
  // the 1st, and by the time the 4th is served the window has already rolled forward to just
  // 1ms behind the 2nd. Exact values, not just a count: a version that dropped the `#queue`
  // serialisation would let the 3rd and 4th both read the stale pre-wait state and both compute
  // the full 10000ms wait, giving [10000, 10000] instead.
  assert.deepEqual(clock.slept, [10000, 1]);
});

test('holdUntil delays the next acquire until the given time', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(30, 10_000, clock);
  w.holdUntil(clock.time + 5000);
  await w.acquire();
  assert.deepEqual(clock.slept, [5000]);
});

test('holdUntil does not delay once its time has already passed', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(30, 10_000, clock);
  w.holdUntil(clock.time - 1);
  await w.acquire();
  assert.deepEqual(clock.slept, []);
});
