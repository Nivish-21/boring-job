import assert from 'node:assert/strict';
import test from 'node:test';
import { apifyScrape, fetchFounderPosts } from '../src/apify-client.mjs';

test('apifyScrape posts to the default actor and maps the first dataset item', async () => {
  const result = await apifyScrape('https://acme.com/jobs/1', {
    apiToken: 'apify-test-token',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=apify-test-token');
      assert.deepEqual(JSON.parse(init.body), { startUrls: [{ url: 'https://acme.com/jobs/1' }], maxCrawlPages: 1, maxCrawlDepth: 0, saveMarkdown: true });
      return new Response(JSON.stringify([
        { markdown: '# Backend Engineer', metadata: { title: 'Backend Engineer' } }
      ]), { status: 200 });
    }
  });

  assert.deepEqual(result, { markdown: '# Backend Engineer', title: 'Backend Engineer', location: '' });
});

test('apifyScrape falls back to plain text when markdown is absent', async () => {
  const result = await apifyScrape('https://acme.com/jobs/1', {
    apiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([{ text: 'Backend Engineer role', metadata: {} }]), { status: 200 })
  });
  assert.equal(result.markdown, 'Backend Engineer role');
});

test('apifyScrape returns empty fields when the dataset has no items', async () => {
  const result = await apifyScrape('https://acme.com/jobs/1', {
    apiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 })
  });
  assert.deepEqual(result, { markdown: '', title: '', location: '' });
});

test('apifyScrape respects a custom actorId', async () => {
  await apifyScrape('https://acme.com/jobs/1', {
    apiToken: 'apify-test-token',
    actorId: 'custom~actor',
    fetchImpl: async (url) => {
      assert.match(url, /^https:\/\/api\.apify\.com\/v2\/acts\/custom~actor\/run-sync-get-dataset-items\?token=/);
      return new Response(JSON.stringify([]), { status: 200 });
    }
  });
});

test('throws with no apiToken configured', async () => {
  await assert.rejects(() => apifyScrape('https://acme.com/jobs/1', { fetchImpl: async () => new Response('[]') }), /Apify API token is not configured/);
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
      () => apifyScrape('https://acme.com/jobs/1', {
        apiToken: 'apify-test-token',
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status })
      }),
      (error) => error.errorType === errorType
    );
  }
});

test('classifies an aborted request as a timeout', async () => {
  await assert.rejects(
    () => apifyScrape('https://acme.com/jobs/1', {
      apiToken: 'apify-test-token',
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    }),
    (error) => error.errorType === 'timeout' && error.message === 'Apify request timed out'
  );
});

test('fetchFounderPosts posts to the harvestapi actor with targetUrls/maxPosts and maps content+postedAt', async () => {
  const result = await fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
    apiToken: 'apify-test-token',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.apify.com/v2/acts/harvestapi~linkedin-profile-posts/run-sync-get-dataset-items?token=apify-test-token');
      assert.deepEqual(JSON.parse(init.body), { targetUrls: ['https://www.linkedin.com/in/janedoe'], maxPosts: 5 });
      return new Response(JSON.stringify([
        { content: '  Hiring a PM  ', postedAt: { date: '2026-01-01T00:00:00.000Z' } }
      ]), { status: 200 });
    }
  });

  assert.deepEqual(result, [{ content: 'Hiring a PM', postedAt: '2026-01-01T00:00:00.000Z' }]);
});

test('fetchFounderPosts respects a custom actorId and maxPosts', async () => {
  await fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
    apiToken: 'apify-test-token',
    actorId: 'custom~posts-actor',
    maxPosts: 10,
    fetchImpl: async (url, init) => {
      assert.match(url, /^https:\/\/api\.apify\.com\/v2\/acts\/custom~posts-actor\/run-sync-get-dataset-items\?token=/);
      assert.deepEqual(JSON.parse(init.body).maxPosts, 10);
      return new Response(JSON.stringify([]), { status: 200 });
    }
  });
});

test('fetchFounderPosts filters out items with no usable content', async () => {
  const result = await fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
    apiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([
      { content: '', postedAt: { date: '2026-01-01T00:00:00.000Z' } },
      { postedAt: { date: '2026-01-01T00:00:00.000Z' } },
      { content: 'Real post', postedAt: { date: '2026-01-02T00:00:00.000Z' } }
    ]), { status: 200 })
  });

  assert.deepEqual(result, [{ content: 'Real post', postedAt: '2026-01-02T00:00:00.000Z' }]);
});

test('fetchFounderPosts returns an empty array when the dataset has no items', async () => {
  const result = await fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
    apiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 })
  });
  assert.deepEqual(result, []);
});

test('fetchFounderPosts throws with no apiToken configured', async () => {
  await assert.rejects(
    () => fetchFounderPosts('https://www.linkedin.com/in/janedoe', { fetchImpl: async () => new Response('[]') }),
    /Apify API token is not configured/
  );
});

test('fetchFounderPosts classifies HTTP error statuses for the circuit breaker', async () => {
  await assert.rejects(
    () => fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
      apiToken: 'apify-test-token',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 429 })
    }),
    (error) => error.errorType === 'rate_limited'
  );
});

test('fetchFounderPosts classifies an aborted request as a timeout', async () => {
  await assert.rejects(
    () => fetchFounderPosts('https://www.linkedin.com/in/janedoe', {
      apiToken: 'apify-test-token',
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    }),
    (error) => error.errorType === 'timeout' && error.message === 'Apify request timed out'
  );
});
