import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PipelineStore } from '../src/pipeline-store.mjs';

test('countCreatedSince counts only needs_review jobs created on or after the cutoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-store-'));
  const filePath = join(root, 'pipeline.json');
  const store = new PipelineStore(filePath);

  try {
    await store.initialize();
    await store.record({ stable_id: 'greenhouse:acme:1', status: 'needs_review', source_url: 'https://a.com/1' });
    await store.record({ stable_id: 'greenhouse:acme:2', status: 'skipped', source_url: 'https://a.com/2' });
    await store.record({ stable_id: 'greenhouse:acme:3', status: 'needs_review', source_url: 'https://a.com/3' });

    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    assert.equal(await store.countCreatedSince(past), 2);
    assert.equal(await store.countCreatedSince(future), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
