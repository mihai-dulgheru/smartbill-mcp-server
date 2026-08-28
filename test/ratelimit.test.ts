import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindow, type Clock } from '../src/ratelimit.ts';

/** A clock whose time only moves when a sleep is awaited. */
function fakeClock(): Clock & { slept: number[]; time: number } {
  const c = {
    time: 1_000_000,
    slept: [] as number[],
    now: () => c.time,
    sleep: async (ms: number) => {
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
  // Four calls through a window of two means exactly two of them had to wait.
  assert.equal(clock.slept.length, 2);
});
