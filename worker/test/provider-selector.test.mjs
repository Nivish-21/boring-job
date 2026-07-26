import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeJobUrl, selectProvider } from '../src/provider-selector.mjs';

test('normalizes job URLs without discarding meaningful query parameters', () => {
  assert.equal(
    normalizeJobUrl('http://boards.greenhouse.io/acme/jobs/123/?utm_source=linkedin&ref=job&gh_src=abc&locale=en'),
    'https://boards.greenhouse.io/acme/jobs/123?locale=en'
  );
});

test('selects supported ATS providers from canonical job URLs', () => {
  assert.deepEqual(selectProvider('https://boards.greenhouse.io/acme/jobs/123?gh_jid=123'), {
    source_url: 'https://boards.greenhouse.io/acme/jobs/123',
    provider: 'greenhouse',
    board_token: 'acme',
    job_id: '123',
    verification_mode: 'public_adapter',
    reason: 'Use the greenhouse public adapter before considering a browser fallback.'
  });

  assert.equal(selectProvider('https://jobs.lever.co/acme/abc-123').provider, 'lever');
  assert.equal(selectProvider('https://jobs.ashbyhq.com/acme/def-456').provider, 'ashby');
});

test('routes unknown sources to manual review and rejects unsafe URLs', () => {
  assert.equal(selectProvider('https://careers.example.com/jobs/123').verification_mode, 'manual_review');
  assert.throws(() => normalizeJobUrl('file:///private/job.html'), /http or https/);
});
