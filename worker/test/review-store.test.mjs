import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ReviewStore } from '../src/review-store.mjs';

test('creates, lists, and decides review items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-review-'));
  const filePath = join(root, 'review-items.json');
  const store = new ReviewStore(filePath);

  try {
    await store.initialize();

    const item = await store.create({
      item_id: 'job-123',
      kind: 'job',
      title: 'Backend Engineer',
      source_url: 'https://jobs.example.com/backend-engineer',
      summary: 'Evidence-backed fit summary.',
      fit_score: '8',
      draft: 'Tailored draft',
      evidence: [{ label: 'Job posting', url: 'https://jobs.example.com/backend-engineer', note: 'Primary source' }]
    });

    assert.equal(item.status, 'pending');
    assert.equal(item.fit_score, 8);
    assert.equal(item.company_context, null);
    assert.equal(item.talking_points, null);

    const pending = await store.list({ status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, item.id);

    const approved = await store.decide(item.id, {
      action: 'approve',
      approval_id: item.approval_id,
      actor: 'tester',
      reason: 'Looks good'
    });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.decisions.at(-1).action, 'approve');

    await assert.rejects(
      store.decide(item.id, {
        action: 'reject',
        approval_id: item.approval_id,
        actor: 'tester'
      }),
      /already been decided/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create() persists optional company_context and talking_points fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-review-'));
  const filePath = join(root, 'review-items.json');
  const store = new ReviewStore(filePath);

  try {
    await store.initialize();

    const item = await store.create({
      item_id: 'https://www.linkedin.com/in/janedoe',
      kind: 'founder',
      title: 'Jane Doe — Nimbus Systems',
      source_url: 'https://www.linkedin.com/in/janedoe',
      summary: 'Generic value-add outreach drafted.',
      draft: 'Hey Jane, ...',
      company_context: 'Nimbus Systems builds fleet-management software for last-mile delivery.',
      talking_points: '- Point one\n- Point two'
    });

    assert.equal(item.company_context, 'Nimbus Systems builds fleet-management software for last-mile delivery.');
    assert.equal(item.talking_points, '- Point one\n- Point two');

    const [reloaded] = await store.list({ status: 'pending' });
    assert.equal(reloaded.company_context, item.company_context);
    assert.equal(reloaded.talking_points, item.talking_points);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

