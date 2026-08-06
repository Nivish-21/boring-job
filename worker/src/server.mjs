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
import { ProviderStateStore } from './provider-state-store.mjs';
import { loadResumeCatalog } from './resume-catalog.mjs';
import { lookupCompany } from './company-lookup.mjs';
import { classifyResumeBucket, selectVerifiedFacts } from './fit-evaluator.mjs';
import { discoverJobUrls, verifyDiscoveredUrl, DiscoveryRunner } from './job-discovery.mjs';
import { getFirecrawlUsage, getApifyUsage } from './usage-tracker.mjs';
import { startDailyScheduler } from './scheduler.mjs';
import { parseConnectionsCsv, filterFounders } from './connections-catalog.mjs';
import { FounderStore } from './founder-store.mjs';
import { FounderOutreachRunner } from './founder-outreach.mjs';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(moduleDir, '..', 'public');
const maxBodyBytes = 256 * 1024;
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
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
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});

const readJson = async (req) => {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('request body must be valid JSON'); }
};

const readText = async (req) => {
  const raw = await readBody(req);
  if (!raw.trim()) throw new Error('request body must not be empty');
  return raw;
};

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

const PIPELINE_JOB_STATUSES = ['needs_review', 'approved', 'skipped', 'expired', 'unverified', 'daily_cap_reached', 'rejected'];

export const createApp = ({ store, pipeline, pipelineStore, discoveryRunner, founderOutreachRunner, artifactDir, auth, firecrawlApiKey, apifyApiToken }) => createServer(async (req, res) => {
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
    if (req.method === 'GET' && url.pathname === '/api/pipeline/jobs') {
      if (!pipelineStore) return sendJson(res, 503, { ok: false, error: 'job pipeline is unavailable' });
      const status = url.searchParams.get('status');
      if (status && !PIPELINE_JOB_STATUSES.includes(status)) return sendJson(res, 400, { ok: false, error: 'unknown status filter' });
      return sendJson(res, 200, { ok: true, jobs: await pipelineStore.list({ status }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/discovery/run') {
      if (!discoveryRunner) return sendJson(res, 503, { ok: false, error: 'discovery runner is unavailable' });
      const result = await discoveryRunner.run();
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === 'POST' && url.pathname === '/api/founders/import') {
      if (!founderOutreachRunner) return sendJson(res, 503, { ok: false, error: 'founder outreach runner is unavailable' });
      const founders = filterFounders(parseConnectionsCsv(await readText(req)));
      const result = await founderOutreachRunner.run(founders);
      return sendJson(res, 200, { ok: true, result });
    }
    const regenerateMatch = url.pathname.match(/^\/api\/founders\/([^/]+)\/regenerate$/);
    if (req.method === 'POST' && regenerateMatch) {
      if (!founderOutreachRunner) return sendJson(res, 503, { ok: false, error: 'founder outreach runner is unavailable' });
      const item = await founderOutreachRunner.regenerateOne(decodeURIComponent(regenerateMatch[1]));
      return sendJson(res, 200, { ok: true, item });
    }
    const jobRegenerateMatch = url.pathname.match(/^\/api\/pipeline\/jobs\/([^/]+)\/regenerate$/);
    if (req.method === 'POST' && jobRegenerateMatch) {
      if (!pipeline) return sendJson(res, 503, { ok: false, error: 'job pipeline is unavailable' });
      const result = await pipeline.regenerateOne(decodeURIComponent(jobRegenerateMatch[1]));
      return sendJson(res, 200, { ok: true, item: result.review });
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const [firecrawl, apify] = await Promise.all([
        getFirecrawlUsage({ apiKey: firecrawlApiKey }),
        getApifyUsage({ apiToken: apifyApiToken })
      ]);
      return sendJson(res, 200, { ok: true, firecrawl, apify });
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

// Biased toward ATS-hosted boards (Greenhouse/Lever/Ashby): individual postings, not job-board
// hub pages, and free to verify via each ATS's public API once discovered (see docs/decisions.md).
const DEFAULT_DISCOVERY_QUERY = 'remote backend software engineer india (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)';

export const startWorker = async ({
  port = Number(process.env.PORT || 8080),
  artifactDir = process.env.ARTIFACT_DIR || '/app/artifacts',
  reviewDataDir = process.env.REVIEW_DATA_DIR || '/app/data',
  resumeDir = process.env.RESUME_DIR || '/app/resumes',
  discoveryQuery = process.env.DISCOVERY_QUERY || DEFAULT_DISCOVERY_QUERY,
  dailyCap = Number(process.env.DAILY_LEAD_CAP || 20),
  apifyActorId = process.env.APIFY_ACTOR_ID || undefined,
  openaiApiKey = process.env.OPENAI_API_KEY || '',
  candidateName = process.env.CANDIDATE_NAME || undefined,
  firecrawlApiKey = process.env.FIRECRAWL_API_KEY || '',
  apifyApiToken = process.env.APIFY_API_TOKEN || '',
  scheduleEnabled = process.env.DISCOVERY_SCHEDULE_ENABLED === 'true',
  scheduleHourUtc = Number(process.env.DISCOVERY_HOUR_UTC || 7),
  auth = { user: process.env.REVIEW_AUTH_USER || '', password: process.env.REVIEW_AUTH_PASSWORD || '' }
} = {}) => {
  if ((auth.user && !auth.password) || (!auth.user && auth.password)) {
    throw new Error('REVIEW_AUTH_USER and REVIEW_AUTH_PASSWORD must be set together');
  }

  const store = new ReviewStore(join(reviewDataDir, 'review-items.json'));
  await store.initialize();
  const pipelineStore = new PipelineStore(join(reviewDataDir, 'pipeline-jobs.json'));
  await pipelineStore.initialize();
  const providerState = new ProviderStateStore(join(reviewDataDir, 'provider-state.json'));
  await providerState.initialize();

  let resumeBuckets = [];
  try {
    resumeBuckets = await loadResumeCatalog(resumeDir);
  } catch (error) {
    console.warn(`Resume catalog unavailable at ${resumeDir} (${error.message}); continuing with no resume matching.`);
  }

  const verifyFallback = (sourceUrl) => verifyDiscoveredUrl(sourceUrl, { firecrawlApiKey, apifyApiToken, apifyActorId, providerState });
  const resumeClassifier = (job, buckets) => classifyResumeBucket(job, buckets, { apiKey: openaiApiKey });
  const companyLookup = (name) => lookupCompany(name, { apiKey: firecrawlApiKey });
  const factSelector = (job, resumeBucket) => selectVerifiedFacts(job, resumeBucket, { apiKey: openaiApiKey });

  const pipeline = new JobPipeline({
    store: pipelineStore,
    reviewStore: store,
    artifactDir,
    verifyFallback,
    resumeClassifier,
    resumeBuckets,
    companyLookup,
    dailyCap,
    defaultCandidate: { name: candidateName },
    factSelector
  });
  const discoveryRunner = new DiscoveryRunner({
    pipeline,
    discoverUrls: discoverJobUrls,
    query: discoveryQuery,
    apiKey: firecrawlApiKey,
    limit: dailyCap * 2
  });

  const founderStore = new FounderStore(join(reviewDataDir, 'founders.json'));
  await founderStore.initialize();
  const founderOutreachRunner = new FounderOutreachRunner({
    founderStore,
    reviewStore: store,
    pipeline,
    lookupCompany: companyLookup,
    resumeClassifier,
    resumeBuckets,
    firecrawlApiKey,
    openaiApiKey,
    apifyApiToken,
    cap: dailyCap
  });

  const server = createApp({ store, pipeline, pipelineStore, discoveryRunner, founderOutreachRunner, artifactDir, auth, firecrawlApiKey, apifyApiToken });

  server.listen(port, '0.0.0.0', () => {
    console.log(`career-ops-worker listening on ${port}`);
    if (!auth.user && !auth.password) console.warn('Review authentication is disabled; keep the review dashboard bound to localhost.');
    if (scheduleEnabled) {
      startDailyScheduler({ run: () => discoveryRunner.run(), hourUtc: scheduleHourUtc });
      console.log(`Daily discovery scheduler enabled, targeting ~${scheduleHourUtc}:00 UTC.`);
    } else {
      console.log('Daily discovery scheduler disabled (DISCOVERY_SCHEDULE_ENABLED=true to turn it on). Trigger manually via POST /api/discovery/run.');
    }
  });
  return server;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startWorker();
