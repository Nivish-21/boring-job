# Status

_Last updated: 2026-08-04_

## Current state

The automated daily job discovery pipeline is built, live-tested against real Firecrawl/Apify
credentials, and now includes a usage-tracking strip in the review dashboard. `OPENAI_API_KEY`
still not supplied — resume classification degrades to `null` as designed, everything else
works. Two real cost bugs found in the first live run were fixed and verified live (see
`docs/decisions.md`). 71/71 tests passing; `docker compose config --quiet` validates clean.

## Active plan

`docs/plan.md` — build is complete and live-verified end to end, including the new usage
strip. Only remaining: `OPENAI_API_KEY` from the user for automatic resume-bucket suggestions
(everything else already works without it).

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
- `JobPipeline.process()` now dedupes by a locally-computed provider stable ID *before* calling
  `verify()`, and persists non-live (`manual_review`/`expired`) outcomes so a dead URL is never
  re-verified at cost again.
- Stack stays Node, not migrated to Python/FastAPI — user is learning Python but agreed a
  rewrite of an already-built, live-verified pipeline would be pure churn.
- Firecrawl/Apify usage tracking reads each provider's own account/billing endpoint directly
  (no local usage counter) — `GET /v2/team/credit-usage` and `GET /v2/users/me/limits`.

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

## Known issues / open risks

- Apify actor choice (`apify~website-content-crawler`) is still unconfirmed as the best fit —
  only a few real runs seen so far.
- `/api/discovery/run` (and now `/api/usage`) are gated by the same Basic Auth as every other
  worker route once `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are set — the n8n workflow's HTTP
  Request node needs that credential attached or the scheduled run will 401 (documented in
  `workflows/README.md`).
- A Docker Desktop BuildKit hiccup (`DeadlineExceeded` resolving the `node:22-alpine` base
  image, despite Docker Hub itself being reachable) blocked rebuilds a few times this session;
  worked around with `docker build --pull=false` to force the local image cache. Not a code
  issue — flagging in case it recurs.
- `worker/public/` is baked into the Docker image at build time (`COPY public ./public`), not
  bind-mounted — any future dashboard edit needs an image rebuild to take effect, not just a
  page refresh. Bit us once this session.

## Next steps

User supplies `OPENAI_API_KEY` when ready. No other blockers — the pipeline, dashboard, and
usage tracking are all live and working.
