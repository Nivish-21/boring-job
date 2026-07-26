import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewStore } from './review-store.mjs';
import { selectProvider } from './provider-selector.mjs';
import { verifyJob } from './job-verifier.mjs';
import { PipelineStore } from './pipeline-store.mjs';
import { JobPipeline } from './job-pipeline.mjs';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(moduleDir, '..', 'public');
const maxBodyBytes = 256 * 1024;
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve, reject) => {
  let size = 0;
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    size += Buffer.byteLength(chunk);
    if (size > maxBodyBytes) {
      reject(new Error('request body is too large'));
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('request body must be valid JSON')); }
  });
  req.on('error', reject);
});

const isAuthorized = (req, auth) => {
  if (!auth.user || !auth.password) return true;
  const header = req.headers.authorization || '';
  const expected = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  const provided = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
};

const sendUnauthorized = (res) => {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="Career-Ops review"', 'cache-control': 'no-store' });
  res.end('Authentication required');
};

const serveStatic = async (res, pathname) => {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const relativePath = normalize(requested).replace(/^[/\\]+/, '');
  const filePath = join(publicDir, relativePath);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 404, { ok: false, error: 'Not found' });
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return sendJson(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: 'Not found' });
  }
};

export const createApp = ({ store, pipeline, artifactDir, auth }) => createServer(async (req, res) => {
  const url = new URL(req.url, 'http://worker.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'career-ops-worker', artifactDir, review_store: 'ready' });
  }
  if (!isAuthorized(req, auth)) return sendUnauthorized(res);

  try {
    if (req.method === 'GET' && url.pathname === '/api/review/items') {
      const status = url.searchParams.get('status');
      if (status && !['pending', 'approved', 'rejected', 'expired'].includes(status)) return sendJson(res, 400, { ok: false, error: 'unknown status filter' });
      return sendJson(res, 200, { ok: true, items: await store.list({ status }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/review/items') {
      const item = await store.create(await readJson(req));
      return sendJson(res, 201, { ok: true, item });
    }
    if (req.method === 'POST' && url.pathname === '/api/providers/resolve') {
      const input = await readJson(req);
      return sendJson(res, 200, { ok: true, selection: selectProvider(input.source_url) });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/verify') {
      const input = await readJson(req);
      const result = await verifyJob(input.source_url);
      const status = result.liveness === 'closed' ? 410 : 200;
      return sendJson(res, status, { ok: result.liveness === 'live', result });
    }
    if (req.method === 'POST' && url.pathname === '/api/pipeline/jobs') {
      if (!pipeline) return sendJson(res, 503, { ok: false, error: 'job pipeline is unavailable' });
      const result = await pipeline.process(await readJson(req));
      return sendJson(res, 200, { ok: ['needs_review', 'duplicate'].includes(result.stage), result });
    }
    const decisionMatch = url.pathname.match(/^\/api\/review\/items\/([^/]+)\/decision$/);
    if (req.method === 'POST' && decisionMatch) {
      const item = await store.decide(decisionMatch[1], await readJson(req));
      return sendJson(res, 200, { ok: true, item, next: item.decisions.at(-1).action === 'approve' ? 'Approval recorded. An orchestrator may now prepare a supervised next step.' : 'Decision recorded.' });
    }
    if (req.method === 'POST' && ['/scan', '/verify', '/evaluate', '/generate'].includes(url.pathname)) {
      return sendJson(res, 501, { ok: false, error: 'Not implemented', route: url.pathname, next: 'Add a provider-specific handler before enabling this route in n8n.' });
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const status = /not found/.test(error.message) ? 404 : 400;
    sendJson(res, status, { ok: false, error: error.message });
  }
});

export const startWorker = async ({
  port = Number(process.env.PORT || 8080),
  artifactDir = process.env.ARTIFACT_DIR || '/app/artifacts',
  reviewDataDir = process.env.REVIEW_DATA_DIR || '/app/data',
  auth = { user: process.env.REVIEW_AUTH_USER || '', password: process.env.REVIEW_AUTH_PASSWORD || '' }
} = {}) => {
  if ((auth.user && !auth.password) || (!auth.user && auth.password)) {
    throw new Error('REVIEW_AUTH_USER and REVIEW_AUTH_PASSWORD must be set together');
  }

  const store = new ReviewStore(join(reviewDataDir, 'review-items.json'));
  await store.initialize();
  const pipelineStore = new PipelineStore(join(reviewDataDir, 'pipeline-jobs.json'));
  await pipelineStore.initialize();
  const pipeline = new JobPipeline({ store: pipelineStore, reviewStore: store, artifactDir });
  const server = createApp({ store, pipeline, artifactDir, auth });

  server.listen(port, '0.0.0.0', () => {
    console.log(`career-ops-worker listening on ${port}`);
    if (!auth.user && !auth.password) console.warn('Review authentication is disabled; keep the review dashboard bound to localhost.');
  });
  return server;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startWorker();
