import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { JobPipeline, evaluateJob } from '../src/job-pipeline.mjs';
import { PipelineStore } from '../src/pipeline-store.mjs';
import { ReviewStore } from '../src/review-store.mjs';

const verifiedJob = {
  liveness: 'live', provider: 'greenhouse', board_token: 'acme', source_url: 'https://boards.greenhouse.io/acme/jobs/123',
  job: {
    stable_id: 'greenhouse:acme:123', title: 'Backend Engineer', source_url: 'https://boards.greenhouse.io/acme/jobs/123',
    location: 'Remote — India', description_text: 'Build Node.js and TypeScript APIs with Docker and PostgreSQL. One year of experience is welcome.'
  }
};

test('evaluates hard restrictions before creating an application packet', () => {
  const evaluation = evaluateJob({ ...verifiedJob.job, location: 'US only', description_text: 'Senior Android engineer, 5 years of experience.' });
  assert.equal(evaluation.recommendation, 'skip');
  assert.match(evaluation.hard_gaps.join(' '), /location\/work authorization restriction/);
});

test('runs a verified job to a durable review item and deduplicates retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const pipeline = new JobPipeline({ store: pipelineStore, reviewStore, artifactDir: join(root, 'artifacts'), verify: async () => verifiedJob });

  try {
    const first = await pipeline.process({ source_url: verifiedJob.source_url, candidate: { name: 'Nivish', verified_facts: ['Built Node.js APIs.', 'Operated Docker services.'] } });
    assert.equal(first.stage, 'needs_review');
    assert.equal(first.review.status, 'pending');
    const artifact = await readFile(first.artifact_path, 'utf8');
    assert.match(artifact, /Built Node.js APIs/);
    assert.match(artifact, /needs_review/);

    const second = await pipeline.process({ source_url: verifiedJob.source_url });
    assert.equal(second.stage, 'duplicate');
    assert.equal((await reviewStore.list({ status: 'pending' })).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
