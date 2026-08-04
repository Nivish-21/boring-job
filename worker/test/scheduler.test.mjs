import assert from 'node:assert/strict';
import test from 'node:test';
import { startDailyScheduler } from '../src/scheduler.mjs';

const noopLog = { log: () => {}, error: () => {} };
const fakeSchedule = () => 'fake-timer';

test('tick runs once during the target UTC hour and not again the same day', async () => {
  let calls = 0;
  const clock = ['2026-08-04T07:05:00.000Z', '2026-08-04T07:20:00.000Z', '2026-08-04T08:00:00.000Z'];
  let index = 0;
  const scheduler = startDailyScheduler({
    run: async () => { calls += 1; return { ok: true }; },
    hourUtc: 7,
    now: () => new Date(clock[index]),
    scheduleImpl: fakeSchedule,
    log: noopLog
  });

  await scheduler.tick();
  index = 1;
  await scheduler.tick();
  index = 2;
  await scheduler.tick();

  assert.equal(calls, 1);
});

test('tick does nothing outside the target UTC hour', async () => {
  let calls = 0;
  const scheduler = startDailyScheduler({
    run: async () => { calls += 1; },
    hourUtc: 7,
    now: () => new Date('2026-08-04T12:00:00.000Z'),
    scheduleImpl: fakeSchedule,
    log: noopLog
  });

  await scheduler.tick();
  assert.equal(calls, 0);
});

test('tick fires again on a new UTC calendar day', async () => {
  let calls = 0;
  let current = '2026-08-04T07:00:00.000Z';
  const scheduler = startDailyScheduler({
    run: async () => { calls += 1; },
    hourUtc: 7,
    now: () => new Date(current),
    scheduleImpl: fakeSchedule,
    log: noopLog
  });

  await scheduler.tick();
  current = '2026-08-05T07:00:00.000Z';
  await scheduler.tick();

  assert.equal(calls, 2);
});

test('a failing run is logged and does not throw, and stays retryable on the next tick', async () => {
  let attempts = 0;
  const scheduler = startDailyScheduler({
    run: async () => { attempts += 1; throw new Error('firecrawl unavailable'); },
    hourUtc: 7,
    now: () => new Date('2026-08-04T07:00:00.000Z'),
    scheduleImpl: fakeSchedule,
    log: noopLog
  });

  const result = await scheduler.tick();
  assert.equal(result, null);
  assert.equal(attempts, 1);
});

test('stop() clears the underlying timer', () => {
  let cleared = null;
  const originalClearInterval = global.clearInterval;
  global.clearInterval = (timer) => { cleared = timer; };
  try {
    const scheduler = startDailyScheduler({ run: async () => {}, scheduleImpl: fakeSchedule, log: noopLog });
    scheduler.stop();
    assert.equal(cleared, 'fake-timer');
  } finally {
    global.clearInterval = originalClearInterval;
  }
});
