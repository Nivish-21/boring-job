import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { FounderStore } from '../src/founder-store.mjs';

test('record upserts by profile_url and getByProfileUrl retrieves the merged result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-founder-store-'));
  const store = new FounderStore(join(root, 'founders.json'));

  try {
    await store.initialize();
    await store.record({ profile_url: 'https://www.linkedin.com/in/jane', name: 'Jane Doe', company: 'Nimbus' });
    const first = await store.getByProfileUrl('https://www.linkedin.com/in/jane');
    assert.equal(first.name, 'Jane Doe');
    assert.equal(first.company, 'Nimbus');

    await store.record({ profile_url: 'https://www.linkedin.com/in/jane', company: 'Nimbus Systems' });
    const updated = await store.getByProfileUrl('https://www.linkedin.com/in/jane');
    assert.equal(updated.company, 'Nimbus Systems');
    assert.equal(updated.name, 'Jane Doe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('getByProfileUrl returns null when no founder has been recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-founder-store-'));
  const store = new FounderStore(join(root, 'founders.json'));

  try {
    await store.initialize();
    assert.equal(await store.getByProfileUrl('https://www.linkedin.com/in/nobody'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list returns every founder most-recent-first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-founder-store-'));
  const store = new FounderStore(join(root, 'founders.json'));

  try {
    await store.initialize();
    await store.record({ profile_url: 'https://www.linkedin.com/in/a', name: 'A' });
    await store.record({ profile_url: 'https://www.linkedin.com/in/b', name: 'B' });
    const all = await store.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((founder) => founder.profile_url), ['https://www.linkedin.com/in/b', 'https://www.linkedin.com/in/a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
