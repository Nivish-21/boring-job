# Status

_Last updated: 2026-08-04_

## Current state

The automated daily job discovery pipeline is built, live-tested, and is a **single Docker
service** — `worker` only. n8n and Postgres were removed (n8n's only role had become firing one
daily HTTP call; Postgres existed solely as n8n's database) and replaced with a small in-worker
scheduler (`DISCOVERY_SCHEDULE_ENABLED`, off by default). The review dashboard is dark-themed,
shows one unified filterable list (sidebar: status checkboxes, company search, fit-score range,
each card showing an explicit "Discovered" timestamp and colour-coded fit score) covering every
job ever seen, plus a Firecrawl/Apify usage strip. Discovery targets ATS-hosted boards directly
(Greenhouse/Lever/Ashby). Packet drafts include a capped excerpt of the matched resume's real
extracted text (kept outside git, in `~/Desktop/Nivish_Tailored_Resumes/reference/`).
A **founder-outreach feature** is now built and unit-tested on top of this: imports a LinkedIn
connections CSV (official export, no scraping), identifies founders, researches their companies,
checks for a real open role through the unmodified job pipeline, and drafts a personalized
outreach message for human review — never auto-sends. Not yet run against real data (see "Active
plan" below). `OPENAI_API_KEY` still not supplied — resume classification and founder-outreach
message drafting both degrade to `null`/no-draft as designed, everything else works. 109/109
tests passing; `docker compose config --quiet` validates clean.

## Active plan — founder-outreach feature: built and unit-tested, not yet run against real data

All 7 build steps in `docs/plan.md` are complete: `connections-catalog.mjs` (CSV parsing),
`founder-store.mjs`, `founder-outreach.mjs` (careers-URL discovery + OpenAI drafting, reusing the
unmodified `JobPipeline`), `server.mjs` wiring (`POST /api/founders/import`), the dashboard gap
close (`kind: 'founder'` review items now render with a Job/Founder badge and IST timestamps),
and a full test suite (24 new tests). **109/109 tests passing project-wide.** Implementation
deviations from the original design sketch are logged in `docs/decisions.md`
("Founder-outreach implementation deviations").

**What's actually left is a live run, not more building:**
1. User exports LinkedIn connections via Settings & Privacy → "Get a copy of your data" →
   Connections (a CSV — no scraping, no credentials shared, matches the ToS-safety decision
   already made for this feature).
2. `POST /api/founders/import` with that CSV as the raw body (`content-type: text/csv`) against
   a running worker.
3. Confirm in the dashboard: founders get identified, company research happens, any real open
   role gets found through the normal job pipeline, and a message gets drafted (or, if
   `OPENAI_API_KEY` still isn't supplied, confirm the review item still appears with `draft: null`
   and a clear reason — this is the designed degrade path, not a bug).

**Explicit instruction for next session: do not open by asking for the LinkedIn connections
CSV unprompted.** It's fine to ask now that the code is actually ready to run against it — this
instruction was about not asking before the code existed, which is no longer the case.

`DISCOVERY_SCHEDULE_ENABLED` is still off by default for the existing job-discovery pipeline —
turn on when the user wants real unattended daily runs. `OPENAI_API_KEY` is still not supplied
(optional — resume-bucket auto-suggestion and founder-outreach message drafting both need it).

## Major decisions

See `docs/decisions.md` for full reasoning. Summary:
- Firecrawl `/scrape` + OpenAI, not Firecrawl `/extract` — cost.
- Apify is a scrape-fallback only, never search/discovery; default actor
  (`apify~website-content-crawler`) is **unconfirmed by the user** — revisit once more real
  output is seen.
- Circuit breaker (`provider-state-store.mjs`) is a local atomic JSON file, matching the
  existing store pattern.
- Firecrawl HTTP 403 reclassified from `quota_exhausted` (indefinite disable) to `unknown`
  (15-min cooldown) — 403 covers per-URL rejections, not just account-level quota.
- `JobPipeline.process()` dedupes by a locally-computed provider stable ID *before* calling
  `verify()`, and persists every non-live outcome so a dead URL is never silently re-verified.
- Stack stays Node, not migrated to Python/FastAPI — user is learning Python but agreed a
  rewrite of an already-built, live-verified pipeline would be pure churn.
- Firecrawl/Apify usage tracking reads each provider's own account/billing endpoint directly.
- The dashboard shows every discovered job (not just accepted ones), with company-profile
  lookup on every live-verified job.
- Discovery query targets `site:boards.greenhouse.io OR site:jobs.lever.co OR
  site:jobs.ashbyhq.com` — finds individual postings instead of job-board hub pages.
- Known aggregator/job-board hostnames are rejected in `JobPipeline.process()` before
  `verify()` is ever called — zero credit cost.
- Dashboard merged into one filterable list (sidebar: status/company/fit-score), dark-themed,
  with an explicit "Discovered" timestamp and fit-score colour coding.
- Resume text extracted to `~/Desktop/Nivish_Tailored_Resumes/reference/` (outside git, real
  PII) and used as capped LLM reference context in packet drafts, instead of copying the actual
  resume files into `docs/` as first requested — flagged the git-history/PII risk, user approved
  the alternative.
- n8n + Postgres dropped entirely; replaced with a ~20-line in-worker scheduler
  (`worker/src/scheduler.mjs`), off by default. `workflows/` directory removed.
- Founder outreach from LinkedIn connections: **not** built via scraping the connections list
  (would require handing over real LinkedIn credentials, violates ToS, real account-ban risk).
  Instead: user exports connections via LinkedIn's own official data-export tool, worker parses
  that CSV locally. Reuses `company-lookup.mjs` for company research and the existing
  `JobPipeline.process()` unmodified to check for real open roles at each founder's company.
  Built and unit-tested 2026-08-04 — implementation deviations from the original design sketch
  (single combined LLM call, ATS-priority URL sort, always-create-review-item-on-draft-failure,
  title-derived company filter) are logged in `docs/decisions.md`.

## Minor decisions

- Resume bucket `id` = the zero-padded `#` column from the resume README, not the filename slug.
- Discovered (manual-provider) job records use `manual:<source_url>` as `stable_id`.
- Circuit-breaker cooldowns: `rate_limited` 5 min, `timeout`/`unknown` 15 min,
  `unauthorized`/`quota_exhausted` (402 only) indefinite.
- `DiscoveryRunner`'s search `limit` defaults to `dailyCap * 2` — headroom since not every
  discovered URL survives verification + evaluation.
- `compose.yml`'s resume bind mount source is `${RESUME_HOST_DIR:-/Users/nivish/Desktop/Nivish_Tailored_Resumes}`.
- Usage strip has no polling loop and no historical graph — fetched on page load/manual
  refresh only, current balance vs. plan limit, red at ≤20% remaining.
- `daily_cap_reached` jobs stay eligible for retry on a later run, but pay for re-verification
  each retry — accepted limitation.
- `PipelineStore`'s own `rejected` status (aggregator-domain rejection) is remapped to
  `aggregator_rejected` in the dashboard to avoid colliding with `ReviewStore`'s human-decision
  `rejected` status.
- `ReviewStore` already accepted `kind: 'founder'` from the very start of the project (before
  this session) — no schema change needed there for the founder-outreach feature.

## Known issues / open risks

- Apify actor choice (`apify~website-content-crawler`) is still unconfirmed as the best fit —
  only a few real runs seen so far.
- `/api/discovery/run`, `/api/usage`, and `/api/pipeline/jobs` (GET) are all gated by the same
  Basic Auth as every other worker route once `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are set.
- A Docker Desktop BuildKit hiccup (`DeadlineExceeded` resolving the `node:22-alpine` base
  image) has blocked rebuilds a few times; worked around with `docker build --pull=false`.
- `worker/public/` is baked into the Docker image at build time, not bind-mounted — any
  dashboard edit needs an image rebuild to take effect.
- Company-profile lookup running on every live-verified job roughly doubles Firecrawl search
  volume for that step — cheap per call, worth watching via the usage strip.
- Founder-outreach has never been run against real data — only unit-tested with injected fakes
  and a live dashboard smoke test against seeded local JSON. First real CSV import may surface
  behaviour the unit tests didn't anticipate (see "Active plan" above for the exact next steps).

## Next steps

1. **Run founder-outreach against real data** — user exports their LinkedIn connections CSV,
   imports it via `POST /api/founders/import`, confirm the dashboard shows what's expected. See
   "Active plan" above for the exact checklist.
2. Turn on `DISCOVERY_SCHEDULE_ENABLED` for real unattended daily job-discovery runs, whenever
   the user wants that (currently off; manual trigger via `POST /api/discovery/run` still works).
3. User supplies `OPENAI_API_KEY` when ready (optional — powers resume-bucket auto-suggestion
   and founder-outreach message drafting).
