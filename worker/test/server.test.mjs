import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/server.mjs';

const start = async (options) => {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const call = (server, { method = 'GET', path, body, headers = {} }) => new Promise((resolve, reject) => {
  const address = server.address();
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = request({
    host: '127.0.0.1',
    port: address.port,
    method,
    path,
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers
    }
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      const isJson = String(res.headers['content-type'] || '').includes('application/json');
      resolve({ status: res.statusCode, headers: res.headers, body: raw && isJson ? JSON.parse(raw) : raw || null });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('health is public while review APIs require configured Basic authentication', async () => {
  const store = { list: async () => [] };
  const server = await start({
    store,
    artifactDir: '/tmp/artifacts',
    auth: { user: 'reviewer', password: 'secret' }
  });

  try {
    const health = await call(server, { path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const unauthenticated = await call(server, { path: '/api/review/items' });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers['www-authenticate'], 'Basic realm="Career-Ops review"');

    const authorization = `Basic ${Buffer.from('reviewer:secret').toString('base64')}`;
    const authenticated = await call(server, {
      path: '/api/review/items?status=pending',
      headers: { authorization }
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(authenticated.body, { ok: true, items: [] });
  } finally {
    await close(server);
  }
});

test('rejects invalid review filters and malformed JSON without invoking the store', async () => {
  let createCalls = 0;
  const store = {
    list: async () => [],
    create: async () => { createCalls += 1; }
  };
  const server = await start({ store, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const badFilter = await call(server, { path: '/api/review/items?status=anything' });
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.error, 'unknown status filter');

    const address = server.address();
    const malformed = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/review/items', headers: { 'content-type': 'application/json' } }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end('{not-json');
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'request body must be valid JSON');
    assert.equal(createCalls, 0);
  } finally {
    await close(server);
  }
});

test('runs the pipeline endpoint only through the injected safe pipeline', async () => {
  const store = { list: async () => [] };
  const pipeline = {
    process: async (input) => ({ stage: 'needs_review', received: input, review: { id: 'review-1' } })
  };
  const server = await start({ store, pipeline, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const response = await call(server, {
      method: 'POST',
      path: '/api/pipeline/jobs',
      body: { source_url: 'https://boards.greenhouse.io/acme/jobs/123', candidate: { name: 'Nivish' } }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.result.received.candidate.name, 'Nivish');
  } finally {
    await close(server);
  }
});

test('lists pipeline jobs through the injected pipeline store, with status filtering', async () => {
  const store = { list: async () => [] };
  const jobs = [
    { stable_id: 'greenhouse:acme:1', status: 'needs_review', title: 'Backend Engineer' },
    { stable_id: 'greenhouse:acme:2', status: 'skipped', title: 'Senior Android Engineer' }
  ];
  const pipelineStore = { list: async ({ status } = {}) => jobs.filter((job) => !status || job.status === status) };
  const server = await start({ store, pipelineStore, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const all = await call(server, { path: '/api/pipeline/jobs' });
    assert.equal(all.status, 200);
    assert.equal(all.body.jobs.length, 2);

    const filtered = await call(server, { path: '/api/pipeline/jobs?status=skipped' });
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.jobs.map((job) => job.stable_id), ['greenhouse:acme:2']);

    const badFilter = await call(server, { path: '/api/pipeline/jobs?status=bogus' });
    assert.equal(badFilter.status, 400);
  } finally {
    await close(server);
  }
});

test('returns 503 from the pipeline jobs listing endpoint when no pipeline store is configured', async () => {
  const store = { list: async () => [] };
  const server = await start({ store, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const response = await call(server, { path: '/api/pipeline/jobs' });
    assert.equal(response.status, 503);
  } finally {
    await close(server);
  }
});

test('runs the discovery endpoint only through the injected discovery runner', async () => {
  const store = { list: async () => [] };
  let runCalled = false;
  const discoveryRunner = { run: async () => { runCalled = true; return { discovered: 3, processed: 3, stage_counts: { needs_review: 2, skipped: 1 } }; } };
  const server = await start({ store, discoveryRunner, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const response = await call(server, { method: 'POST', path: '/api/discovery/run' });
    assert.equal(response.status, 200);
    assert.equal(runCalled, true);
    assert.deepEqual(response.body.result, { discovered: 3, processed: 3, stage_counts: { needs_review: 2, skipped: 1 } });
  } finally {
    await close(server);
  }
});

test('returns 503 from the discovery endpoint when no discovery runner is configured', async () => {
  const store = { list: async () => [] };
  const server = await start({ store, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const response = await call(server, { method: 'POST', path: '/api/discovery/run' });
    assert.equal(response.status, 503);
  } finally {
    await close(server);
  }
});

test('runs the founder-import endpoint only through the injected founder outreach runner', async () => {
  const store = { list: async () => [] };
  let receivedFounders = null;
  const founderOutreachRunner = { run: async (founders) => { receivedFounders = founders; return { processed: 1, stage_counts: { processed: 1 } }; } };
  const server = await start({ store, founderOutreachRunner, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const address = server.address();
    const csv = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Doe,https://www.linkedin.com/in/janedoe,jane@x.com,Acme,Co-Founder,01 Jan 2026\nJohn,Smith,https://www.linkedin.com/in/johnsmith,,Acme,Engineer,02 Jan 2026\n';
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/founders/import', headers: { 'content-type': 'text/csv' } }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(csv);
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, result: { processed: 1, stage_counts: { processed: 1 } } });
    assert.equal(receivedFounders.length, 1);
    assert.equal(receivedFounders[0].first_name, 'Jane');
  } finally {
    await close(server);
  }
});

test('returns 503 from the founder-import endpoint when no founder outreach runner is configured', async () => {
  const store = { list: async () => [] };
  const server = await start({ store, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const address = server.address();
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/founders/import', headers: { 'content-type': 'text/csv' } }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end('First Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Doe,https://www.linkedin.com/in/jane,,Acme,Founder,01 Jan 2026\n');
    });
    assert.equal(response.status, 503);
  } finally {
    await close(server);
  }
});

test('returns firecrawl/apify usage errors without either key configured, with no network call', async () => {
  const store = { list: async () => [] };
  const server = await start({ store, artifactDir: '/tmp/artifacts', auth: { user: '', password: '' } });

  try {
    const response = await call(server, { path: '/api/usage' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true,
      firecrawl: { error: 'Firecrawl API key is not configured' },
      apify: { error: 'Apify API token is not configured' }
    });
  } finally {
    await close(server);
  }
});
