import assert from 'node:assert/strict';
import test from 'node:test';
import { firecrawlSearch, firecrawlScrape } from '../src/firecrawl-client.mjs';

test('firecrawlSearch posts the query and maps web results', async () => {
  const results = await firecrawlSearch('remote backend engineer', {
    apiKey: 'fc-test',
    limit: 5,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.firecrawl.dev/v2/search');
      assert.equal(init.headers.authorization, 'Bearer fc-test');
      assert.deepEqual(JSON.parse(init.body), { query: 'remote backend engineer', limit: 5 });
      return new Response(JSON.stringify({
        success: true,
        data: { web: [{ url: 'https://acme.com/jobs/1', title: 'Backend Engineer', description: 'Remote role', position: 1 }] }
      }), { status: 200 });
    }
  });

  assert.deepEqual(results, [{ url: 'https://acme.com/jobs/1', title: 'Backend Engineer', description: 'Remote role' }]);
});

test('firecrawlSearch defaults to an empty array when no results are returned', async () => {
  const results = await firecrawlSearch('nothing found', {
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  });
  assert.deepEqual(results, []);
});

test('firecrawlScrape posts the url and returns markdown with title/location metadata', async () => {
  const result = await firecrawlScrape('https://acme.com/jobs/1', {
    apiKey: 'fc-test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.firecrawl.dev/v2/scrape');
      assert.deepEqual(JSON.parse(init.body), { url: 'https://acme.com/jobs/1', formats: ['markdown'] });
      return new Response(JSON.stringify({
        success: true,
        data: { markdown: '# Backend Engineer', metadata: { title: 'Backend Engineer', 'og:description': 'Remote — India' } }
      }), { status: 200 });
    }
  });

  assert.deepEqual(result, { markdown: '# Backend Engineer', title: 'Backend Engineer', location: 'Remote — India' });
});

test('throws with no apiKey configured', async () => {
  await assert.rejects(() => firecrawlSearch('query', { fetchImpl: async () => new Response('{}') }), /Firecrawl API key is not configured/);
});

test('classifies HTTP error statuses for the circuit breaker', async () => {
  const cases = [
    [401, 'unauthorized'],
    [429, 'rate_limited'],
    [402, 'quota_exhausted'],
    [403, 'quota_exhausted'],
    [500, 'unknown']
  ];

  for (const [status, errorType] of cases) {
    await assert.rejects(
      () => firecrawlScrape('https://acme.com/jobs/1', {
        apiKey: 'fc-test',
        fetchImpl: async () => new Response(JSON.stringify({ error: 'boom' }), { status })
      }),
      (error) => error.errorType === errorType
    );
  }
});

test('classifies an aborted request as a timeout', async () => {
  await assert.rejects(
    () => firecrawlScrape('https://acme.com/jobs/1', {
      apiKey: 'fc-test',
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    }),
    (error) => error.errorType === 'timeout' && error.message === 'Firecrawl request timed out'
  );
});
