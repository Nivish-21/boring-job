# Changelog

## 2026-08-04 — Automated daily job discovery pipeline (worker build)

Full plan in `docs/plan.md`. Built the worker-side code for open-ended daily job discovery,
replacing the manual-paste smoke test. n8n stays a thin scheduler; all logic lives in the
worker (testable, injectable-fetch style matching the existing codebase).

**Added:**
- `worker/src/firecrawl-client.mjs` — `firecrawlSearch`/`firecrawlScrape` fetch wrappers,
  classifies HTTP errors for the circuit breaker.
- `worker/src/apify-client.mjs` — `apifyScrape`, scrape-fallback only, same return shape as
  Firecrawl's scrape for drop-in use.
- `worker/src/provider-state-store.mjs` — circuit breaker (`isEnabled`/`recordSuccess`/
  `recordFailure`), atomic local JSON file, same pattern as `pipeline-store.mjs`.
- `worker/src/resume-catalog.mjs` — parses the 8-resume README table into structured buckets
  with pdf/docx paths.
- `worker/src/company-lookup.mjs` — two cheap Firecrawl searches for a company's official
  website + LinkedIn company page, filtered against a job-board denylist.
- `worker/src/fit-evaluator.mjs` — `classifyResumeBucket`, OpenAI-backed resume-bucket
  classification; degrades to `bucket_id: null` on any failure, never throws.
- `worker/src/job-discovery.mjs` — `discoverJobUrls`, `verifyDiscoveredUrl` (Firecrawl scrape
  first, Apify fallback, circuit-breaker gated), `DiscoveryRunner` (drives the pipeline over
  discovered URLs, tallies stage counts, stops at the daily cap).
- `docs/plan.md`, `docs/decisions.md`, `docs/changelog.md`, `docs/status.md` — did not exist
  before this block.

**Changed:**
- `worker/src/pipeline-store.mjs` — added `countCreatedSince(isoString)` for the daily lead
  cap (UTC-midnight reset).
- `worker/src/job-pipeline.mjs` — `JobPipeline` constructor gained optional `verifyFallback`,
  `resumeClassifier`, `resumeBuckets`, `companyLookup`, `dailyCap` (default 20), all
  backward-compatible with the existing 3-arg construction. `process()` now retries an
  unverified job through `verifyFallback`, checks the daily cap before spending any
  LLM/Firecrawl calls, and adds optional "Suggested resume"/"Company links" sections to the
  packet draft. `companyName()` now falls back to a hostname-derived guess for discovered
  (non-ATS) postings that have no ATS board/site field.
- `worker/src/server.mjs` — `startWorker()` now loads the resume catalog (degrades to `[]` if
  `RESUME_DIR` is missing, doesn't crash), constructs the `ProviderStateStore`, wires
  `verifyFallback`/`resumeClassifier`/`companyLookup`/`dailyCap` into the `JobPipeline`, and
  builds a `DiscoveryRunner`. New route: `POST /api/discovery/run`. New optional env vars:
  `RESUME_DIR`, `DISCOVERY_QUERY`, `DAILY_LEAD_CAP`, `APIFY_ACTOR_ID`.

**Why:** Replace manual job-lead pasting with a scheduled, open-ended discovery run that
surfaces ~20 fit-checked, resume-matched leads/day for human review — no auto-apply, no
auto-message, no founder/personal-contact scraping (see `docs/plan.md` scope).

**Tests:** 61/61 passing (`npm test` in `worker/`) — one new test file per new module, plus
extended coverage in `job-pipeline.test.mjs` and `server.test.mjs` for the new integration
points. Also smoke-tested `startWorker()` live: boots clean with a missing resume dir,
`/health` responds, `/api/discovery/run` fails cleanly (400, not a crash) with no Firecrawl key.

**Not yet done (see `docs/plan.md` Resume point):** `compose.yml` resume bind-mount + env
passthrough, `workflows/scheduled-job-discovery.json` n8n Cron trigger, `OPENAI_API_KEY`/
`APIFY_API_TOKEN` in `.env` (user to supply), and an end-to-end run against real discovered
postings.

## 2026-08-04 — Pushed pipeline build to GitHub

Committed and pushed the full job-discovery pipeline build above to `origin/main`
(`3031cba`). Before committing, redacted a real Firecrawl session key
(`fc-823d2...`, already used for a live API verification during the build) that had
been left in plaintext in `docs/plan.md`. Repo is private, but rotate that key before
reuse regardless — it was live-tested in a prior turn.

**Verification:** `git rev-parse main` matched `git ls-remote origin main` post-push
(per lessons: never trust push exit status/output alone).

## 2026-08-04 — First live discovery run, plus two bugs it surfaced (fixed)

Ran `docker compose up -d --build` with real `FIRECRAWL_API_KEY`/`APIFY_API_TOKEN` for the
first time (`OPENAI_API_KEY` still not supplied — resume classification degrades to `null` as
designed, everything else worked). `DAILY_LEAD_CAP` set to 3 for this first cautious test.
Resume bind mount confirmed working (8 resumes visible inside the container).

**Bug 1 — Firecrawl circuit breaker misclassification (see `docs/decisions.md`):**
`firecrawl-client.mjs`'s `classifyError` grouped HTTP 403 with 402 as `quota_exhausted`. A live
scrape hit a site returning 403 "we do not support this site" — a per-URL rejection, not a
quota signal — and the circuit breaker disabled Firecrawl **indefinitely**, forcing the rest of
that run onto the paid Apify fallback (confirmed against the real Apify dashboard: 3 paid runs,
$0.07 of a $5 budget, for a 3-item test). Fixed: 403 now maps to `unknown` (15-minute
auto-recovering cooldown). Test updated (`worker/test/firecrawl-client.test.mjs`).

**Bug 2 — no dedup before paying for verification (see `docs/decisions.md`):**
`JobPipeline.process()` called `verify()`/`verifyFallback()` (real Firecrawl/Apify cost) before
checking whether the URL had already been processed, and never persisted `manual_review`
(inconclusive verification) or `expired` (closed) outcomes at all — so a permanently
unscrapable URL would be re-verified, at cost, on every future discovery run forever. Fixed:
`process()` now computes the provider-derived stable ID from the URL alone (`selectProvider()`,
local, no network cost) as the first step, short-circuits to `duplicate` before calling
`verify()` if a record already exists, and persists non-live outcomes too
(`status: 'unverified'`/`'expired'`). Two new tests
(`worker/test/job-pipeline.test.mjs`) assert `verify()` is never called a second time for a
known-dead URL.

**Live verification:** re-ran discovery after both fixes — 5 of 6 discovered URLs
short-circuited to `duplicate` with zero Firecrawl/Apify calls; Apify wasn't invoked at all that
run. 63/63 tests passing project-wide.

**Not yet done:** `OPENAI_API_KEY` still needed for resume-bucket classification; a
credit/usage-tracking feature for the review dashboard was requested and is being scoped
separately (see `docs/plan.md`).
