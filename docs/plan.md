# Plan: Automated daily job discovery pipeline

**Goal:** Replace the manual-paste smoke test with a scheduled n8n workflow that
discovers ~20 new, live, fit-checked job leads per day with no specific
companies pre-configured (open-ended discovery), attaches an existing tailored
resume where one matches, and queues everything for human review. No
auto-apply, no auto-message, no automated founder/personal-contact scraping.

## Assumptions (stated, not asked, per prior discussion)

- "20 job postings/day" means 20 that already passed liveness + eligibility
  gates, not 20 raw scrape hits.
- Company metadata capture is limited to the company's own public website URL
  and public LinkedIn *company* page URL — no personal founder contact
  discovery. That stays a separate, human-gated workflow per `PLAN.md` §9,
  built later if wanted.
- The 8 existing resumes in `/Users/nivish/Desktop/Nivish_Tailored_Resumes/`
  are the fixed target-role buckets for matching; a genuine no-match is
  queued for manual review, not auto-generated into a 9th variant.

## Architecture

```
n8n Cron (daily)
  -> Firecrawl `search` (open-ended query from targeting rules; Apify as
     fallback only if Firecrawl search/scrape fails or nears quota)
  -> normalize + dedupe against existing pipeline-store (stable_id)
  -> known-ATS jobs (Greenhouse/Lever/Ashby): existing job-verifier.mjs
     direct API path (already built, zero extra cost)
  -> other sources: Firecrawl `/scrape` (~1 credit/page, cheap markdown,
     NOT `/extract`) for liveness + JD text
  -> OpenAI (new fit-evaluator module): structure JD text into fields,
     fit-score JSON (per PLAN.md §8 schema), resume-bucket classification
     against the 8 existing resumes or "no_match"
  -> if matched: attach existing resume PDF (no generation cost)
  -> cheap Firecrawl `search` for company official website + company
     LinkedIn page URL, attached as passive metadata only
  -> write to existing review queue/dashboard, stop at ~20 qualifying
     leads/day
```

## Steps

- [x] Verified real Firecrawl API shapes live (`/v2/search` ->
      `{success,data:{web:[{url,title,description,position}]}}`,
      `/v2/scrape` -> `{success,data:{markdown,metadata:{title,ogTitle,
      'og:description',...}}}`, 401 on bad auth). Search cost ~2 credits for
      3 results (cheap); scrape is the ~1-credit/page path we're using
      instead of `/extract`.
- [x] `worker/src/firecrawl-client.mjs` — thin fetch wrapper for
      `firecrawlSearch`/`firecrawlScrape`, classifies errors
      (unauthorized/rate_limited/quota_exhausted/timeout/unknown) for the
      circuit breaker. Written, NOT yet tested.
- [x] `worker/src/apify-client.mjs` — `apifyScrape(url, {apiToken,
      actorId, fetchImpl})` via
      `POST https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items?token=...`.
      Default actor: `apify~website-content-crawler` (real, generic, public
      actor — not a specific choice the user confirmed, flag as a decision).
      Scope: **scrape fallback only**, not search/discovery (see Decisions).
      Returns `{markdown, title, location}` (same shape as
      `firecrawl-client.mjs`'s scrape) for drop-in fallback use in
      `job-discovery.mjs`. Tested (`test/apify-client.test.mjs`, 7 tests, all
      26 tests passing project-wide).
- [x] `worker/src/provider-state-store.mjs` — circuit breaker, same
      atomic-JSON-file pattern as `pipeline-store.mjs`/`review-store.mjs`:
      `isEnabled(provider)`, `recordSuccess(provider)`,
      `recordFailure(provider, {errorType, message, cooldownMs})`. No
      `cooldownMs` -> disabled indefinitely (matches the risk note: don't
      auto-retry a confirmed quota exhaustion). Tested
      (`test/provider-state-store.test.mjs`, 4 tests, 30 passing
      project-wide).
- [x] `worker/src/resume-catalog.mjs` — parses the pipe-table in
      `Nivish_Tailored_Resumes/README.md` (columns: #, File, Target Role, Fit
      Score, Positioning Angle) into `{id, pdf_path, docx_path, target_role,
      fit_score, positioning_angle}[]`. Table rows start with `|`; skip
      header+separator (first 2 `|`-lines), destructure
      `[num, file, targetRole, fitScore, positioningAngle]` per row. `id` is
      the zero-padded `#` (e.g. `"01"`). Verified against the real README —
      all 8 rows parse correctly with valid pdf/docx paths. Tested
      (`test/resume-catalog.test.mjs`, 2 tests, 32 passing project-wide).
- [x] `worker/src/company-lookup.mjs`: two cheap `firecrawlSearch`
      calls (`"<company> official website"`, `"<company> LinkedIn company
      page"`), filters results for a non-job-board domain / a
      `linkedin.com/company/` path. Public company metadata only — no
      personal contact/founder data (confirmed scope with user). Each search
      is independently caught so a Firecrawl failure degrades to `null`
      rather than throwing (matches company metadata's passive/non-blocking
      role). Tested (`test/company-lookup.test.mjs`, 5 tests, 37 passing
      project-wide).
- [x] `worker/src/fit-evaluator.mjs` — `classifyResumeBucket(job,
      buckets, {apiKey, fetchImpl, model})`: OpenAI chat completion,
      `response_format: json_object`, returns `{bucket_id|null, confidence,
      reason}`. Does NOT recompute fit_score/recommendation — the existing
      free deterministic `evaluateJob` in job-pipeline.mjs already does that
      and stays untouched/unaffected. On any OpenAI failure, degrade to
      `bucket_id: null` with reason set (never throw — classification is an
      enhancement, not a safety gate). A returned `bucket_id` not present in
      the given bucket list is treated as hallucinated and nulled out.
      Tested (`test/fit-evaluator.test.mjs`, 8 tests, 45 passing
      project-wide).
- [x] `worker/src/job-discovery.mjs`: `discoverJobUrls(query, {apiKey,
      limit})` via firecrawlSearch; `verifyDiscoveredUrl(sourceUrl, {
      firecrawlApiKey, apifyApiToken, apifyActorId, providerState,
      fetchImpl})` — only handles URLs where `selectProvider(url).provider
      === 'manual'` (i.e. NOT Greenhouse/Lever/Ashby, which keep using the
      existing free `verifyJob` path untouched). Tries Firecrawl scrape
      first (circuit-breaker gated), falls back to Apify scrape on
      failure/disabled, returns `unverified` if both fail. Also
      `DiscoveryRunner` class: loops discovered URLs through
      `pipeline.process()`, tallies stage counts, stops early on
      `daily_cap_reached`. Cooldowns: `rate_limited` 5min, `timeout`/`unknown`
      15min, `unauthorized`/`quota_exhausted` indefinite (matches the risk
      note on quota exhaustion). Job records use `manual:<source_url>` as
      `stable_id`. Tested (`test/job-discovery.test.mjs`, 8 tests, 53
      passing project-wide).
- [x] `worker/src/pipeline-store.mjs`: add `countCreatedSince(isoString)` —
      counts `status === 'needs_review'` jobs with `created_at >= isoString`,
      used for the daily cap (reset at UTC midnight). Tested
      (`test/pipeline-store.test.mjs`, 1 test, 54 passing project-wide).
- [x] `worker/src/job-pipeline.mjs`: extend `JobPipeline` constructor with
      optional `verifyFallback`, `resumeClassifier`, `resumeBuckets`,
      `companyLookup`, `dailyCap` (default 20) — ALL optional/backward
      compatible so the existing test file's 3-arg construction still works
      unchanged. In `process()`: after `this.verify()`, if result is
      `manual_review`/`unverified` and `verifyFallback` exists, retry via
      it. After the existing skip-gate, add a daily-cap check (return stage
      `daily_cap_reached`) BEFORE calling resumeClassifier/companyLookup (so
      capped-out runs don't spend LLM/Firecrawl calls). Extend `packetDraft`
      to add an optional "Suggested resume" section and "Company links"
      section when present. Extend `companyName()` helper to fall back to a
      hostname-derived guess (strip `www./careers./jobs./apply.`, drop TLD)
      when no ATS board/site field exists, so company-lookup has something
      to search for on discovered (non-ATS) postings. Fallback only triggers
      when `liveness === 'unverified'` (covers both the manual-provider case
      and an ATS check failure); a `closed` job is never retried. Tested
      (6 new tests in `test/job-pipeline.test.mjs`, 59 passing
      project-wide).
- [x] `worker/src/server.mjs`: on `startWorker()`, load resume catalog from
      `RESUME_DIR` (default `/app/resumes`, gracefully degrade to `[]` if
      missing — don't crash startup), construct `ProviderStateStore`, wire
      `DiscoveryRunner`, add route `POST /api/discovery/run` -> `await
      discoveryRunner.run()`. New env vars (all optional, sane defaults):
      `RESUME_DIR`, `DISCOVERY_QUERY`, `DAILY_LEAD_CAP` (also used as
      `discoveryRunner.limit = dailyCap * 2`, headroom over the cap since
      not every discovered URL passes verification+evaluation),
      `APIFY_ACTOR_ID`. `verifyFallback`/`resumeClassifier`/`companyLookup`
      are always wired (not conditionally on key presence) — each
      underlying module already degrades gracefully when its own API key is
      missing, so this stays a single source of truth for that behaviour.
      Smoke-tested live: boots clean with a missing `RESUME_DIR` (warns,
      doesn't crash), `/health` responds 200, `/api/discovery/run` returns a
      clean 400 (not a crash) with no Firecrawl key configured. Tested
      (3 new tests in `test/server.test.mjs`, 61 passing project-wide).
- [x] Tests for every new module (node:test + node:assert/strict, injectable
      `fetchImpl`, `mkdtemp` for store isolation — exactly like the existing
      `job-verifier.test.mjs`/`job-pipeline.test.mjs` pattern). 61/61 passing
      (`npm test` in `worker/`).
- [x] `compose.yml`: read-only bind mount (`RESUME_HOST_DIR`, defaults to
      `~/Desktop/Nivish_Tailored_Resumes`) `:/app/resumes:ro` on the `worker`
      service, plus env passthrough for `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
      `APIFY_API_TOKEN`, `RESUME_DIR`, `DISCOVERY_QUERY`, `DAILY_LEAD_CAP`,
      `APIFY_ACTOR_ID` (all `${VAR:-}` optional passthrough from `.env`).
      Validated with `docker compose config --quiet` (exit 0).
- [x] n8n workflow: `workflows/scheduled-job-discovery.json` — Schedule
      Trigger (daily) -> HTTP POST `http://worker:8080/api/discovery/run` ->
      done. Orchestration logic lives in the worker (testable code), n8n
      stays a thin scheduler per the user's own stated preference and
      `PLAN.md`'s architecture ("n8n: schedules... Worker: adapters..."). Usage
      documented in `workflows/README.md`, including the Basic Auth caveat
      when `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are set.
- [ ] Credentials: confirm `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
      `APIFY_API_TOKEN` are in `.env` (FIRECRAWL_API_KEY was used for the
      live API verification above — key value redacted, rotate before
      reuse). **Blocked — OpenAI/Apify keys still needed from the user; no
      `.env` file exists locally yet.**
- [x] docs/decisions.md: log (1) Firecrawl `/scrape`+OpenAI over `/extract`
      for cost, (2) Apify scoped to scrape-fallback only, actor choice
      `apify~website-content-crawler` unconfirmed by user, (3) circuit
      breaker as local JSON file store (matches existing pattern) rather
      than the unused Postgres container.
- [x] docs/changelog.md + docs/status.md: updated.
- [ ] Run end-to-end against a handful of real discovered postings, confirm
      review dashboard shows fit score, resume attachment (or no-match), and
      company metadata correctly. **Blocked on credentials above.**

## Resume point (updated 2026-08-04, second pass)

All worker code, `compose.yml`, and the n8n workflow are now built and tested.
Current state pushed to `origin/main` (`3031cba`). 61/61 tests passing
(`npm test` in `worker/`); `docker compose config --quiet` validates clean.

Remaining, in order — both blocked on the same missing credentials:
1. User supplies `OPENAI_API_KEY` and `APIFY_API_TOKEN` (create a local
   `.env` from `.env.example` — no `.env` file exists yet at all).
   `FIRECRAWL_API_KEY` still needed too (the earlier session's key was
   redacted from this doc and should be rotated, not reused).
2. End-to-end run against real discovered postings once keys are supplied:
   `docker compose up -d --build`, import `scheduled-job-discovery.json` (or
   trigger `POST /api/discovery/run` directly), confirm the review dashboard
   shows fit score, resume attachment (or no-match), and company metadata
   correctly.

No further design or build work is needed before that run — everything
downstream is already fully specified and implemented above.

## Risks

- Firecrawl and Apify free tiers are both finite; the circuit breaker must
  actually disable a provider on confirmed quota exhaustion rather than
  retry indefinitely.
- LLM resume-bucket matching can misclassify; fit-evaluator output keeps an
  evidence field and human review stays the final gate before any resume is
  used.
- Firecrawl's own `search` still costs credits for the company-lookup step;
  if volume becomes an issue, restrict it to `apply`/`maybe` recommendations
  only, not every discovered posting.

## New task block: provider credit-usage tracking in the review dashboard (2026-08-04)

**Goal:** Surface Firecrawl and Apify credit/usage spend directly in the existing review
dashboard (`localhost:8080`), so the user doesn't have to check each provider's website daily.

**Verified against real accounts (not assumed):**
- Firecrawl: `GET https://api.firecrawl.dev/v2/team/credit-usage` (same Bearer auth as every
  other Firecrawl call) → `{remainingCredits, planCredits, billingPeriodStart,
  billingPeriodEnd}`.
- Apify: `GET https://api.apify.com/v2/users/me/limits?token=<token>` →
  `current.monthlyUsageUsd` vs `limits.maxMonthlyUsageUsd`, plus `monthlyUsageCycle.startAt`/
  `endAt`.
- Both are account/billing metadata endpoints, distinct from scrape/search operations — nothing
  in either response suggests checking them costs credits, but this is an inference from
  endpoint shape, not a documented guarantee.

**Steps:**
- [x] `worker/src/usage-tracker.mjs` — `getFirecrawlUsage({apiKey, fetchImpl})` and
      `getApifyUsage({apiToken, fetchImpl})`, thin fetch wrappers matching the existing
      `firecrawl-client.mjs`/`apify-client.mjs` pattern (injectable `fetchImpl`, normalize to
      snake_case, degrade to `{error: '...'}` on failure or missing key rather than throwing —
      this is a monitoring nicety, not a pipeline-blocking dependency).
- [x] `worker/src/server.mjs` — new route `GET /api/usage`, auth-gated like every other API
      route, calls both and returns `{ok, firecrawl, apify}`.
- [x] `worker/public/` — usage strip in the dashboard header ("Firecrawl: 1,377 / 1,000 left"
      · "Apify: $4.82 / $5 left", both with their reset date), fetched once on page load
      alongside the existing queue load and again on manual refresh — no polling loop. Turns
      red (`.usage-warn`) when remaining drops to 20% or less of plan. Verified live in-browser
      against real Firecrawl/Apify accounts, plus a manual DOM check of the warning state.
- [x] Tests: `worker/test/usage-tracker.test.mjs` (7 tests, mocked `fetchImpl`) and a
      `server.test.mjs` case asserting no network call happens when neither key is configured.
      71/71 passing project-wide.
- [x] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — logged.

**Out of scope:** historical usage graphs, alerting/thresholds, per-run cost attribution.
Just current balance vs. plan limit, refreshed on dashboard load — a v1 read-only view.

## New task block: full job-listings view with company profiles (2026-08-04)

**Goal:** Show every job the pipeline has scraped and evaluated, not just the ones that reach
human review — user's explicit ask, plus company profile (website/LinkedIn) on every listing.

**Steps:**
- [x] `worker/src/pipeline-store.mjs` — `list({status})`, most-recent-first, optional filter.
- [x] `worker/src/server.mjs` — new `GET /api/pipeline/jobs` route, auth-gated, validates the
      status filter.
- [x] `worker/src/job-pipeline.mjs` — `companyLookup` moved earlier so it runs for every
      live-verified job (skipped + daily-capped, not just accepted); `skipped`/`needs_review`
      records now carry `title`/`location`/`company`/`company_links`; `daily_cap_reached` is
      now persisted (previously vanished with zero trace) but excluded from the
      pre-verification duplicate check so it stays retry-eligible; `unverified`/`expired`
      records now carry the verification `error` message.
- [x] `worker/public/` — new "All discovered jobs" section: title/source-url fallback, status
      badge, company name, fit score/skip reason, clickable company website/LinkedIn buttons.
- [x] Fixed a pre-existing CSS bug found while building this: `.button[hidden]` wasn't actually
      hidden (`.button`'s `display: inline-flex` overrode the UA `[hidden]` default) — silently
      affected the existing `.artifact-link` too, not just the new buttons.
- [x] Tests: 5 new (pipeline-store list/filter, skipped-job company persistence,
      daily_cap_reached persistence + retry-eligibility). 76/76 passing project-wide.
- [x] Verified live in-browser: rendering checked against real + pre-existing data, CSS fix
      confirmed via `getComputedStyle` before/after and a synthetic DOM injection.
- [x] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — logged.

**Known limitation, not solved this pass:** `daily_cap_reached` jobs still pay for
re-verification on every retry until they clear the cap — would need caching the verified job
body across runs to fix properly; out of scope here.

## New task block: discovery targeting fix + dashboard redesign (2026-08-04)

**Goal:** User flagged that most discovered jobs are "completely useless" and asked for a
smarter scraping strategy, plus a redesigned, filterable dashboard.

**Root cause found:** every URL the old generic discovery query found was a job-board hub/
category page (LinkedIn job-search page, WeWorkRemotely category page, etc.), never an
individual posting — not an eligibility-tuning problem, the wrong kind of page entirely.

**Steps:**
- [x] `worker/src/server.mjs` — `DEFAULT_DISCOVERY_QUERY` retargeted to
      `site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com`. Verified live
      against the real Firecrawl API before committing: 10/10 results valid, same 2-credit cost.
- [x] `worker/src/job-pipeline.mjs` — aggregator-hostname guard rejects known job-board hub
      domains before `verify()` is called (`status: 'rejected'`, zero cost). Excludes the ATS
      platforms themselves.
- [x] Tests: 2 new confirming aggregator URLs never call `verify()` and legitimate ATS/career
      URLs aren't rejected. 78/78 passing.
- [x] Verified live: re-ran discovery post-fix — 6/6 results were genuine ATS postings with
      real titles and real skip reasons; Apify usage unchanged (zero scrapes needed).
- [x] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — logged.
- [x] Dashboard redesign: merged the review queue and "All discovered jobs" sections into one
      filterable list with a sidebar (status checkboxes, company search, fit-score range).
      Defaults to "Pending review" checked so the approve/reject workflow doesn't regress.
      Functional/standard admin-dashboard layout over visual polish, per user's explicit
      priority ("usable, easily manageable, easily understandable... a certain set standard
      kind of thing"). Resolved the `rejected` status-name collision (`PipelineStore`'s
      aggregator-rejection vs `ReviewStore`'s human-rejection) by remapping the former to
      `aggregator_rejected` at merge time. Verified live in-browser: unified list renders all
      12 existing jobs, status/company/fit-score filters all work, clear-filters resets to
      show everything. 78/78 tests still passing (no backend change needed).

## New task block: resume content as LLM reference material (2026-08-04)

**Goal:** Right now `resume-catalog.mjs` only reads the README table's metadata (target role,
fit score, positioning angle) for each of the 8 resumes — the packet draft never sees the
actual resume text. User wants the LLM to reference the real resumes (structure, tone, actual
experience/phrasing) when generating packet drafts, so it can reuse real, already-approved
content instead of re-deriving from scratch or re-asking questions the resumes already answer.

**Flagged before planning further (see `docs/decisions.md` for the full note):** the user's
literal ask was to copy the 8 resume files into `docs/` in this repo. `docs/` is committed and
pushed to GitHub every session; the resumes contain full name, contact details, and complete
work history — real PII. Recommending against that specific location: putting them in git means
that data is in git history permanently (only removable by rewriting history), on a repo
actively being pushed. Proposed alternative below keeps the same benefit without that exposure.

**Approved 2026-08-04 — built as proposed:**
- [x] Extracted each resume's PDF to plain text (`firecrawl parse -f markdown`) into a new
      `reference/` subfolder inside `~/Desktop/Nivish_Tailored_Resumes/` — already bind-mounted
      read-only into the worker via `RESUME_HOST_DIR`, never part of this git repo. All 8
      extracted and verified readable (real name/contact/experience text confirmed present,
      confirming this data never needs to touch git to reach the worker).
- [x] `worker/src/resume-catalog.mjs` — `loadResumeCatalog` now also reads each bucket's
      `reference/<id>-<file>.txt` and attaches it as `reference_text`; degrades to `null` if the
      extraction is missing for a given bucket (doesn't fail catalog load).
- [x] `worker/src/job-pipeline.mjs`'s `packetDraft()` — when a matched resume bucket has
      `reference_text`, includes a capped (1,200-char, via the existing `cleanText` helper)
      excerpt under a "Reference resume excerpt" heading, alongside the existing target-role/
      positioning-angle line.
- [x] Tests: `resume-catalog.test.mjs` (new field + reference_text load/degrade), `job-pipeline
      .test.mjs` (excerpt present + capped when reference_text exists, absent when it doesn't).
      80/80 passing project-wide.
- [x] Verified live: rebuilt the image, confirmed `/app/resumes/reference/` is visible inside
      the running container via the existing mount (no `compose.yml` change needed), and
      confirmed `loadResumeCatalog()` actually attaches real extracted text at runtime.
- [x] `docs/decisions.md` — logged.

## New task block: drop n8n + postgres, replace with an in-worker scheduler (2026-08-04)

**Goal:** User pointed out (correctly) that n8n's only role in this project had become firing
one daily HTTP call — every other piece of logic already lives in tested worker code — and
asked why that needed n8n (plus Postgres, which existed solely as n8n's database) at all.

**Approved:** drop n8n + Postgres entirely; replace the daily trigger with a small in-worker
scheduler, zero new dependencies.

**Steps:**
- [x] `worker/src/scheduler.mjs` — `startDailyScheduler({ run, hourUtc, checkIntervalMs, now,
      scheduleImpl, log })`: polls every 15 min (default), fires `run()` once per UTC calendar
      day during `hourUtc`. In-memory-only `lastRunDate` (documented simplification — a restart
      mid-window could re-trigger once, tolerated by the pipeline's own dedup).
- [x] `worker/src/server.mjs` — wired in via `DISCOVERY_SCHEDULE_ENABLED` (default **off**,
      matching the old n8n workflow's `active: false` default) and `DISCOVERY_HOUR_UTC`
      (default 7).
- [x] `compose.yml` — removed the `postgres` and `n8n` services entirely; `worker` is now the
      only service. Validated with `docker compose config --quiet`.
- [x] `.env.example` — removed `N8N_*`/`POSTGRES_*`, added `DISCOVERY_SCHEDULE_ENABLED`/
      `DISCOVERY_HOUR_UTC`.
- [x] Removed `workflows/` (both workflow JSON files + its README) from git and disk — no
      longer applicable.
- [x] `README.md` — rewrote the sections that instructed opening n8n/generating its secrets;
      replaced with the manual-trigger curl command and the new scheduler env vars.
- [x] `PLAN.md` — left as the original design record (append-only), added a short dated note at
      the top pointing to this decision instead of rewriting its content.
- [x] Tests: `scheduler.test.mjs` (5 new — fires once per UTC hour/day, skips outside the
      target hour, tolerates a failing run, `stop()` clears the timer). 85/85 passing
      project-wide.
- [x] Stopped and removed the `boring-job-n8n-1`/`boring-job-postgres-1` containers. Left
      `data/n8n`/`data/postgres` on disk at the user's explicit choice, in case n8n gets
      revisited later for something it's actually suited to (see decisions.md).
- [x] `docs/decisions.md` — logged.

## Out of scope (this block)

- Founder/personal contact discovery, LinkedIn profile scraping, or outreach
  drafting — separate workflow, built later, human-provided input only.
- Auto-apply or auto-send of any kind.
- Generating a brand-new (9th) resume variant for no-match jobs — flag for
  manual review instead.
