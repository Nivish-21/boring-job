# Decisions

## 2026-08-04 — Firecrawl `/scrape` + OpenAI over Firecrawl `/extract` for discovered postings

**Context:** Non-ATS (discovered) job postings need liveness + JD text before evaluation.
Firecrawl offers a structured `/extract` endpoint that could do this in one call.

**Decision:** Use the cheap `/scrape` endpoint (~1 credit/page, markdown only) and do the
structuring/classification with OpenAI in `fit-evaluator.mjs`, instead of `/extract`.

**Alternatives considered:** Firecrawl `/extract` — more convenient (schema-driven, one call)
but costs more credits per page than `/scrape`, and the free-tier credit budget is the binding
constraint for a daily-run pipeline.

**Reasoning:** Cost. `evaluateJob()` (the deterministic fit-scoring logic in `job-pipeline.mjs`)
already exists and is free — it doesn't need OpenAI at all. Only the resume-bucket
classification step (`classifyResumeBucket`) needs an LLM, and that's a smaller, cheaper call
than a full structured extraction per posting.

---

## 2026-08-04 — Apify scoped to scrape-fallback only, actor choice unconfirmed

**Context:** Firecrawl's free tier can be exhausted or rate-limited mid-run. A second scraping
provider is needed as a fallback for discovered (non-ATS) postings.

**Decision:** Apify (`apify-client.mjs`) is wired in strictly as a scrape fallback —
`verifyDiscoveredUrl()` tries Firecrawl first, falls back to Apify only on Firecrawl
failure/circuit-breaker-disable. Apify is never used for search/discovery, and never a
first choice.

**Actor choice:** Defaults to `apify~website-content-crawler` (a real, generic, public Apify
actor). **This is not a choice the user has explicitly confirmed** — flagged here per
`docs/plan.md`. If the actual scraped output quality is poor once `APIFY_API_TOKEN` is
supplied and tested, revisit — the actor is configurable per-call (`apifyActorId` param) and
via the `APIFY_ACTOR_ID` env var, so swapping it doesn't require a code change.

**Reasoning:** Keeps a single, well-understood provider (Firecrawl) as the default cost/quality
path, with Apify purely as insurance against Firecrawl outages — avoids doubling the surface
area of "which provider found this data" for the common case.

---

## 2026-08-04 — Circuit breaker as a local JSON file store, not Postgres

**Context:** Both Firecrawl and Apify have finite free-tier quotas. A circuit breaker
(`provider-state-store.mjs`) is needed to stop retrying a provider that's confirmed
rate-limited/quota-exhausted, rather than burning further calls against it every run.

**Decision:** Implement it as an atomic-write local JSON file (`provider-state.json`),
following the exact same pattern already used by `pipeline-store.mjs` and `review-store.mjs`
(temp-file write + atomic rename, serialized write queue).

**Alternatives considered:** The `postgres` container already defined in `compose.yml` (running
for n8n's own state) — could have added a table there instead.

**Reasoning:** Consistency and simplicity. The worker already has an established, tested,
dependency-free pattern for small durable JSON state, and the Postgres container is owned by
n8n's schema — reusing it here would mean either sharing a database across two owners or adding
a new schema/migration path for a few key-value rows. Not worth the coupling for a small state
file that only the worker process reads/writes.

---

## 2026-08-04 — Firecrawl HTTP 403 reclassified from `quota_exhausted` to `unknown`

**Context:** First live discovery run tripped the circuit breaker on Firecrawl after a single
scrape of a site that returned "we do not support this site" (HTTP 403) — a per-URL business
rejection, not an account-level quota signal. `docs/decisions.md`'s circuit-breaker policy
disables `quota_exhausted` indefinitely with no auto-retry, so this one unrelated site
permanently killed Firecrawl for the rest of the pipeline's life, forcing every subsequent
discovered URL onto the paid Apify fallback for the remainder of that run (confirmed against
real Apify dashboard usage, not just logs).

**Decision:** `firecrawl-client.mjs`'s `classifyError` only maps HTTP 402 to `quota_exhausted`
now; 403 falls through to `unknown` (15-minute auto-recovering cooldown), same as any other
unexplained failure.

**Reasoning:** Only 402 (Payment Required) is an unambiguous account-level billing/quota
signal. 403 is used by Firecrawl for both quota and unrelated per-URL scrape rejections, and
conflating them let one bad site take down the whole provider for the rest of the day.

---

## 2026-08-04 — Dedupe by provider-derived stable ID before verification, not after

**Context:** `JobPipeline.process()` persisted `needs_review`/`skipped` outcomes but called
`verify()`/`verifyFallback()` (Firecrawl/Apify, real cost) before ever checking whether that
URL had already been processed. Worse, a `manual_review` (inconclusive verification) or
`expired` (closed) outcome was never persisted at all — meaning a permanently unscrapable URL
would be re-verified, at real cost, on every single future discovery run indefinitely. Both
were confirmed live: a discovery run's already-seen URLs were being re-scraped every day, and
Apify's dashboard showed real paid runs for URLs that had already been fully processed.

**Decision:** `process()` now computes the job's provider-derived stable ID from the URL alone
(`selectProvider()`, a pure/local function — no network call) as the very first step, and
returns `duplicate` immediately if a record already exists under that ID, before calling
`verify()` at all. Non-live outcomes (`manual_review`, `expired`) are now persisted too
(`status: 'unverified'` / `'expired'`), so they get the same before-verification short-circuit
on every future run.

**Reasoning:** `selectProvider()` parses Greenhouse/Lever/Ashby board tokens and job IDs
directly from the URL string, and constructs the exact same stable-ID format the live-verified
path already uses (`greenhouse:<board>:<id>`, `manual:<url>`, etc.) — so the pre-check and
post-verification stable IDs always agree, with no extra network cost to compute it. Verified
live: a second discovery run against the same default query showed 5 of 6 discovered URLs
short-circuit to `duplicate` with zero Firecrawl/Apify calls, and Apify wasn't invoked at all
that run.
