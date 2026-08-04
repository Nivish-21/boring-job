# Status

_Last updated: 2026-08-04_

## Current state

The automated daily job discovery pipeline is built and has now run live for the first time
against real Firecrawl and Apify credentials (`FIRECRAWL_API_KEY`/`APIFY_API_TOKEN` supplied;
`OPENAI_API_KEY` still not supplied — resume classification degrades to `null` as designed,
everything else works). That first run surfaced two real bugs, both fixed and verified live:
Firecrawl's circuit breaker was misclassifying a per-URL rejection as account-wide quota
exhaustion (indefinite disable), and the pipeline was paying for Firecrawl/Apify verification
on URLs it had already fully processed, with no way to ever stop. 63/63 tests passing;
`docker compose config --quiet` validates clean.

## Active plan

`docs/plan.md` — "Automated daily job discovery pipeline" build is complete and live-verified.
Two things in flight:

1. `OPENAI_API_KEY` still needed from the user for automatic resume-bucket suggestions
   (everything else already works without it).
2. A credit/usage-tracking feature for Firecrawl and Apify was requested, to surface spend in
   the review dashboard instead of checking each provider's website daily — being scoped as a
   new plan block (see `docs/plan.md`), pending an approach decision on what each provider's
   API actually exposes.

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

## Known issues / open risks

- Apify actor choice (`apify~website-content-crawler`) is still unconfirmed as the best fit —
  only a few real runs seen so far.
- Free-tier/paid quotas (Firecrawl, Apify) are finite. The circuit breaker and the new
  pre-verification dedup both reduce spend, but there's still no in-product visibility into
  actual credit usage — that's the requested next feature.
- `/api/discovery/run` is gated by the same Basic Auth as every other worker route once
  `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are set — the n8n workflow's HTTP Request node
  needs that credential attached or the scheduled run will 401 (documented in
  `workflows/README.md`).
- A Docker Desktop BuildKit hiccup (`DeadlineExceeded` resolving the `node:22-alpine` base
  image, despite Docker Hub itself being reachable) blocked one rebuild; worked around with
  `docker build --pull=false` to force the local image cache. Not a code issue — flagging in
  case it recurs.

## Next steps

1. User supplies `OPENAI_API_KEY` (optional, but needed for resume-bucket auto-suggestion).
2. Scope and build the Firecrawl/Apify credit-usage tracking feature — pending research into
   what each provider's API actually exposes (in progress).
