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

**Not yet done:** `OPENAI_API_KEY` still needed for resume-bucket classification.

## 2026-08-04 — Firecrawl/Apify usage tracking in the review dashboard

Added a read-only usage strip to the review dashboard so the user can see current Firecrawl and
Apify spend without checking each provider's website (see `docs/decisions.md`).

**Added:**
- `worker/src/usage-tracker.mjs` — `getFirecrawlUsage`/`getApifyUsage`, thin fetch wrappers
  matching the existing provider-client pattern, degrade to `{error: '...'}` rather than throw.
- `worker/src/server.mjs` — new `GET /api/usage` route, auth-gated like every other API route.
- `worker/public/` — usage strip in the dashboard header, fetched on page load and manual
  refresh; turns red when either provider has 20% or less of its plan remaining.
- `worker/test/usage-tracker.test.mjs` (7 tests) and a `server.test.mjs` case confirming no
  network call happens when neither key is configured.

**Verified:** endpoints confirmed against real Firecrawl/Apify accounts before building
(`docs/decisions.md`); dashboard checked live in-browser showing real balances ("Firecrawl:
1,377 / 1,000 left", "Apify: $4.82 / $5 left"), plus a manual DOM check of the warning-color
state. 71/71 tests passing project-wide.

**Also decided this session:** keep the project on Node rather than migrating to Python/
FastAPI — user is learning Python but agreed a rewrite of an already-built, tested, live-
verified pipeline would be pure churn (see `docs/decisions.md`).

## 2026-08-04 — Full job-listings view with company profiles, plus a third dedup bug and a CSS bug

Added a complete "All discovered jobs" view to the dashboard, showing every job the pipeline
has ever seen — not just the pending-review queue (see `docs/decisions.md`).

**Added:**
- `worker/src/pipeline-store.mjs` — `list({status})`, most-recent-first, optional filter.
- `worker/src/server.mjs` — new `GET /api/pipeline/jobs` route, auth-gated, validates the
  `status` filter against the known set of statuses.
- `worker/public/` — new "All discovered jobs" section below the review queue: title (or
  source URL fallback for unverified/expired), status badge, company name, fit score/skip
  reason, and clickable "Company website"/"Company LinkedIn" buttons when available.

**Changed:**
- `worker/src/job-pipeline.mjs` — `companyLookup` now runs for every live-verified job
  (skipped and daily-capped, not just accepted), and the `skipped`/`needs_review` store
  records now carry `title`/`location`/`company`/`company_links`. `daily_cap_reached` is now
  persisted too (previously vanished with zero trace, the same unpersisted-record bug already
  fixed twice today for `manual_review`/`expired`) but is explicitly excluded from the
  pre-verification duplicate check so it stays eligible for a later run instead of being
  permanently lost. `unverified`/`expired` records now also carry the verification `error`
  message so the listing has something to show.
- `worker/public/styles.css` — fixed a real pre-existing bug: `.button[hidden]` was rendering
  visible because `.button`'s explicit `display: inline-flex` overrode the browser's default
  `[hidden] { display: none }` (author CSS always wins over the UA stylesheet regardless of
  specificity). This silently affected the existing `.artifact-link` before this session too,
  not just the two new company-link buttons added here. Confirmed via `getComputedStyle` in
  the live dashboard before and after the fix.

**Tests:** 5 new tests across `pipeline-store.test.mjs`, `job-pipeline.test.mjs`, and
`server.test.mjs` (list/filter behavior, company-profile persistence on skipped jobs,
daily_cap_reached persistence + retry-eligibility, the new route). 76/76 passing project-wide.

**Verified live:** rebuilt and checked the dashboard in-browser against real (partly
pre-existing, partly fresh) pipeline data; confirmed the CSS fix via `getComputedStyle` and a
synthetic DOM injection showing the company-link buttons render correctly both hidden and
visible.

**Known limitation, not solved today:** a `daily_cap_reached` job still pays for
re-verification on every retry until it clears the cap — avoiding that would mean caching the
verified job body across runs, out of scope for this pass.

## 2026-08-04 — Discovery re-targeted to ATS boards; aggregator pages rejected before verification

Root-caused why so much discovery was wasted: every URL the old generic query found was a
job-board hub/category page, not an individual posting (see `docs/decisions.md`).

**Changed:**
- `worker/src/server.mjs` — `DEFAULT_DISCOVERY_QUERY` now targets Greenhouse/Lever/Ashby via
  `site:` operators. Verified live: 10/10 results were valid ATS postings, same 2-credit cost
  as before.
- `worker/src/job-pipeline.mjs` — new aggregator-hostname guard rejects known job-board hub
  domains (LinkedIn, WeWorkRemotely, Wellfound, Indeed, Glassdoor, ZipRecruiter, Naukri,
  Monster, SimplyHired, BuiltIn, Crossover, RemoteRocketship) before `verify()` is ever called
  — persisted as `status: 'rejected'`, zero credit cost. Excludes the ATS platforms themselves.

**Tests:** 2 new (`job-pipeline.test.mjs`) confirming a known aggregator URL never calls
`verify()`, and that a legitimate ATS/career-page URL isn't rejected. 78/78 passing.

**Verified live:** re-ran discovery after the fix — 6/6 results were genuine ATS postings with
real titles and real skip reasons (senior-level requirements), not aggregator garbage. Apify
usage was unchanged (zero scrapes needed, free ATS verification for all 6); Firecrawl spend
matched exactly what the search + per-job company lookups should cost.

## 2026-08-04 — Dashboard redesign: one filterable list with a sidebar

Merged the review queue and "All discovered jobs" sections into a single unified,
client-side-filterable list (see `docs/decisions.md`).

**Changed:**
- `worker/public/index.html` — replaced the two sections + two `<template>`s with one sidebar
  (status checkboxes, company search, minimum-fit-score input, clear-filters button) and one
  results list using a single merged `#item-template`.
- `worker/public/app.js` — rewritten: `loadAll()` fetches `/api/pipeline/jobs` and
  `/api/review/items` (both unfiltered) in parallel, `buildCards()` merges them (review item is
  the source of truth for any job with a `review_item_id`; `PipelineStore`'s `'rejected'`
  remapped to `aggregator_rejected`), `applyFilters()`/`renderResults()` handle the sidebar.
  Approve/reject/regenerate actions only render for `status === 'pending'` cards.
- `worker/public/styles.css` — added `.layout`/`.sidebar`/`.filter-group`/`.results` grid,
  `.status-approved`/`.status-rejected`/`.status-aggregator_rejected` colors, widened `.shell`
  to `1180px` to fit the sidebar, sidebar collapses to full-width above the content below
  `820px`.

**No backend changes** — both endpoints already returned everything needed. 78/78 tests still
passing.

**Verified live:** rebuilt the image, checked in-browser — all 12 existing jobs render in the
unified list, status checkboxes/company search/fit-score filters all narrow the list correctly,
clear-filters resets to show everything.

## 2026-08-04 — Resume text as LLM reference material for packet drafts

Extracted each of the 8 tailored resumes to plain text and wired it into draft generation as
reference context (see `docs/decisions.md` for the PII/location reasoning).

**Added:**
- `~/Desktop/Nivish_Tailored_Resumes/reference/*.txt` (outside this repo) — one text extraction
  per resume via `firecrawl parse -f markdown`.

**Changed:**
- `worker/src/resume-catalog.mjs` — `loadResumeCatalog` now attaches `reference_text` per
  bucket from `reference/<id>-<file>.txt`, degrading to `null` if that file is missing.
- `worker/src/job-pipeline.mjs` — `packetDraft()` includes a capped (1,200-char) excerpt of the
  matched bucket's `reference_text` under "Reference resume excerpt" when present.

**Tests:** 2 new (`resume-catalog.test.mjs` reference_text load/degrade,
`job-pipeline.test.mjs` excerpt present + capped). 80/80 passing project-wide.

**Verified live:** rebuilt the image, confirmed `/app/resumes/reference/` is visible in the
running container through the existing bind mount, and confirmed `loadResumeCatalog()` attaches
real extracted text at runtime (no `compose.yml` change needed).

## 2026-08-04 — Dark theme, explicit "Discovered" timestamp, fit-score colour coding

Small dashboard follow-ups from using the n8n import side-by-side with the (previously
light-themed) dashboard.

**Changed:**
- `worker/public/styles.css` — full palette switched from light to dark (`color-scheme: dark`,
  near-black background, light text), matching n8n's own dark UI so switching tabs doesn't
  flash bright white. Added `--warn`/`--danger-bg` tokens and `.fit-good`/`.fit-maybe`/
  `.fit-poor` classes.
- `worker/public/index.html` — `<meta name="color-scheme">` updated to `dark`.
- `worker/public/app.js` — every card now shows an explicit "Discovered" row with the full
  date/time (previously only in the small meta subtitle). Fit score is colour-coded using the
  same thresholds as `evaluateJob()`'s own recommendation buckets (`>=7` green/apply, `>=5`
  amber/maybe, below red/skip) for at-a-glance scanning.

**Tests:** no backend change; 80/80 still passing. Verified live in-browser: dark palette
renders correctly, low fit scores (2/10, 4/10) render in red, Discovered row present on every
card.

## 2026-08-04 — Dropped n8n + Postgres for an in-worker scheduler

n8n's only role had become firing one daily HTTP call; removed it and its database along with it
(see `docs/decisions.md`).

**Added:**
- `worker/src/scheduler.mjs` — `startDailyScheduler`, polls every 15 min, fires once per UTC
  calendar day during a configurable hour. Zero new dependencies.
- `worker/test/scheduler.test.mjs` (5 tests).

**Changed:**
- `worker/src/server.mjs` — wires the scheduler into `startWorker()` via
  `DISCOVERY_SCHEDULE_ENABLED` (default off) / `DISCOVERY_HOUR_UTC` (default 7).
- `compose.yml` — removed the `postgres` and `n8n` services; `worker` is now the only service.
- `.env.example` — removed `N8N_*`/`POSTGRES_*`, added the two new schedule env vars.
- `README.md` — replaced the n8n setup/import instructions with the manual-trigger curl command
  and the new scheduler env vars.
- `PLAN.md` — added a dated note at the top pointing to this change; left the rest as the
  original design record.

**Removed:**
- `workflows/` directory (both workflow JSON files and its README) — no longer applicable.

**Tests:** 85/85 passing project-wide. `docker compose config --quiet` validates clean with the
single remaining service.

**Also done:** stopped and removed the `boring-job-n8n-1`/`boring-job-postgres-1` containers.
Left `data/n8n`/`data/postgres` on disk per the user's choice (reversible later without redoing
n8n's owner-account setup).

## 2026-08-04 — Founder-outreach feature (LinkedIn connections → drafted outreach)

Full design in `docs/plan.md` under "New task block: founder outreach from LinkedIn
connections". Built across several passes in one session (context-budget checkpoints logged
along the way in `docs/plan.md`/`docs/status.md`, not separate sessions). Identifies founders
among the user's LinkedIn connections (via an official, ToS-safe CSV export — no scraping of a
logged-in session), researches each founder's company, checks for a real open role through the
**unmodified** `JobPipeline`, and drafts a personalized outreach message for human review. Never
auto-sends.

**Added:**
- `worker/src/connections-catalog.mjs` — `parseConnectionsCsv` (scans past LinkedIn's `Notes:`
  preamble to the real header row, hand-rolled quoted-CSV-cell splitter), `isFounderTitle`,
  `filterFounders`.
- `worker/src/founder-store.mjs` — `FounderStore`, atomic-JSON store keyed by `profile_url` (same
  pattern as `pipeline-store.mjs`), so an already-researched founder is never re-processed.
- `worker/src/founder-outreach.mjs` — `findCareersUrl` (ATS-board-biased Firecrawl search, sorted
  so free-to-verify Greenhouse/Lever/Ashby URLs come first), `draftOutreachMessage` (OpenAI call
  shaped like `classifyResumeBucket`, degrades to `{message: null, reason}` on any failure),
  `FounderOutreachRunner` (per-founder: look up company → find careers URLs → run candidates
  through the unmodified pipeline, stop at the first real open role → draft the message →
  **always** create a review item, even when drafting fails, and always record the founder).
- `worker/src/server.mjs` — new route `POST /api/founders/import` (raw `text/csv` body, not
  JSON — added a `readText` sibling to the existing `readJson` body reader); `startWorker()` now
  constructs `FounderStore` + `FounderOutreachRunner`, reusing the same `pipeline`/
  `resumeBuckets`/`firecrawlApiKey` instances already built for job discovery.
- `worker/public/app.js`/`index.html`/`styles.css` — dashboard now renders `kind: 'founder'`
  review items (previously invisible — they have no pipeline-job counterpart), with a Job/Founder
  outreach badge and IST-specific timestamps for founder cards (job cards stay browser-local).
- Tests: `connections-catalog.test.mjs` (6), `founder-store.test.mjs` (3),
  `founder-outreach.test.mjs` (14), plus 2 new cases in `server.test.mjs` — 24 new tests.

**Verified live (not just unit tests):** an in-process HTTP round trip of the full CSV → parse →
filter → runner → review-item path against `createApp()`; a dashboard smoke test against seeded
`pipeline-jobs.json`/`review-items.json` data (one job card, one founder card) confirming the
badge, IST timestamp, evidence links, and company filter all render/behave correctly with zero
console errors.

**Tests:** 109/109 passing project-wide (85 previous + 24 new), zero regressions.

**Not yet done:** a live end-to-end run against a real LinkedIn CSV export and real
Firecrawl/OpenAI calls — blocked on the user supplying the CSV (and, optionally, confirming
`OPENAI_API_KEY`, still not supplied project-wide). See `docs/decisions.md` for the
implementation deviations made from the original design sketch.
