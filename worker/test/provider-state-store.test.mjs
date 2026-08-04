import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ProviderStateStore } from '../src/provider-state-store.mjs';

test('providers are enabled by default until a failure is recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-provider-state-'));
  const filePath = join(root, 'provider-state.json');
  const store = new ProviderStateStore(filePath);

  try {
    await store.initialize();
    assert.equal(await store.isEnabled('firecrawl'), true);

    await store.recordFailure('firecrawl', { errorType: 'quota_exhausted', message: 'out of credits' });
    assert.equal(await store.isEnabled('firecrawl'), false);

    await store.recordSuccess('firecrawl');
    assert.equal(await store.isEnabled('firecrawl'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure with no cooldownMs stays disabled indefinitely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-provider-state-'));
  const filePath = join(root, 'provider-state.json');
  const store = new ProviderStateStore(filePath);

  try {
    await store.initialize();
    await store.recordFailure('apify', { errorType: 'unauthorized', message: 'bad token' });
    assert.equal(await store.isEnabled('apify'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure with a cooldownMs auto re-enables once it elapses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-provider-state-'));
  const filePath = join(root, 'provider-state.json');
  const store = new ProviderStateStore(filePath);

  try {
    await store.initialize();
    await store.recordFailure('firecrawl', { errorType: 'rate_limited', message: 'too many requests', cooldownMs: -1 });
    assert.equal(await store.isEnabled('firecrawl'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tracks consecutive failure_count across repeated failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-provider-state-'));
  const filePath = join(root, 'provider-state.json');
  const store = new ProviderStateStore(filePath);

  try {
    await store.initialize();
    const first = await store.recordFailure('apify', { errorType: 'timeout', message: 'slow', cooldownMs: 60_000 });
    assert.equal(first.failure_count, 1);
    const second = await store.recordFailure('apify', { errorType: 'timeout', message: 'slow again', cooldownMs: 60_000 });
    assert.equal(second.failure_count, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
