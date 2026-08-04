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

test('rejects known aggregator/job-board hub URLs without ever calling verify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let verifyCalls = 0;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => { verifyCalls += 1; return verifiedJob; }
  });

  try {
    const result = await pipeline.process({ source_url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs' });
    assert.equal(result.stage, 'rejected');
    assert.equal(result.record.status, 'rejected');
    assert.equal(verifyCalls, 0, 'a known aggregator URL must never pay for verification');

    const listed = await pipelineStore.list({ status: 'rejected' });
    assert.equal(listed.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not reject a legitimate ATS-hosted or single-company career page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => verifiedJob
  });

  try {
    const greenhouse = await pipeline.process({ source_url: verifiedJob.source_url });
    assert.notEqual(greenhouse.stage, 'rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('retries an unverified job through verifyFallback and continues normally on success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => ({ liveness: 'unverified', verification_status: 'manual_review', source_url: 'https://careers.acme.com/jobs/backend' }),
    verifyFallback: async () => verifiedJob
  });

  try {
    const result = await pipeline.process({ source_url: 'https://careers.acme.com/jobs/backend' });
    assert.equal(result.stage, 'needs_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not call verifyFallback when the primary verification already succeeded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let fallbackCalled = false;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => verifiedJob,
    verifyFallback: async () => { fallbackCalled = true; return verifiedJob; }
  });

  try {
    await pipeline.process({ source_url: verifiedJob.source_url });
    assert.equal(fallbackCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stops at the daily cap before spending a resumeClassifier call, but still looks up and persists the company profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let resumeClassifierCalled = false;
  let companyLookupCalled = false;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => verifiedJob,
    dailyCap: 0,
    resumeClassifier: async () => { resumeClassifierCalled = true; return { bucket_id: null }; },
    companyLookup: async () => { companyLookupCalled = true; return { website_url: 'https://acme.com', linkedin_url: null }; }
  });

  try {
    const result = await pipeline.process({ source_url: verifiedJob.source_url });
    assert.equal(result.stage, 'daily_cap_reached');
    assert.equal(resumeClassifierCalled, false);
    assert.equal(companyLookupCalled, true);
    assert.equal(result.record.status, 'daily_cap_reached');
    assert.equal(result.record.company_links.website_url, 'https://acme.com');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a daily_cap_reached job is retried (not treated as a permanent duplicate) on the next process() call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let verifyCalls = 0;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => { verifyCalls += 1; return verifiedJob; },
    dailyCap: 0
  });

  try {
    const first = await pipeline.process({ source_url: verifiedJob.source_url });
    assert.equal(first.stage, 'daily_cap_reached');
    const second = await pipeline.process({ source_url: verifiedJob.source_url });
    assert.equal(second.stage, 'daily_cap_reached');
    assert.equal(verifyCalls, 2, 'daily_cap_reached must not be short-circuited as a permanent duplicate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skipped jobs are still persisted with title, company, and company profile for the listings view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const skippedJob = {
    liveness: 'live', provider: 'greenhouse', board_token: 'acme', source_url: 'https://boards.greenhouse.io/acme/jobs/999',
    job: {
      stable_id: 'greenhouse:acme:999', title: 'Senior Android Engineer', source_url: 'https://boards.greenhouse.io/acme/jobs/999',
      location: 'US only', description_text: 'Senior Android engineer, 5 years of experience.'
    }
  };
  let companyLookupCalled = false;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => skippedJob,
    companyLookup: async () => { companyLookupCalled = true; return { website_url: 'https://acme.com', linkedin_url: 'https://www.linkedin.com/company/acme' }; }
  });

  try {
    const result = await pipeline.process({ source_url: skippedJob.source_url });
    assert.equal(result.stage, 'skipped');
    assert.equal(companyLookupCalled, true);
    assert.equal(result.record.title, 'Senior Android Engineer');
    assert.equal(result.record.company, 'acme');
    assert.equal(result.record.company_links.website_url, 'https://acme.com');

    const listed = await pipelineStore.list({ status: 'skipped' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'Senior Android Engineer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adds Suggested resume and Company links sections when a resumeClassifier and companyLookup are configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const buckets = [{ id: '01', target_role: 'Backend Software Engineer', pdf_path: '/app/resumes/01-Backend.pdf', positioning_angle: 'Node + Python depth' }];
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => verifiedJob,
    resumeBuckets: buckets,
    resumeClassifier: async () => ({ bucket_id: '01', confidence: 0.9, reason: 'Strong match' }),
    companyLookup: async () => ({ website_url: 'https://acme.com', linkedin_url: 'https://www.linkedin.com/company/acme' })
  });

  try {
    const result = await pipeline.process({ source_url: verifiedJob.source_url });
    const artifact = await readFile(result.artifact_path, 'utf8');
    assert.match(artifact, /## Suggested resume/);
    assert.match(artifact, /01-Backend\.pdf/);
    assert.match(artifact, /## Company links/);
    assert.match(artifact, /https:\/\/acme\.com/);
    assert.match(artifact, /linkedin\.com\/company\/acme/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('companyName falls back to a hostname-derived guess for discovered (non-ATS) postings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  const discoveredJob = {
    liveness: 'live', provider: 'manual', source_url: 'https://careers.stripe.com/jobs/backend',
    job: { stable_id: 'manual:https://careers.stripe.com/jobs/backend', title: 'Backend Engineer', source_url: 'https://careers.stripe.com/jobs/backend', location: 'Remote — India', description_text: 'Build Node.js and TypeScript APIs with Docker and PostgreSQL.' }
  };
  const pipeline = new JobPipeline({ store: pipelineStore, reviewStore, artifactDir: join(root, 'artifacts'), verify: async () => discoveredJob });

  try {
    const result = await pipeline.process({ source_url: discoveredJob.source_url });
    assert.equal(result.review.title, 'Backend Engineer — stripe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists a non-live verification outcome and never re-verifies that URL again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let verifyCalls = 0;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => { verifyCalls += 1; return { liveness: 'unverified', verification_status: 'checked', error: 'Firecrawl and Apify both failed.' }; }
  });

  try {
    const first = await pipeline.process({ source_url: 'https://careers.example.com/jobs/dead-end' });
    assert.equal(first.stage, 'manual_review');
    assert.equal(first.record.status, 'unverified');
    assert.equal(first.record.error, 'Firecrawl and Apify both failed.');
    assert.equal(verifyCalls, 1);

    const second = await pipeline.process({ source_url: 'https://careers.example.com/jobs/dead-end' });
    assert.equal(second.stage, 'duplicate');
    assert.equal(verifyCalls, 1, 'a known-dead URL must not pay for verification again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists a closed job as expired and never re-verifies that URL again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-ops-pipeline-'));
  const pipelineStore = new PipelineStore(join(root, 'pipeline.json'));
  const reviewStore = new ReviewStore(join(root, 'review.json'));
  await Promise.all([pipelineStore.initialize(), reviewStore.initialize()]);
  let verifyCalls = 0;
  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore,
    artifactDir: join(root, 'artifacts'),
    verify: async () => { verifyCalls += 1; return { liveness: 'closed', verification_status: 'checked', error: 'Greenhouse no longer returns this job posting.' }; }
  });

  try {
    const first = await pipeline.process({ source_url: 'https://boards.greenhouse.io/acme/jobs/999' });
    assert.equal(first.stage, 'expired');
    assert.equal(first.record.status, 'expired');

    const second = await pipeline.process({ source_url: 'https://boards.greenhouse.io/acme/jobs/999' });
    assert.equal(second.stage, 'duplicate');
    assert.equal(verifyCalls, 1, 'a closed job must not pay for verification again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
