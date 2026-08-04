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

---

## 2026-08-04 — Node/TypeScript stack confirmed, not migrated to Python/FastAPI

**Context:** User raised whether this project should have been Python/FastAPI instead of Node —
they're actively learning Python and job-hunting for Python/FastAPI roles, so there's a real
personal-development angle, not just idle curiosity.

**Decision:** Keep Node. No migration.

**Reasoning:** `PLAN.md`'s original scaffold specified a Node/TypeScript worker before this
build started; there was no technical requirement favoring either stack for this workload (I/O-
bound HTTP calls + JSON file storage + a lightweight server). The pipeline is now fully built,
71/71 tests passing, and live-verified against real Firecrawl/Apify traffic — a rewrite would
be pure churn (redo the HTTP server, the atomic-JSON stores, every provider client, every test)
for zero functional gain. User agreed and will pursue Python learning through a separate,
unrelated project instead.

---

## 2026-08-04 — Firecrawl/Apify usage tracking added to the review dashboard

**Context:** User wants to see Firecrawl and Apify credit/spend in the review dashboard instead
of checking each provider's website daily — motivated directly by the cost issues found in the
first live run (see the two entries above).

**Decision:** New `worker/src/usage-tracker.mjs` module (`getFirecrawlUsage`, `getApifyUsage`),
a new auth-gated `GET /api/usage` route, and a small read-only usage strip in the dashboard
header, fetched on page load and on manual refresh — no polling loop, no historical graphs, no
alerting/thresholds beyond a simple in-page color change at ≤20% remaining.

**Verified endpoints (against real accounts, not documentation alone):**
- Firecrawl: `GET https://api.firecrawl.dev/v2/team/credit-usage` (Bearer auth) →
  `{remainingCredits, planCredits, billingPeriodStart, billingPeriodEnd}`.
- Apify: `GET https://api.apify.com/v2/users/me/limits?token=<token>` →
  `current.monthlyUsageUsd` vs `limits.maxMonthlyUsageUsd`, plus `monthlyUsageCycle`.

**Reasoning:** Both are lightweight account/billing metadata endpoints, structurally distinct
from paid scrape/search operations — reading current balance this way needs no local usage
counter or extra bookkeeping, and reflects the provider's own authoritative number rather than
an estimate the pipeline could get out of sync with.

---

## 2026-08-04 — Full job-listings view, company profile on every listing, and daily_cap_reached persistence

**Context:** User wants to see every job the pipeline scrapes, every day — not just the ones
that pass the eligibility gate and reach human review. Direct quote: "if you are not showing it
to me then what's the purpose of scraping it?" They also asked for the company profile
(website + LinkedIn) on those listings, not just the accepted ones.

**Decision:**
- New `PipelineStore.list({status})` and `GET /api/pipeline/jobs` — surfaces every job record
  (`needs_review`, `skipped`, `expired`, `unverified`, `daily_cap_reached`), most-recent-first,
  optionally filtered by status.
- `companyLookup` now runs for every live-verified job, not only ones that reach
  `needs_review` — moved earlier in `JobPipeline.process()`, right after `evaluateJob()`, so
  `skipped` and `daily_cap_reached` records get `title`/`location`/`company`/`company_links`
  too. **Cost tradeoff, stated plainly:** this roughly doubles how often the company-lookup
  Firecrawl searches fire, since skipped jobs are typically the majority of what's discovered.
  Still cheap per call relative to the account's credit budget (see the usage-tracking entry
  above), but flagging it since credit usage is something actively being watched this session.
- `daily_cap_reached` is now persisted (previously vanished with zero trace — the exact same
  unpersisted-record bug already fixed twice today for `manual_review`/`expired`), but is
  explicitly excluded from the pre-verification duplicate short-circuit, so a job capped today
  stays eligible to actually reach `needs_review` on a later run instead of being silently lost.
  This does mean a capped job still pays for re-verification on each retry — a known, accepted
  limitation, not solved today (would need caching the verified job body across runs, out of
  scope for this pass).
- Fixed a real, pre-existing CSS bug found while building this: `.button { display:
  inline-flex; }` was overriding the browser's default `[hidden] { display: none }` for every
  `.button[hidden]` element (author styles always beat the UA stylesheet regardless of selector
  specificity) — meaning the existing `.artifact-link[hidden]` was already silently broken
  before this session, not just the two new company-link buttons. Fixed with a `.button[hidden]
  { display: none; }` override.

**Reasoning:** Skipped/expired/unverified jobs are the majority of what a daily discovery run
actually finds — hiding them from the dashboard means the user only sees the ~5% that pass
every gate, with no way to audit or sanity-check the other 95%, or notice when a company or
posting keeps coming up. Company profile only makes sense on jobs that were actually
live-verified (unverified/expired jobs have no job data to look up in the first place).

---

## 2026-08-04 — Discovery query re-targeted to ATS-hosted boards; aggregator URLs rejected before verification

**Context:** Auditing the job-listings view (previous entry) surfaced the real reason so much
discovery was "wasted": every single URL found by the original generic query
(`remote backend software engineer job posting India eligible`) was a job-board **category or
search-results page** — `linkedin.com/jobs/software-engineer-jobs`,
`weworkremotely.com/categories/remote-back-end-programming-jobs`,
`wellfound.com/role/l/backend-engineer/india` — never an individual posting. Evaluating a hub
page as if it were one job's description was never going to produce a real match; this wasn't
an eligibility-tuning problem, it was scraping the wrong kind of page entirely. User's own
framing: "if many are wasted then it's completely useless."

**Decision:**
- `DEFAULT_DISCOVERY_QUERY` changed to `remote backend software engineer india
  (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)`. Verified live
  against the real Firecrawl `/v2/search` API before committing to this: a combined
  three-platform query returned 10/10 valid ATS-hosted job-posting URLs for the same 2 credits
  as the old single-provider test call — i.e. no extra search cost for dramatically better
  targeting. `DISCOVERY_QUERY` in `.env` still overrides this if the user wants to broaden it.
- New `JobPipeline.process()` guard: any discovered URL on a known aggregator/job-board
  hostname (LinkedIn, WeWorkRemotely, Wellfound, Indeed, Glassdoor, ZipRecruiter, Naukri,
  Monster, SimplyHired, BuiltIn, Crossover, RemoteRocketship) is rejected immediately —
  persisted with `status: 'rejected'` — before `verify()` is ever called, so it costs zero
  Firecrawl/Apify credits. Deliberately excludes `greenhouse.io`/`lever.co`/`ashbyhq.com`
  themselves, since those are exactly the individual postings this pipeline wants.

**Verified live (post-fix discovery run):** 6/6 discovered URLs were genuine ATS-hosted
postings with real titles ("Staff Software Engineer, Backend", "Senior Backend Software
Engineer", etc.) and real, meaningful skip reasons (senior-level requirements) — not aggregator
false positives. Apify usage was unchanged (`$0.176` before and after — zero scrapes needed,
every job verified for free via the ATS's own public API), and Firecrawl credit spend for the
run matched exactly what was expected from the search + per-job company lookups, not scraping.

**Reasoning:** ATS-hosted postings (Greenhouse/Lever/Ashby) are the one class of discovered URL
that is simultaneously (a) guaranteed to be a single real job posting, and (b) free to verify,
since this pipeline already has a public-API-based verifier for all three. Biasing discovery
toward them fixes quality and cost at the same time, rather than trading one for the other.

## 2026-08-04 — Dashboard: one merged list instead of two, `rejected` remapped to avoid a status collision

**Context:** The queue (pending review) and "All discovered jobs" sections were fully separate
in both markup and fetch logic, duplicating the card layout and giving the user two lists to
scan instead of one filterable view.

**Decision:** Merge client-side in `app.js`: fetch both `/api/pipeline/jobs` (all statuses) and
`/api/review/items` (all statuses) on every load, and for each pipeline job with a
`review_item_id`, treat the matching review item as the source of truth for status/draft/
evidence/actions (since `decide()` never writes back to the pipeline record). All other
pipeline jobs render read-only. `PipelineStore`'s own `'rejected'` status (aggregator-domain
rejection, pre-verification) is remapped to a distinct `aggregator_rejected` display status so
it can't collide with `ReviewStore`'s human-decision `'rejected'` status once both feed the same
sidebar checkbox list.

**Reasoning:** A single merged, filterable list matches the user's explicit ask ("usable, easily
manageable, easily understandable") and avoids two divergent copies of the same card-rendering
logic. Client-side merge (not a new backend endpoint) was chosen because both existing endpoints
already return everything needed — no new server-side work or schema change required.

## 2026-08-04 — Resume reference text extracted outside the git repo, not into `docs/`

**Context:** User asked for the LLM to use the actual 8 resumes (structure, tone, real
experience) as reference material when generating packet drafts, and specifically asked to copy
the resume files into `docs/`.

**Decision:** Extracted each resume's text via `firecrawl parse` into a new `reference/`
subfolder inside the existing `~/Desktop/Nivish_Tailored_Resumes/` directory — outside the git
repo entirely — instead of copying the files (or their text) into `docs/`. The worker already
bind-mounts that whole directory read-only (`RESUME_HOST_DIR`), so no `compose.yml` change was
needed; `resume-catalog.mjs` just reads one more file per bucket.

**Reasoning:** The resumes carry real PII — full name, phone, email, complete work history.
`docs/` is committed and pushed to GitHub every session; putting that data there would put it in
git history permanently (only removable by rewriting history) on a repo actively being pushed.
Flagged this to the user before building anything; they approved the `reference/` approach as
proposed. Functionally identical outcome (the LLM gets real resume text as context) with zero
PII ever touching git.
