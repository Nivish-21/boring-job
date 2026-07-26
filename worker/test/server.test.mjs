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
