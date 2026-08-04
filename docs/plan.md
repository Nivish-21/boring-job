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
- [ ] Tests for every new module (node:test + node:assert/strict, injectable
      `fetchImpl`, `mkdtemp` for store isolation — exactly like the existing
      `job-verifier.test.mjs`/`job-pipeline.test.mjs` pattern). Run `npm
      test` in `worker/` after each module and after final integration.
- [ ] `compose.yml`: add read-only bind mount
      `~/Desktop/Nivish_Tailored_Resumes:/app/resumes:ro` on the `worker`
      service, plus env passthrough for `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
      `APIFY_API_TOKEN`, `RESUME_DIR`, `DISCOVERY_QUERY`, `DAILY_LEAD_CAP`,
      `APIFY_ACTOR_ID` (all `${VAR:-}` optional passthrough from `.env`).
- [ ] n8n workflow: new `workflows/scheduled-job-discovery.json` — Cron
      trigger (daily) -> HTTP POST `http://worker:8080/api/discovery/run` ->
      done. Orchestration logic lives in the worker (testable code), n8n
      stays a thin scheduler per the user's own stated preference and
      `PLAN.md`'s architecture ("n8n: schedules... Worker: adapters...").
- [ ] Credentials: confirm `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
      `APIFY_API_TOKEN` are in `.env` (FIRECRAWL_API_KEY was used for the
      live API verification above — key value redacted, rotate before
      reuse). OpenAI/Apify keys still needed from the user.
- [ ] docs/decisions.md: log (1) Firecrawl `/scrape`+OpenAI over `/extract`
      for cost, (2) Apify scoped to scrape-fallback only, actor choice
      `apify~website-content-crawler` unconfirmed by user, (3) circuit
      breaker as local JSON file store (matches existing pattern) rather
      than the unused Postgres container.
- [ ] docs/changelog.md + docs/status.md: update once the build is complete
      and tests pass.
- [ ] Run end-to-end against a handful of real discovered postings, confirm
      review dashboard shows fit score, resume attachment (or no-match), and
      company metadata correctly.

## Resume point (context was at 81%+ when this was last updated)

All worker code is now built and tested: `firecrawl-client.mjs`,
`apify-client.mjs`, `provider-state-store.mjs`, `resume-catalog.mjs`,
`company-lookup.mjs`, `fit-evaluator.mjs`, `job-discovery.mjs`,
`pipeline-store.mjs` (countCreatedSince), `job-pipeline.mjs` (extended,
backward-compatible), `server.mjs` (wired + smoke-tested). 61/61 tests
passing (`npm test` in `worker/`).

Remaining steps, in order:
1. `compose.yml` — add the read-only resume bind mount and env passthrough
   for `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `APIFY_API_TOKEN`,
   `RESUME_DIR`, `DISCOVERY_QUERY`, `DAILY_LEAD_CAP`, `APIFY_ACTOR_ID`.
2. `workflows/scheduled-job-discovery.json` — n8n Cron -> HTTP POST
   `http://worker:8080/api/discovery/run`.
3. Confirm `OPENAI_API_KEY`/`APIFY_API_TOKEN` are in `.env` — user said
   ("i will provide the keys") they'll supply these; `FIRECRAWL_API_KEY`
   already present from an earlier session.
4. `docs/decisions.md` — log the 3 decisions listed below (this file didn't
   exist before this block; create it).
5. `docs/changelog.md` + `docs/status.md` — create and update once the
   build is complete and tests pass (neither file existed before this
   block either).
6. End-to-end run against real discovered postings, confirm the review
   dashboard shows fit score, resume attachment (or no-match), and company
   metadata correctly.

No further design decisions needed for steps 1-2 — everything downstream is
already fully specified above. Read this file at the start of the next turn
instead of re-deriving the architecture.

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

## Out of scope (this block)

- Founder/personal contact discovery, LinkedIn profile scraping, or outreach
  drafting — separate workflow, built later, human-provided input only.
- Auto-apply or auto-send of any kind.
- Generating a brand-new (9th) resume variant for no-match jobs — flag for
  manual review instead.
