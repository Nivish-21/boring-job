# Status

_Last updated: 2026-08-04_

## Current state

Building the automated daily job discovery pipeline (full spec in `docs/plan.md`). All
worker-side code is written and tested — 61/61 tests passing (`npm test` in `worker/`).
Live-smoke-tested `startWorker()`: boots clean with a missing resume dir, `/health` responds,
`/api/discovery/run` fails cleanly (not a crash) with no Firecrawl key configured.

Nothing has been deployed or run end-to-end against real job postings yet.

## Active plan

`docs/plan.md` — "Automated daily job discovery pipeline". Steps 1–10 (all `worker/src/*`
modules) are done. Remaining, in order:

1. `compose.yml` — resume bind-mount (read-only) + env passthrough for the new keys.
2. `workflows/scheduled-job-discovery.json` — n8n Cron -> `POST /api/discovery/run`.
3. Confirm `OPENAI_API_KEY` / `APIFY_API_TOKEN` in `.env` — **user said they'll supply these.**
   `FIRECRAWL_API_KEY` is already present from an earlier session.
4. End-to-end run against real discovered postings; confirm the review dashboard shows fit
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

## Next steps

Pick up at `docs/plan.md`'s "Resume point" section — `compose.yml`, then the n8n workflow
file, then credentials, then the end-to-end run.
