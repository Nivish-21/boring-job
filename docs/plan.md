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

## New task block: founder outreach from LinkedIn connections (2026-08-04) — PROPOSED, NOT STARTED

**Goal:** User wants to identify founders among their LinkedIn connections, research each
founder's company, and get a drafted (never sent) personalized outreach message per founder,
human-reviewed via the existing dashboard. Timestamps for this feature shown in IST.

**Explicitly not activated yet** — user said not to build/start this now; this block exists so
the request and the flagged concern below aren't lost before the next session.

**Flagged before any build (see docs/decisions.md once logged):** the user's original idea was
Apify/Firecrawl scraping the LinkedIn connections list directly. That list is only visible
logged into the account, so scraping it means handing real LinkedIn credentials to a scraper or
automating a logged-in session — both violate LinkedIn's Terms of Service and risk LinkedIn
banning the user's actual professional account, a materially worse and less reversible cost than
anything else built this session. Recommending against building that path.

**Proposed approach instead (not yet approved to build):**
- [ ] User manually exports connections via LinkedIn's own official data export (Settings &
      Privacy → "Get a copy of your data" → Connections) — a CSV with name, current
      position/company, connected date, profile URL. No scraping, no credentials shared.
- [ ] New worker module to parse that CSV and flag likely founders by title-keyword matching
      (Founder, Co-Founder, CEO, Founding Engineer, etc.) — local, free.
- [ ] Reuse `company-lookup.mjs` (already built/tested) to find each flagged founder's company
      website via public Firecrawl search — no login, same pattern already used for job-listing
      company profiles.
- [ ] Check the company for open roles by feeding it through the existing job-discovery path —
      look for a careers/jobs page or a Greenhouse/Lever/Ashby board under the company's name
      (`provider-selector.mjs` already detects these), then run any postings found through the
      unmodified `JobPipeline.process()` (same verification/fit-scoring/resume-matching every
      other job in this project already gets). User's own idea, added 2026-08-04: if a company
      has a real opening, draft the cold DM around that specific role instead of a generic
      "let's connect," with the resume match coming along for free. Reuses existing code
      end-to-end — no new discovery/verification/scoring logic needed for this part.
- [ ] New LLM step (same shape as `fit-evaluator.mjs`): scrape the company site, have the LLM
      summarize what they do and draft a specific value-add angle grounded in the user's real
      background (can reuse the resume `reference_text` wired in earlier). If step above found a
      matching open role, draft the message around that role; otherwise draft the generic
      value-add message.
- [ ] Drafts land in the existing review dashboard, same approve/reject/regenerate flow. Nothing
      auto-sends — matches this project's standing rule.
- [ ] Display timestamps for this feature in IST specifically.

**Approved to build 2026-08-04 (user asked "can you build a code for this?"). No postgres/n8n
needed** — confirmed this reuses the single-service worker architecture already in place
(file-based JSON stores, same pattern as everything else); answered directly, no new
infrastructure required.

**Paused mid-build 2026-08-04 — user going out, resume next session.** No code was written yet
(only re-read `pipeline-store.mjs`, `company-lookup.mjs`, `fit-evaluator.mjs` as patterns to
mirror). **Do not open the next session by asking for the LinkedIn connections CSV** — user was
explicit about this. Just resume building from the design below; the CSV/file question can wait
until the code actually needs it to run end-to-end.

**Design worked out, ready to implement next session:**
- `worker/src/connections-catalog.mjs` — `parseConnectionsCsv(csvText)`: LinkedIn's real export
  has a "Notes:" preamble before the actual header row (`First Name,Last Name,URL,Email
  Address,Company,Position,Connected On`), so the parser must scan for the line starting with
  `First Name,Last Name` rather than assuming line 0 is the header. Needs a small hand-rolled
  quoted-CSV-cell splitter (company/position names can contain commas) — no new dependency,
  matches this project's zero-runtime-dependency pattern (`worker/package.json` has none).
  Exports `isFounderTitle(position)` (keyword regex: founder, co-founder, cofounder, founding,
  ceo, chief executive) and `filterFounders(connections)`.
- `worker/src/founder-store.mjs` — new store, same atomic-JSON-file shape as `pipeline-store.mjs`
  (`record()`/`getByStableId()`/`list()`, keyed by `profile_url`), so a founder already processed
  on a prior run isn't re-researched (re-spending Firecrawl/OpenAI calls) on the next import.
- `worker/src/founder-outreach.mjs` — new module: `findCareersUrl(companyName, websiteUrl, ...)`
  (Firecrawl search biased toward `<company> careers`/`<company> jobs`, plus checking for a
  Greenhouse/Lever/Ashby board via the existing `provider-selector.mjs` detection), and
  `draftOutreachMessage({ founder, companySummary, matchedJob, resumeBucket }, { apiKey,
  fetchImpl, model })` — OpenAI call shaped exactly like `classifyResumeBucket()` in
  `fit-evaluator.mjs` (degrades to a null/reason result on any failure, never throws).
- `FounderOutreachRunner` (likely in `founder-outreach.mjs` or its own file): for each new
  founder — `lookupCompany()` (existing, unchanged) → `findCareersUrl()` → any job URLs found go
  through the **unmodified** `pipeline.process()` (the same `JobPipeline` instance already
  constructed in `startWorker()`) → draft the message (role-specific if a job matched, generic
  value-add otherwise) → `reviewStore.create({ kind: 'founder', item_id: profile_url, title:
  '<name> — <company>', source_url: profile_url, summary, draft, evidence: [company website,
  matched job if any] })`. **`ReviewStore` already accepts `kind: 'founder'`** — this was built
  into `review-store.mjs` from the start of the project, so no store schema change is needed
  there. Mark the founder processed via `founderStore.record()` regardless of outcome (mirrors
  the pipeline's own "persist every outcome, never re-pay for a dead end" rule).
- New route: `POST /api/founders/import` — accepts the raw CSV as the request body
  (`content-type: text/csv`), no file path/bind mount needed. Cap founders processed per import
  (mirror `dailyCap` — cost control, same reasoning as the job-discovery cap).
- **Dashboard gap to close:** `worker/public/app.js`'s `buildCards()` currently only iterates
  `pipelineJobs` and looks up a matching review item via `job.review_item_id` — a `kind:
  'founder'` review item has no pipeline-job counterpart, so it would never appear in the merged
  list as-is. Need to also render any review items *not* referenced by a pipeline job's
  `review_item_id` (currently that's only ever founder items). Add a "Founder outreach" vs "Job"
  badge/kind indicator on cards once both kinds are mixed in one list.
- IST timestamps: format founder-outreach card timestamps with
  `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ... })` explicitly (not
  `undefined`/browser-local like the job cards), since the user asked for IST specifically here.

**Resume point (2026-08-04, third pass — mid-build, stopped at a context-budget boundary, not a
pause request).** 3 of 7 build steps done. Built and NOT yet tested:

- [x] `worker/src/connections-catalog.mjs` — `parseConnectionsCsv` (scans for the `First
      Name,Last Name` header line, hand-rolled quoted-CSV-cell splitter), `isFounderTitle`
      (regex: founder/co-founder/founding/ceo/chief executive), `filterFounders`.
- [x] `worker/src/founder-store.mjs` — `FounderStore`, atomic-JSON-file pattern copied from
      `pipeline-store.mjs`, keyed by `profile_url` (`getByProfileUrl`/`list`/`record`).
- [x] `worker/src/founder-outreach.mjs` — built, deviates from the original sketch in a few
      places (flagged here for `docs/decisions.md`, not yet logged there):
      - `findCareersUrl(companyName, websiteUrl, {apiKey, limit, fetchImpl})`: two Firecrawl
        searches (ATS-site-scoped + company-hostname-scoped if `websiteUrl` known), results
        deduped and sorted so ATS-board URLs (verify for free) come before generic ones. Each
        search independently caught, same resilience pattern as `company-lookup.mjs`.
      - Company summarization is NOT a separate LLM step — a single Firecrawl scrape of the
        company website (capped 2,000 chars, degrades to `null` on any failure) is fed as raw
        context directly into the one `draftOutreachMessage` OpenAI call, which both
        summarizes and drafts in one prompt. Chose one LLM call over two to keep the shape
        identical to `fit-evaluator.mjs`'s single-call pattern and to not double OpenAI cost
        per founder.
      - `draftOutreachMessage({founder, companyContext, matchedJob, resumeBucket},
        {apiKey, fetchImpl, model})` — OpenAI call shaped exactly like `classifyResumeBucket`,
        degrades to `{message: null, reason}` on any failure, never throws.
      - `FounderOutreachRunner`: `run(founders)` loops an already-filtered founder array (CSV
        parsing/filtering happens in the route handler, not here), skips non-http
        `profile_url`s (boundary validation), skips founders already in `founderStore`, caps at
        `cap` (default 20, mirrors `dailyCap`) new founders per call. Per founder: looks up
        company → `findCareersUrl` → up to 3 candidate URLs through the **unmodified**
        `pipeline.process()`, stops at the first `needs_review` hit → if matched, classifies
        the resume bucket against that job via the injected `resumeClassifier` → drafts the
        message → **always** creates a `ReviewStore` item (`kind: 'founder'`), even when
        drafting failed (`draft: null`, reason folded into `summary`) — human review is
        pointless to hide, matches the project's "persist every outcome" rule. Marks the
        founder processed in `founderStore` regardless of outcome.
      - Constructor takes `firecrawlApiKey` AND `openaiApiKey` explicitly (not read from
        `process.env` inside the module) — matches this project's "no implicit/magic values
        inside a module, wire keys in from `startWorker()`" pattern used everywhere else.

**Done, step 4 (2026-08-04, fourth pass):**
- [x] `worker/src/server.mjs`: refactored `readJson` to share a new size-capped `readBody`
      helper with a sibling `readText` (raw string, non-empty check) — existing JSON-route
      behaviour unchanged, confirmed by the full 85/85 suite still passing. New route
      `POST /api/founders/import` (`content-type: text/csv`): `parseConnectionsCsv` →
      `filterFounders` → `founderOutreachRunner.run()` → `{ok, result}`; 503 when unwired,
      mirrors `discoveryRunner`'s pattern. `startWorker()` now constructs `FounderStore` +
      `FounderOutreachRunner`, reusing the same `pipeline`/`resumeBuckets`/`firecrawlApiKey`
      instances already built for job discovery — no new env vars needed. Caught and fixed one
      real bug before it shipped: a shorthand `lookupCompany` in the runner construction
      resolved to the *raw* imported function (no API key baked in) instead of the wrapped
      `companyLookup` closure `pipeline` already uses — fixed to `lookupCompany: companyLookup`.
      Verified live (not just unit-level): a 503 smoke test with no runner wired, and a full
      in-process CSV→parse→filter→runner→review-item round trip with injected fakes, both via
      real HTTP requests against `createApp()`.

**Done, step 5 (2026-08-04, fifth pass):**
- [x] `worker/public/app.js`: `buildCards()` now appends a second pass — any review item not
      referenced by a pipeline job's `review_item_id` renders as its own read-only-except-
      actions card. Added a `.kind` badge (Job / Founder outreach) next to the status badge in
      both the template (`index.html`) and CSS (`styles.css`, `.kind`/`.kind-founder`/
      `.badges`). Added `formatDateIst` (explicit `timeZone: 'Asia/Kolkata'`) and a
      `formatCardDate(card, value)` dispatcher so founder cards show IST specifically while job
      cards stay on browser-local, unchanged. Company filter parity for founder cards: derived
      from the review item's title (`"<name> — <company>"`, same separator
      `founder-outreach.mjs` already uses) rather than a new store field, since `ReviewStore`'s
      schema has no dedicated company column and changing it was out of scope for this step.
      Verified live (not just code review): ran the worker locally against seeded
      `pipeline-jobs.json`/`review-items.json` (one job item, one founder item, both `pending`)
      and drove the real dashboard in-browser — confirmed both badges render, the founder card's
      "Discovered"/"Expires" times resolve to IST (`04:30Z` → `10:00 am`, consistent with the
      explicit `Asia/Kolkata` formatter, not incidentally matching browser-local), the company
      filter narrows to just the founder card on "Nimbus", and zero console errors. Full 85/85
      backend test suite still passes (no backend files touched this step).

**Not started yet (in order):**
**Done, step 6 (2026-08-04, sixth pass):**
- [x] `worker/test/connections-catalog.test.mjs` (6 tests): header-preamble scan, quoted-comma
      cell, malformed-CSV throw, `isFounderTitle` positive/negative cases, `filterFounders`.
- [x] `worker/test/founder-store.test.mjs` (3 tests): upsert-by-`profile_url` merge semantics,
      null on unknown URL, most-recent-first `list()` — mirrors `pipeline-store.test.mjs`.
- [x] `worker/test/founder-outreach.test.mjs` (14 tests): `findCareersUrl` (ATS-priority sort,
      site-scoped query, degrade-to-`[]` on failure/no company), `draftOutreachMessage` (happy
      path + all four degrade paths, mirrors `fit-evaluator.test.mjs`), `FounderOutreachRunner
      .run()` (invalid `profile_url` skip, duplicate skip, cap stop, stops at first
      `needs_review` pipeline hit, always creates a review item + records the founder even when
      drafting fails).
- [x] `worker/test/server.test.mjs`: 2 new cases for `POST /api/founders/import` (runs through
      the injected runner and parses the CSV correctly; 503 when unwired).
- [x] Full suite: **109/109 passing** (85 previous + 24 new), zero regressions.

**Done, step 7 (2026-08-04, seventh and final pass):**
- [x] `docs/decisions.md` — logged the four implementation deviations from this sketch as their
      own dated entry ("Founder-outreach implementation deviations from the original design
      sketch").
- [x] `docs/changelog.md` — logged as one entry ("Founder-outreach feature (LinkedIn
      connections → drafted outreach)").
- [x] `docs/status.md` — "Current state" and "Active plan" rewritten to reflect the feature as
      built-and-tested-but-not-yet-run-live; stale "not built yet" dashboard-gap note removed
      from "Known issues"; "Next steps" now leads with the real LinkedIn CSV import, not more
      building.

**Feature build complete.** All 7 steps done, 109/109 tests passing. What's left is a live run
against real data (LinkedIn CSV export + `POST /api/founders/import`), not more code — see
`docs/status.md`'s "Active plan" section for the exact next actions.

**Do not re-derive the design above — read it, then continue directly from `server.mjs` wiring.**
No new architectural decisions needed; this is mechanical continuation of an already-approved,
already-substantially-built feature.

## New task block: founder-outreach regenerate path + prompt/model hardening (2026-08-05) — DONE

**Goal:** user reported the dashboard showed zero founder cards. Root cause was a stale Docker
image (`worker/public/` is baked in at build time, never rebuilt after the standalone-cards fix
landed 2026-08-04) — already fixed and verified this session (image rebuilt, served `app.js`
byte-identical to source, `docker compose ps` healthy). Investigating further surfaced three real,
separate problems that are the actual subject of this block:

1. **5 of the 12 founder drafts are stuck bad, with no way to fix them.** 3 are genuinely empty
   (`Thomas Marge`, `Vincent Y. Yang`, `Indranil Roy` — drafted during the since-fixed
   `temperature: 0.4` window, `draft_error` recorded, `draft: null`). 2 still carry literal
   unfilled placeholders (`Vibhav Gadwal`, `Kunal M` — drafted before the placeholder guard
   existed). `docs/status.md` describes an "approve/reject/regenerate" flow, but **no regenerate
   route exists** — `server.mjs` only has `POST /api/review/items/:id/decision` (approve/reject).
   Worse, `FounderOutreachRunner.run()` marks a founder processed in `founder-store.json`
   regardless of outcome, so re-running `/api/founders/import` silently skips these 5 forever as
   "duplicate."
2. **The prompt is measurably not being followed, with no backstop.** The system prompt already
   explicitly bans generic-compliment openers and gives a labelled bad example
   (`founder-outreach.mjs` lines 78-79), but live drafts still produce that exact pattern — e.g.
   Jayaveeran Kayarohanam's draft opens "I've been following RevGate's journey and am impressed by
   your innovative approach," nearly verbatim the prompt's own bad example. The existing
   placeholder guard (`PLACEHOLDER_PATTERN`, line 16) proves prompt-only instructions aren't
   reliable and a code-level backstop is needed — same principle should extend to banned
   generic-opener phrasing, not just placeholders.
3. **Model/reasoning-effort choice was never verified against the model's actual accepted
   parameters** — the same class of bug as the `temperature: 0.4` incident. `gpt-5.6-terra`
   rejecting non-default `temperature` is a strong signal it's a genuine reasoning-class model, on
   which OpenAI's `reasoning_effort` param (`minimal`/`low`/`medium`/`high` depending on model,
   confirmed live via web search against `developers.openai.com/api/docs/guides/reasoning`) may
   apply — but this must be verified with a real API call against `gpt-5.6-terra` specifically
   before wiring it in, not assumed from the model family name.

**Steps — all done, completed 2026-08-05:**
- [x] `founder-outreach.mjs`: `FounderOutreachRunner.regenerateOne(profileUrl)` — wraps the
      existing private `#processFounder()` directly, reconstructs a founder-shaped input from the
      stored `founder-store.json` record, rejects the old review item via `reviewStore.decide()`
      before creating the new one. No store schema changes needed.
- [x] `server.mjs`: new route `POST /api/founders/:profileUrl/regenerate`, 404 on unknown
      profile_url, 503 when unwired.
- [x] `worker/public/app.js`: the dashboard's "Regenerate" button already existed in
      `index.html`/`styles.css` (built 2026-08-04) but called `ReviewStore.decide()`'s
      `'regenerate'` action, which only flips status back to `pending` and never touches draft
      content — a pre-existing dead end. `decide()` now routes founder-kind regenerate clicks to
      the new endpoint; no new markup needed.
- [x] `founder-outreach.mjs` prompt: explicit banned-phrase list added to the system prompt, plus
      a matching code-level `GENERIC_OPENER_PATTERN` backstop.
- [x] Empirically verified (real API call) that `gpt-5.6-terra` accepts `reasoning_effort`
      (`none`/`low`/`medium`/`high`/`xhigh`); wired in `'high'`. Logged in `docs/decisions.md`.
- [x] Regenerated all 5 known-bad drafts live via the new endpoint — all now clean (in the char
      cap, no placeholders, no banned phrases, specific asks). Aravind Jayendran's
      LatentForce/LatentGraph naming issue is a separate, still-unresolved known issue for human
      review, correctly not auto-corrected by any of this.
- [x] Tests: 10 new (`founder-outreach.test.mjs`: generic-opener guard, `reasoning_effort` in the
      request body, `regenerateOne` happy path + unknown-profile-url; `server.test.mjs`: new route
      success/404/503). 119/119 passing project-wide (up from 109).
- [x] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — logged; corrected the stale "9
      processed" claim to the real 12 everywhere it appeared.
- [x] Deployed: `docker compose build worker && docker compose up -d worker`, served `app.js`
      re-verified byte-identical to source, container healthy.

**Out of scope:** persisting `companyContext`/`matchedJob` to avoid re-scraping on regenerate —
re-running the full per-founder path costs a few Firecrawl/OpenAI calls, acceptable for a
human-triggered, low-volume regenerate action; not worth a schema change.

**Block complete.** All steps done, deployed, and live-verified (not just unit-tested) — 5/5
regenerated drafts confirmed clean via the real running API. Nothing left open in this block; the
Aravind Jayendran naming mismatch remains a separate, tracked known issue (see `docs/status.md`
"Next steps"), not part of this block's scope.

## New task block: fix the 285-char limit — wrong LinkedIn product (2026-08-05) — DONE (expanded mid-execution to include voice matching, see below)

**Goal:** the `MAX_MESSAGE_CHARS = 285` constant is based on LinkedIn's connection-request-note
limit. Every founder this feature processes is already a 1st-degree connection (the feature only
exists because it reads the user's own connections export), so the actual message sent is a
regular direct message, not a connection-request note. **User caught this, correctly** — a real
design mistake, not a preference tweak. Verified live (web search, multiple independent sources —
LeadLoft, LaGrowthMachine, LinkedFusion): connection-request notes cap at 300 chars, regular
messages to existing 1st-degree connections cap at ~8,000 chars.

**User's direction (asked, not assumed):** no fixed target length — let the model decide per
founder based on how much real content there is to say, with the 8,000-char figure as a hard
safety backstop in code only, not a target the prompt aims for.

**Steps — all done:**
- [x] `founder-outreach.mjs`: `MAX_MESSAGE_CHARS` → `8_000`, comment updated (safety backstop,
      not a style target).
- [x] System prompt rewritten: no fixed length target, "write however long it needs to be,"
      updated good/bad examples.
- [x] `truncateToWordBoundary` kept as the code-level backstop at the new 8,000-char ceiling.
- [x] Tests updated: the two 285-specific tests now target 8,000; added a case confirming a
      genuinely substantive ~800-char message is untouched.
- [x] Regenerated all 12 pending founder drafts via `regenerateOne`.
- [x] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — logged.

**Expanded mid-execution (user feedback after seeing the first regenerate pass):** drafts still
read as AI-written despite passing every guard — repeated template opener, em dashes. User
provided one real writing sample live in conversation (no saved samples existed). Extracted
concrete style markers (casual opener, "and"-chained sentences, no em dashes, low-key ask), added
as `USER_VOICE_SAMPLE` prompt reference (structure/tone only, same framing as resume
`reference_text`), added `EM_DASH_PATTERN` code-level guard, rewrote hard rules and both examples
to match, regenerated all 12 a second time. Along the way, investigated (not assumed) an
apparent-hallucination in Aravind Jayendran's draft — "Cabocab" confirmed real via `grep` against
the actual resume files; "LatentForce" vs. "LatentGraph" confirmed NOT an error via a live
Firecrawl scrape of the real company site (LatentForce = company, LatentGraph = their actual
product) — closed a known-issue that had been open since 2026-08-04 without ever being a real bug.
Final state: all 12 pass every guard (placeholder, generic-opener, em dash) with zero flags.

**Out of scope:** InMail (LinkedIn's paid messaging product for non-connections) — not applicable
here since every processed founder is already a connection; not building any InMail-specific path.

**Block complete.** Both the character-limit fix and the voice-matching follow-on are done,
tested (121/121 passing), deployed, and live-verified against the real running API — all 12
founder drafts regenerated and manually reviewed for quality, guard compliance, and grounding.

## New task block: dashboard restructure (job vs. founder-outreach) — DONE (2026-08-05)

**Goal:** user reported the review dashboard was "not structured... I don't know which one to
send to whom" — job-application packets and founder-outreach DMs were interleaved in one flat
list titled "Job listings," with no way to filter by kind and no explicit "send this" action on
founder cards.

**Routed through the impeccable skill's `layout` command** (scoped fix to existing code, register:
Operate/product — dashboard/tool). Mechanical scan (`detect.mjs`) came back clean, confirming this
was a structural/hierarchy problem, not a decoration problem.

**Steps — all done:**
- [x] `index.html`: added a `role="tablist"` with two tabs ("Founder outreach (N)" / "Job
      applications (N)"), rewrote the masthead header/lede to describe both content types instead
      of only jobs, added a "Copy message" button to the card template.
- [x] `styles.css`: `.tabs`/`.tab` styled consistent with the existing OKLCH dark system and
      button vocabulary — underline-indicator tabs (a standard, non-invented affordance per
      Operate-mode "product permissions"), no new color introduced beyond the existing `--primary`
      accent.
- [x] `app.js`: `activeKind` state (defaults to `founder`, the more time-sensitive to-do list),
      `applyFilters` now filters by kind first, tab click handlers, per-kind counts, the
      "Minimum fit score" filter auto-hides on the Founder tab (always null there — Operate-mode
      "don't show a dead control"). Added `copyDraft()` (clipboard write + "Copied!"/"Copy failed"
      feedback, 1.8s revert) wired to founder cards specifically; downgrades "Approve" to
      secondary styling on those cards so there's one clear primary action, not two blue buttons.
- [x] Verified live in-browser (not just source review): both tabs render, switch correctly,
      counts and filters behave per-kind, squint test passes (primary/secondary/groups legible at
      a glance). 121/121 backend tests still passing (no backend touched). Deployed
      (`docker compose build && up -d worker`), served `app.js` re-verified byte-identical to
      source.
- [~] **Copy-button clipboard write could not be fully verified in this session** — a
      `navigator.clipboard.writeText()` call from an automated (Claude-in-Chrome) click appears to
      hang waiting on a permission prompt, timing out a CDP eval call. This is very likely an
      automation-environment artifact (Chrome auto-grants `clipboard-write` for a *trusted* user
      gesture in a secure context with no prompt at all; a synthetic automated click may not count
      as trusted) rather than a real bug, but this was **not independently confirmed** — user
      should manually click "Copy message" once in their own real browser and confirm it works
      before relying on it.

**Follow-up, not yet started (see next block):** while reviewing a job-application packet on the
newly-separated Job applications tab, user found the draft itself uses the literal placeholder
"Candidate" as the applicant's name and an unfilled "Add verified candidate facts" stub — a
separate, real defect in `job-pipeline.mjs`, not part of this dashboard-structure block.

## New task block: fix placeholder "Candidate" name and empty facts stub in job packets (2026-08-05) — PROPOSED, NOT STARTED

**Goal:** every job-application packet `packetDraft()` has ever generated says `"I'm Candidate...
Best, Candidate"` and `"Add verified candidate facts before using this draft."` — user caught this
live while reviewing a real packet on the newly-split Job applications tab.

**Root cause (confirmed, not guessed):** `packetDraft(job, evaluation, candidate, ...)` in
`job-pipeline.mjs` (line 62-73) is a plain template function, not an LLM call. It reads
`candidate?.name` (falls back to the literal string `'Candidate'`) and
`candidate?.verified_facts` (falls back to the stub line) — but **no caller anywhere in the
codebase ever supplies a `candidate` object**. Checked every call site of `pipeline.process()`:
`job-discovery.mjs`, `founder-outreach.mjs`, and the manual `POST /api/pipeline/jobs` route all
omit it. This is a scaffolded-but-never-wired feature, not a regression — every one of the current
32 job packets has this defect.

**User's direction (asked, not assumed):** the "verified candidate facts" section should be filled
by a new LLM call that selects 3-5 real facts per job from the matched resume's `reference_text`
(not a fixed static list) — same tradeoff already made for founder-outreach: costs a real OpenAI
call per packet, but more relevant per posting.

**Steps:**
- [ ] `fit-evaluator.mjs`: add `selectVerifiedFacts(job, resumeBucket, {apiKey, fetchImpl, model})`
      — mirrors `classifyResumeBucket`'s exact shape (gpt-4o-mini, `temperature: 0`,
      `response_format: json_object`, degrades to `{facts: [], reason}` on any failure/missing
      key/no resumeBucket, never throws). Prompt: extract 3-5 concrete facts *from
      `resumeBucket.reference_text` only*, relevant to this specific job — explicit "never invent,
      only extract or lightly paraphrase what's literally in the text" rule (same grounding
      discipline as the founder-outreach guards). Returns `{facts: string[], reason: string}`.
- [ ] `job-pipeline.mjs`: `JobPipeline` constructor gains `defaultCandidate = null` (static
      `{name}`) and `factSelector = null` (mirrors `resumeClassifier`'s injection pattern exactly).
      In `process()`, after `resumeBucket` is resolved: merge `defaultCandidate` with any
      explicitly-passed `candidate` (explicit always wins), and only call `factSelector` when the
      merged candidate has no `verified_facts` yet AND a `resumeBucket` matched AND `factSelector`
      is wired. Pass the merged candidate into the **unchanged** `packetDraft()` — no signature
      change needed there at all.
- [ ] `server.mjs`: new env var `CANDIDATE_NAME` (unset degrades to the existing `'Candidate'`
      fallback, so nothing crashes for a user who hasn't configured it). Wire
      `factSelector = (job, resumeBucket) => selectVerifiedFacts(job, resumeBucket, {apiKey:
      openaiApiKey})` and `defaultCandidate = { name: process.env.CANDIDATE_NAME || undefined }`
      into `new JobPipeline({...})`.
- [ ] `.env.example`: add `CANDIDATE_NAME=` with a comment; real value goes in the user's own
      `.env` (their actual name, not committed).
- [ ] Tests: `fit-evaluator.test.mjs` for `selectVerifiedFacts` (happy path + every degrade path,
      mirrors `classifyResumeBucket`'s existing test shape); `job-pipeline.test.mjs` for the new
      merge/injection logic in `process()` (defaultCandidate name flows through when no explicit
      candidate given; factSelector only fires when no facts already present AND a resumeBucket
      matched; an explicitly-passed candidate with its own `verified_facts` is never overridden).
- [ ] `docs/decisions.md`/`docs/changelog.md`/`docs/status.md` — log the root cause and fix.

**Known limitation, flagged up front, not solved by this block:** there is no regenerate mechanism
for job packets (unlike founder-outreach's `regenerateOne`) — `process()` dedupes by stable_id, so
re-running discovery against an already-processed URL just returns `'duplicate'`, it never
redrafts. This fix only corrects packets generated *after* it ships; the current 32 existing job
packets keep the "Candidate" placeholder unless something explicitly reprocesses them. Building a
job-packet regenerate path is out of scope for this block — flagged as a possible follow-up, not
assumed the user wants it built.

**Approved by user, expanded:** user wants existing job packets reprocessed too (was going to be
scoped separately, folded in here). But before building anything further, user wants an
independent quality gate run first — see the new block immediately below. **Read that block's
findings before writing a single line of the fact-selector prompt** — if personas surface a
grounding or tone weakness, the new prompt should be designed to avoid it from the start, not
patched after the fact like the char-limit/voice/em-dash issues were this session.

## New task block: multi-persona quality gate on live output (2026-08-05) — PROPOSED, NOT STARTED, RUN THIS FIRST

**Why this exists:** three real, user-facing defects shipped and sat live before being caught this
session — the 285-char wrong-limit mistake, the AI-sounding formulaic drafts, and the "Candidate"
placeholder that has been in *every single job packet since the feature was built*, unnoticed
until the user happened to read one on the newly-split dashboard tab. Self-assessment (my own
review, plus the existing code-level guards) missed all three. The pattern: **building the check
and running the check with the same mind that wrote the code doesn't surface what that mind is
blind to.** User's explicit ask: before building the next fix, get an honest, independent read on
whether current live output is actually good — using multiple domain-expert personas as genuinely
separate agents (not me role-playing inline), each blind to how the drafts were built, each asked
plainly "would you, personally, accept/send/act on this if you were responsible for it?" Any "no"
is ground truth pointing at a specific prompt or model weakness to fix directly — not a stylistic
nitpick to weigh against other priorities.

**Scope:** audit real, current live drafts already sitting in the review dashboard (not
hypothetical examples) — a sample of the 12 founder-outreach messages and a sample of ~6-8 job
packets from the 32 (the audit doesn't need all 32, but pick a spread: some with a matched open
role, some without, some with a resume bucket match, some without, to exercise different branches
of `packetDraft()`).

**Personas (concrete domain lens, not generic titles) — dispatch each as its own Agent call, run
in parallel, give each ONLY the raw draft(s) + its persona framing below, nothing about how this
project built them (keeps the read genuinely blind, not primed to be generous):**

1. **The recipient founder** — a busy, moderately senior startup founder who gets 10-20 LinkedIn
   "let's connect" messages a week and ignores nearly all of them. Given each founder-outreach
   draft cold (as if it just landed in their LinkedIn inbox): would they actually reply? Does it
   read as a real specific person, or a templated pitch with the name swapped in? Rate each
   PASS/FAIL plus the one line that would make them stop reading.
2. **A technical hiring manager** screening inbound applications for the specific role each job
   packet targets. Given the packet's "Draft note" + selected facts: does this read as a credible,
   targeted application worth an interview slot, or generic filler? Are the facts chosen the
   *strongest* relevant ones, or just present-but-weak? PASS/FAIL plus the weakest line.
3. **A cold-outreach/growth specialist** (the kind of person who reviews SDR sequences for a
   living) — judges structure and persuasiveness independent of authenticity: does the ask land,
   is there a clear single next step, is anything wasted/redundant.
4. **An AI-writing-tell auditor** — explicitly re-runs the same checklist the `humanizer` skill
   uses (inflated symbolism, promotional language, rule-of-three, vague attributions, filler
   phrases, AI vocabulary) against each draft, specifically hunting for what the existing
   mechanical guards (placeholder/generic-opener/em-dash patterns) are structurally incapable of
   catching, since those are exact-string/regex matches, not a holistic read.
5. **A grounding fact-checker** — for each claim in each draft (a company detail, a "verified
   fact," a matched role), checks it against the actual source data supplied to this project
   (resume `reference_text`, the scraped `companyContext`, the verified job posting) and flags
   anything not directly traceable — the same check that resolved the Cabocab/LatentGraph question
   earlier this session, run systematically instead of only when something looks suspicious.

**Steps:**
- [ ] Pull the real current sample (12 founder drafts via `GET /api/review/items`, ~6-8 job
      packets via `GET /api/pipeline/jobs` + their linked review items) before dispatching agents —
      personas review real live text, not paraphrased summaries.
- [ ] Dispatch all 5 persona agents in parallel (single message, multiple `Agent` tool calls per
      the parallel-dispatch rule), each scoped to its lens above, each given only the raw sample +
      its persona framing.
- [ ] Collect verdicts into one punch list: which specific drafts failed which persona, and why,
      in the persona's own words — not softened or summarized into vague themes.
- [ ] Triage the punch list: separate (a) prompt-fixable issues (add another explicit rule/example,
      same pattern as the banned-phrase/em-dash guards), (b) code-guard-fixable issues (a new
      mechanical check, if the failure mode is pattern-detectable), (c) architectural issues (the
      fact-selector or drafting approach itself needs to change, not just be tuned).
- [ ] Only then design/build the job-packet candidate-name + fact-selector fix (previous block) —
      informed by whatever this surfaces, not written blind to it.
- [ ] Reprocess the 32 existing job packets once the fix is confirmed good by the same persona
      standard (spot-check a few post-fix packets through personas 2 and 5 specifically before
      declaring this done — don't just trust the code ran without error).
- [ ] Log findings in `docs/decisions.md` regardless of outcome (even "personas found nothing
      wrong" is worth recording, so this isn't re-litigated from scratch next time).

**Explicit priority for next session (user is compacting after this):** run this block *before*
the job-packet candidate-name/fact-selector block above. This block's findings should shape how
that fix is built, not be run after the fact as a second check on a design already locked in.
