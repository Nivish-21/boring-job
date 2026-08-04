# Status

_Last updated: 2026-08-04_

## Current state

The automated daily job discovery pipeline is built, live-tested, and the review dashboard now
shows: the pending-approval queue, a Firecrawl/Apify usage strip, and a full "All discovered
jobs" listing (every status, with company profiles). `OPENAI_API_KEY` still not supplied —
resume classification degrades to `null` as designed, everything else works. Three real cost
bugs and one CSS bug found this session were fixed and verified live (see `docs/decisions.md`).
76/76 tests passing; `docker compose config --quiet` validates clean.

## Active plan

`docs/plan.md` — build is complete and live-verified end to end, including the usage strip and
job-listings view. Next up (user's own words): "then we are wiring up the n8n workflow" — i.e.
actually importing/activating `workflows/scheduled-job-discovery.json` in n8n for real
unattended daily runs. Not started yet. Only other remaining item: `OPENAI_API_KEY` from the
user for automatic resume-bucket suggestions (everything else already works without it).

## Major decisions

See `docs/decisions.md` for full reasoning. Summary:
- Firecrawl `/scrape` + OpenAI, not Firecrawl `/extract` — cost.
- Apify is a scrape-fallback only, never search/discovery; default actor
  (`apify~website-content-crawler`) is **unconfirmed by the user** — revisit once more real
  output is seen.
- Circuit breaker (`provider-state-store.mjs`) is a local atomic JSON file, matching the
  existing store pattern, not a new Postgres table.
- Firecrawl HTTP 403 reclassified from `quota_exhausted` (indefinite disable) to `unknown`
  (15-min cooldown) — 403 covers per-URL rejections, not just account-level quota.
- `JobPipeline.process()` dedupes by a locally-computed provider stable ID *before* calling
  `verify()`, and persists non-live (`manual_review`/`expired`/`daily_cap_reached`) outcomes so
  a dead URL is never silently re-verified or silently dropped again.
- Stack stays Node, not migrated to Python/FastAPI — user is learning Python but agreed a
  rewrite of an already-built, live-verified pipeline would be pure churn.
- Firecrawl/Apify usage tracking reads each provider's own account/billing endpoint directly
  (no local usage counter) — `GET /v2/team/credit-usage` and `GET /v2/users/me/limits`.
- The dashboard shows every discovered job (not just accepted ones), and company-profile
  lookup now runs for every live-verified job — user's explicit ask: "if you are not showing
  it to me then what's the purpose of scraping it?"

## Minor decisions

- Resume bucket `id` = the zero-padded `#` column from the resume README (e.g. `"01"`), not
  the filename slug — shorter, stable, unambiguous for LLM classification.
- Discovered (manual-provider) job records use `manual:<source_url>` as `stable_id`.
- Circuit-breaker cooldowns: `rate_limited` 5 min, `timeout`/`unknown` 15 min,
  `unauthorized`/`quota_exhausted` (402 only, now) indefinite.
- `DiscoveryRunner`'s search `limit` defaults to `dailyCap * 2` — headroom since not every
  discovered URL survives verification + evaluation.
- `compose.yml`'s resume bind mount source is `${RESUME_HOST_DIR:-/Users/nivish/Desktop/Nivish_Tailored_Resumes}`
  — overridable via `.env`, defaults to the path already in use.
- First live test run used `DAILY_LEAD_CAP=3` deliberately, to limit spend before the pipeline
  had ever been proven against real APIs.
- Usage strip has no polling loop and no historical graph — fetched on page load/manual
  refresh only, current balance vs. plan limit, red at ≤20% remaining. A deliberately small v1.
- `daily_cap_reached` jobs stay eligible for retry on a later run (not permanently dropped),
  but that means they still pay for re-verification each retry — accepted limitation, not
  solved this session (would need caching the verified job body across runs).

## Known issues / open risks

- Apify actor choice (`apify~website-content-crawler`) is still unconfirmed as the best fit —
  only a few real runs seen so far.
- `/api/discovery/run`, `/api/usage`, and `/api/pipeline/jobs` (GET) are all gated by the same
  Basic Auth as every other worker route once `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are
  set — the n8n workflow's HTTP Request node needs that credential attached or the scheduled
  run will 401 (documented in `workflows/README.md`).
- A Docker Desktop BuildKit hiccup (`DeadlineExceeded` resolving the `node:22-alpine` base
  image, despite Docker Hub itself being reachable) blocked rebuilds a few times this session;
  worked around with `docker build --pull=false` to force the local image cache. Not a code
  issue — flagging in case it recurs.
- `worker/public/` is baked into the Docker image at build time (`COPY public ./public`), not
  bind-mounted — any future dashboard edit needs an image rebuild to take effect, not just a
  page refresh. Bit us twice this session.
- Company-profile lookup now running on every live-verified job (not just accepted ones)
  roughly doubles Firecrawl search volume for that step — cheap per call, but worth watching
  via the usage strip now that it's built.

## Next steps

1. Wire up `workflows/scheduled-job-discovery.json` in n8n for real unattended daily runs
   (explicitly the user's stated next step).
2. User supplies `OPENAI_API_KEY` when ready (optional, resume-bucket auto-suggestion only).
