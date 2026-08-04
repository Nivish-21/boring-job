# Status

_Last updated: 2026-08-04_

## Current state

The automated daily job discovery pipeline (full spec in `docs/plan.md`) is fully built:
all worker-side code, `compose.yml` (resume bind-mount + env passthrough), and the n8n
scheduled workflow. 61/61 tests passing (`npm test` in `worker/`); `docker compose config
--quiet` validates clean. Current state committed and pushed to `origin/main` (`3031cba`),
verified via `git ls-remote` matching local `git rev-parse main`.

Nothing has been deployed or run end-to-end against real job postings yet — that's the only
remaining step, and it's blocked on credentials (see below).

## Active plan

`docs/plan.md` — "Automated daily job discovery pipeline". All build steps are done. Only
remaining:

1. User supplies `OPENAI_API_KEY` and `APIFY_API_TOKEN`. No local `.env` file exists yet at
   all — needs to be created from `.env.example`. `FIRECRAWL_API_KEY` also needed; the key
   used for the earlier live-verification session was redacted from `docs/plan.md` and should
   be rotated, not reused.
2. End-to-end run against real discovered postings; confirm the review dashboard shows fit
   score, resume attachment (or no-match), and company metadata correctly.

## Major decisions

See `docs/decisions.md` for full reasoning. Summary:
- Firecrawl `/scrape` + OpenAI, not Firecrawl `/extract` — cost.
- Apify is a scrape-fallback only, never search/discovery; default actor
  (`apify~website-content-crawler`) is **unconfirmed by the user** — revisit once real output
  is tested.
- Circuit breaker (`provider-state-store.mjs`) is a local atomic JSON file, matching the
  existing store pattern, not a new Postgres table.

## Minor decisions

- Resume bucket `id` = the zero-padded `#` column from the resume README (e.g. `"01"`), not
  the filename slug — shorter, stable, unambiguous for LLM classification.
- Discovered (manual-provider) job records use `manual:<source_url>` as `stable_id`.
- Circuit-breaker cooldowns: `rate_limited` 5 min, `timeout`/`unknown` 15 min,
  `unauthorized`/`quota_exhausted` indefinite (no auto-retry on a confirmed quota exhaustion).
- `DiscoveryRunner`'s search `limit` defaults to `dailyCap * 2` — headroom since not every
  discovered URL survives verification + evaluation.
- `compose.yml`'s resume bind mount source is `${RESUME_HOST_DIR:-/Users/nivish/Desktop/Nivish_Tailored_Resumes}`
  — overridable via `.env`, defaults to the path already in use.
- Found and redacted a real Firecrawl session key that had been left in plaintext in
  `docs/plan.md` from an earlier session, before pushing — flagged to the user to rotate it.

## Known issues / open risks

- Apify actor choice is unconfirmed (see decisions.md) — no real Apify output has been seen
  yet since `APIFY_API_TOKEN` isn't in `.env`.
- No end-to-end run against live discovered postings yet — only unit-level tests with mocked
  `fetchImpl`. Firecrawl/OpenAI/Apify request shapes were verified against real APIs where
  possible (see `docs/plan.md` step 1 for the verified Firecrawl API shapes), but the full
  discovery → evaluate → classify → review pipeline hasn't run against live data.
- Free-tier quotas (Firecrawl, Apify) are finite; the circuit breaker exists but its real-world
  behavior under actual quota exhaustion is untested (only unit-tested with injected fetch
  mocks).
- `/api/discovery/run` is gated by the same Basic Auth as every other worker route once
  `REVIEW_AUTH_USER`/`REVIEW_AUTH_PASSWORD` are set — the n8n workflow's HTTP Request node
  needs that credential attached or the scheduled run will 401 (documented in
  `workflows/README.md`).

## Next steps

Waiting on the user to supply `OPENAI_API_KEY`, `APIFY_API_TOKEN`, and a fresh
`FIRECRAWL_API_KEY` in a local `.env` (copy from `.env.example`). Once supplied: `docker
compose up -d --build`, then either trigger `POST /api/discovery/run` directly or activate
`workflows/scheduled-job-discovery.json` in n8n, and verify the review dashboard output.
