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
