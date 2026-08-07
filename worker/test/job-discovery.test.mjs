import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverJobUrls, verifyDiscoveredUrl, DiscoveryRunner } from '../src/job-discovery.mjs';

const fakeProviderState = () => {
  const disabled = new Set();
  const calls = { recordSuccess: [], recordFailure: [] };
  return {
    calls,
    async isEnabled(provider) { return !disabled.has(provider); },
    async recordSuccess(provider) { disabled.delete(provider); calls.recordSuccess.push(provider); },
    async recordFailure(provider, details) { disabled.add(provider); calls.recordFailure.push({ provider, ...details }); }
  };
};

test('discoverJobUrls returns the search result URLs', async () => {
  const urls = await discoverJobUrls('remote backend engineer', {
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { web: [{ url: 'https://acme.com/jobs/1', title: 'Backend' }, { url: 'https://other.com/jobs/2', title: 'Other' }] }
    }), { status: 200 })
  });
  assert.deepEqual(urls, ['https://acme.com/jobs/1', 'https://other.com/jobs/2']);
});

test('verifyDiscoveredUrl short-circuits known ATS providers instead of scraping', async () => {
  const result = await verifyDiscoveredUrl('https://boards.greenhouse.io/acme/jobs/123', {
    firecrawlApiKey: 'fc-test',
    fetchImpl: async () => { throw new Error('should not be called'); }
  });
  assert.equal(result.verification_status, 'not_applicable');
  assert.equal(result.liveness, 'unverified');
});

test('verifyDiscoveredUrl verifies a manual URL via Firecrawl scrape', async () => {
  const providerState = fakeProviderState();
  const result = await verifyDiscoveredUrl('https://careers.acme.com/jobs/backend', {
    firecrawlApiKey: 'fc-test',
    providerState,
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { markdown: '# Backend Engineer\nBuild things.', metadata: { title: 'Backend Engineer' } }
    }), { status: 200 })
  });
  assert.equal(result.liveness, 'live');
  assert.equal(result.job.stable_id, 'manual:https://careers.acme.com/jobs/backend');
  assert.equal(result.job.description_text, '# Backend Engineer\nBuild things.');
  assert.deepEqual(providerState.calls.recordSuccess, ['firecrawl']);
});

test('verifyDiscoveredUrl falls back to Apify when Firecrawl scrape fails', async () => {
  const providerState = fakeProviderState();
  let apifyCalled = false;
  const result = await verifyDiscoveredUrl('https://careers.acme.com/jobs/backend', {
    firecrawlApiKey: 'fc-test',
    apifyApiToken: 'apify-test',
    providerState,
    fetchImpl: async (url) => {
      if (url.toString().includes('firecrawl.dev')) return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      apifyCalled = true;
      return new Response(JSON.stringify([{ markdown: 'Backend role details', metadata: { title: 'Backend Engineer' } }]), { status: 200 });
    }
  });
  assert.equal(apifyCalled, true);
  assert.equal(result.liveness, 'live');
  assert.equal(result.job.description_text, 'Backend role details');
  assert.deepEqual(providerState.calls.recordFailure.map((c) => c.provider), ['firecrawl']);
  assert.deepEqual(providerState.calls.recordSuccess, ['apify']);
});

test('verifyDiscoveredUrl returns unverified when both providers fail', async () => {
  const providerState = fakeProviderState();
  const result = await verifyDiscoveredUrl('https://careers.acme.com/jobs/backend', {
    firecrawlApiKey: 'fc-test',
    apifyApiToken: 'apify-test',
    providerState,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 })
  });
  assert.equal(result.liveness, 'unverified');
  assert.equal(result.verification_status, 'checked');
  assert.equal(providerState.calls.recordFailure.length, 2);
});

test('verifyDiscoveredUrl skips Firecrawl entirely when the circuit breaker has it disabled', async () => {
  const providerState = fakeProviderState();
  await providerState.recordFailure('firecrawl', { errorType: 'quota_exhausted' });
  let firecrawlCalled = false;
  const result = await verifyDiscoveredUrl('https://careers.acme.com/jobs/backend', {
    firecrawlApiKey: 'fc-test',
    apifyApiToken: 'apify-test',
    providerState,
    fetchImpl: async (url) => {
      if (url.toString().includes('firecrawl.dev')) firecrawlCalled = true;
      return new Response(JSON.stringify([{ markdown: 'Backend role details', metadata: { title: 'Backend Engineer' } }]), { status: 200 });
    }
  });
  assert.equal(firecrawlCalled, false);
  assert.equal(result.liveness, 'live');
});

test('verifyDiscoveredUrl rejects a scraped page whose title is just the company homepage/hostname', async () => {
  const result = await verifyDiscoveredUrl('https://latentforce.ai/', {
    firecrawlApiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { markdown: 'Welcome to Latentforce, advanced AI solutions.', metadata: { title: 'Latentforce.ai' } }
    }), { status: 200 })
  });
  assert.equal(result.liveness, 'unverified');
  assert.match(result.error, /does not look like a specific job posting/);
});

test('verifyDiscoveredUrl rejects a scraped page whose title is the bare company name without its TLD', async () => {
  const result = await verifyDiscoveredUrl('https://latentforce.ai/careers', {
    firecrawlApiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { markdown: 'Open roles at Latentforce.', metadata: { title: 'Latentforce' } }
    }), { status: 200 })
  });
  assert.equal(result.liveness, 'unverified');
});

test('verifyDiscoveredUrl accepts a scraped page whose title is a real, specific job title', async () => {
  const result = await verifyDiscoveredUrl('https://latentforce.ai/careers/backend-engineer', {
    firecrawlApiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { markdown: 'We are hiring a backend engineer.', metadata: { title: 'Backend Engineer — Latentforce' } }
    }), { status: 200 })
  });
  assert.equal(result.liveness, 'live');
  assert.equal(result.job.title, 'Backend Engineer — Latentforce');
});

test('DiscoveryRunner processes discovered URLs through the pipeline and tallies stage counts', async () => {
  const processed = [];
  const pipeline = { process: async ({ source_url: sourceUrl }) => { processed.push(sourceUrl); return { stage: sourceUrl.includes('2') ? 'skipped' : 'needs_review' }; } };
  const runner = new DiscoveryRunner({
    pipeline,
    query: 'backend engineer',
    apiKey: 'fc-test',
    discoverUrls: async () => ['https://a.com/1', 'https://a.com/2']
  });

  const summary = await runner.run();
  assert.deepEqual(processed, ['https://a.com/1', 'https://a.com/2']);
  assert.deepEqual(summary, { discovered: 2, processed: 2, stage_counts: { needs_review: 1, skipped: 1 } });
});

test('DiscoveryRunner stops early once the daily cap is reached', async () => {
  const processed = [];
  const pipeline = { process: async ({ source_url: sourceUrl }) => { processed.push(sourceUrl); return { stage: 'daily_cap_reached' }; } };
  const runner = new DiscoveryRunner({
    pipeline,
    query: 'backend engineer',
    apiKey: 'fc-test',
    discoverUrls: async () => ['https://a.com/1', 'https://a.com/2', 'https://a.com/3']
  });

  const summary = await runner.run();
  assert.deepEqual(processed, ['https://a.com/1']);
  assert.equal(summary.processed, 1);
});
