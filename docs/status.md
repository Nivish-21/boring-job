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
A **founder-outreach feature** is now built, unit-tested, and **live-verified against real
data**: imports a LinkedIn connections CSV (official export, no scraping), identifies founders,
researches their companies, checks for a real open role through the unmodified job pipeline, and
drafts a personalized outreach message for human review — never auto-sends. First real batch (3
founders, capped) ran successfully against the user's actual 576-connection export; see "Active
plan" below for results and an outstanding key-rotation item. `OPENAI_API_KEY` is now supplied,
and founder-outreach drafting uses `gpt-5.6-terra` (mid-tier, not the cheapest) specifically for
message quality. 112/112 tests passing; `docker compose config --quiet` validates clean.

## Active plan — founder-outreach: LIVE-VERIFIED, then a quality-fix pass, also LIVE-VERIFIED (2026-08-04)

First real run (3 founders, capped): imported the user's actual LinkedIn `Connections.csv` (576
connections, 176 flagged as founders) via `POST /api/founders/import`. All 3 processed, all 3 got
a real OpenAI-drafted message, confirmed rendering correctly in the real dashboard. User then
flagged the messages as weak and asked for a hard 300-char-adjacent cap (LinkedIn's connection-
note limit). Fixed and **re-verified live against 6 more real founders** (9 total processed of
176 flagged; 167 remain, untouched — re-running the import picks up the next batch automatically,
already-processed founders are skipped): switched the drafting model to `gpt-5.6-terra`, added a
hard 285-char code-level truncation backstop, added a code-level guard that nulls out any message
still containing a bracketed placeholder, rewrote the prompt with explicit banned phrases and a
paired good/bad example. Full reasoning and both live-verification passes in `docs/decisions.md`.

**Real-data observations from the live checks, not code bugs:**
- Some founders' companies have no discoverable website/LinkedIn/open role (small/early startups
  with thin web presence) — those get a shorter, generic value-add message. Expected.
- One drafted message named a founder's company differently than the name on record (likely an
  ambiguous company-website search match) — flagged to the user for manual review, not silently
  "fixed," since it's a grounding/correctness issue the human-review step exists to catch.
- The model-switch live check also caught a real bug the unit tests couldn't have: `gpt-5.6-terra`
  rejects any non-default `temperature`, so the first post-switch live batch silently drafted
  nothing (degraded gracefully, but zero real output) until the hardcoded `temperature: 0.4`
  (left over from the `gpt-4o-mini` era) was removed.

**Security incident during this run (logged in full in `~/.claude/lessons.md` and
`docs/lessons.md`):** a `grep` on `.env` intended to just confirm which vars were set instead
printed real secret values into the conversation — `OPENAI_API_KEY`, `APIFY_API_TOKEN`,
`FIRECRAWL_API_KEY` (live), plus `N8N_ENCRYPTION_KEY`/`POSTGRES_PASSWORD` (decommissioned
services). User chose to proceed with the test import rather than rotate first. **Still
outstanding: rotate `FIRECRAWL_API_KEY`, `APIFY_API_TOKEN`, and `OPENAI_API_KEY`** — regenerate
in each provider's dashboard, update `.env`, no code changes needed.

**Real `Connections.csv` lives at `worker/founder-outreach/import.zip/Connections.csv`**
(git-ignored — the folder holds the user's full LinkedIn data-archive export, real PII, never
committed). 9 of 176 flagged founders processed so far; re-running `POST /api/founders/import`
against that same file picks up the next batch of the remaining 167 automatically
(already-processed ones are skipped).

`DISCOVERY_SCHEDULE_ENABLED` is still off by default for the existing job-discovery pipeline —
turn on when the user wants real unattended daily runs.

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
- Founder-outreach drafting uses `gpt-5.6-terra` (mid-tier), not the cheaper model used
  elsewhere in the project — a creative-writing task benefits from it, classification-style
  calls (`fit-evaluator.mjs`) don't and are unaffected. Hard 285-char cap and a bracketed-
  placeholder guard are both enforced in code, not just requested in the prompt — live
  verification showed prompt-only instructions aren't reliably followed.

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
- `FIRECRAWL_API_KEY`, `APIFY_API_TOKEN`, and `OPENAI_API_KEY` were printed in full into a
  conversation transcript on 2026-08-04 (see "Active plan" above) — **not yet rotated**.

## Next steps

1. **Rotate `FIRECRAWL_API_KEY`, `APIFY_API_TOKEN`, and `OPENAI_API_KEY`** — exposed in a
   conversation transcript on 2026-08-04, user chose to defer rotation to finish the test import
   first. Regenerate in each provider's dashboard, update `.env`.
2. Review the 9 drafted founder-outreach messages in the dashboard (approve/reject/regenerate).
   **Double-check Aravind Jayendran's draft specifically** — it names his company "LatentGraph"
   instead of the listed "LatentForce" (likely an ambiguous company-website search match), not
   yet corrected. Re-run `POST /api/founders/import` with the same `Connections.csv` to process
   the next batch of the remaining 167 flagged founders whenever ready — raise `DAILY_LEAD_CAP`
   in `.env` first if a bigger batch is wanted.
3. Turn on `DISCOVERY_SCHEDULE_ENABLED` for real unattended daily job-discovery runs, whenever
   the user wants that (currently off; manual trigger via `POST /api/discovery/run` still works).
