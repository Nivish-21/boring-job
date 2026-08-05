# Status

_Last updated: 2026-08-05_

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
A **founder-outreach feature** is built, unit-tested, and **live-verified against real data**:
imports a LinkedIn connections CSV (official export, no scraping), identifies founders, researches
their companies, checks for a real open role through the unmodified job pipeline, drafts a
personalized outreach message for human review (never auto-sends), and supports **regenerating a
single bad draft** without re-importing the whole batch. `OPENAI_API_KEY` is supplied and
founder-outreach drafting uses `gpt-5.6-terra` (mid-tier) with `reasoning_effort: 'high'` (verified
live against the real API, not assumed). Drafts are direct messages to existing 1st-degree
connections (no fixed length target, ~8,000-char safety backstop only — not the 300-char
connection-request-note limit, a mistake caught and fixed 2026-08-05) and match a real voice
sample the user provided, with code-level guards against placeholders, banned generic-opener
phrases, and em dashes. 121/121 tests passing; `docker compose config --quiet` validates clean.

## Active plan — founder-outreach: dashboard fixed, regenerate path built, char-limit fixed, voice matched — all live-verified (2026-08-05)

**12 founders processed so far** (not 9 — that count was stale in an earlier version of this doc;
corrected from the real `founders.json` timestamps: 4 batches of 3 across 2026-08-04) of 176
flagged from the user's 576-connection export. 164 remain, untouched — re-running
`POST /api/founders/import` against the same CSV picks up the next batch automatically
(already-processed founders are skipped).

**This session (2026-08-05), first pass:** user reported the dashboard showed zero founder cards.
Root cause: `worker/public/` is baked into the Docker image at build time, and the image hadn't
been rebuilt since the fix that renders `kind: 'founder'` review items landed on 2026-08-04.
Rebuilt and verified (served `app.js` byte-identical to source). Investigating further surfaced
three real problems, all fixed and live-verified: (1) 5 of the 12 processed founders were stuck
with unusable drafts (3 genuinely empty from the `temperature: 0.4` bug, 2 with leftover
placeholders predating the guard) with no way to fix them — built `regenerateOne(profileUrl)` +
`POST /api/founders/:profileUrl/regenerate` + wired the dashboard's existing (previously dead-end)
"Regenerate" button to it; (2) added a `GENERIC_OPENER_PATTERN` guard, live drafts kept
reproducing the prompt's own labelled bad-example phrasing; (3) verified live that `gpt-5.6-terra`
accepts `reasoning_effort` and wired in `'high'`.

**Second pass, same session:** user pointed out the drafts still weren't right — a 285-char cap
based on LinkedIn's connection-request-note limit, applied to messages that actually go to
existing 1st-degree connections (a regular DM, ~8,000-char limit). Fixed: `MAX_MESSAGE_CHARS` →
`8_000` as a safety backstop only, no fixed target (user's explicit direction), prompt rewritten
accordingly. User then flagged the regenerated drafts still read as AI-written despite passing
every guard — provided one real writing sample live in conversation, from which concrete style
markers were extracted (casual opener, "and"-chained sentences, no em dashes, a low-key ask) and
added to the prompt as a voice reference, plus a new code-level `EM_DASH_PATTERN` guard. All 12
drafts regenerated twice this session (once per fix); final state: all pass every guard with zero
flags, average length ~280-500 chars.

**Resolved, not just "not a code bug":** what had been carried since 2026-08-04 as an open
known-issue (Aravind Jayendran's draft naming his company "LatentGraph" vs. the listed
"LatentForce") turned out, on investigation via a live Firecrawl scrape of the real company site,
to not be an error at all — LatentForce is the company, LatentGraph is their actual flagship
product. Closed.

**Real `Connections.csv` lives at `worker/founder-outreach/import.zip/Connections.csv`**
(git-ignored — the folder holds the user's full LinkedIn data-archive export, real PII, never
committed).

**Explicit instruction for next session:** founder-outreach (including regenerate, the corrected
char limit, and the voice-matched prompt) is fully working end-to-end against real data — do not
re-derive the architecture. Open by checking whether the user wants the next batch of the
remaining 164 flagged founders imported.

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
- `reasoning_effort: 'high'` added to `draftOutreachMessage`'s OpenAI call, verified live against
  the real API (accepted values, real reasoning-token spend) before wiring in, not assumed from
  the model family name — same discipline that caught the earlier `temperature` bug.
- A second code-level guard (`GENERIC_OPENER_PATTERN`) added alongside the placeholder guard —
  live drafts kept reproducing the prompt's own labelled bad-example phrasing almost verbatim,
  reconfirming prompt-only instructions aren't reliable for this model/task.
- `FounderOutreachRunner.regenerateOne(profileUrl)` reuses the existing per-founder pipeline
  directly rather than persisting `companyContext`/`matchedJob` for a cheaper LLM-only retry —
  regenerate is human-triggered and low-volume, so the extra Firecrawl/OpenAI cost of a full
  re-run isn't worth a schema change. Discovered along the way: `ReviewStore.decide()` already had
  a `'regenerate'` action, but it only flips status back to `pending` and never touches draft
  content — a pre-existing dead end, not something this session broke. The dashboard's
  "Regenerate" button now calls the new endpoint for founder cards instead.
- `MAX_MESSAGE_CHARS` corrected from 285 to 8,000 — the 285 figure was based on LinkedIn's
  connection-request-note limit, the wrong product; every founder processed here is already a
  1st-degree connection, so the real limit is the ~8,000-char regular-DM cap (verified live
  against multiple independent sources). Used as a safety backstop only, not a style target, per
  the user's explicit direction: no fixed length, let the model decide per founder.
- Drafting voice matched to a real sample the user provided live in conversation (not invented) —
  added as an explicit prompt reference (structure/tone only, same framing as the resume
  `reference_text`), plus a code-level `EM_DASH_PATTERN` guard, since prompt-only style
  instructions weren't reliably followed (same lesson as the placeholder/generic-opener guards).

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
  conversation transcript on 2026-08-04 (see "Active plan" above) — **rotated 2026-08-05**, all
  three regenerated in their provider dashboards, `.env` updated, `worker` container recreated
  and confirmed healthy with 0 errors on boot.

## Next steps

1. Review the 12 pending founder-outreach drafts in the dashboard (approve/reject/regenerate —
   regenerate now actually redrafts, not just resets status; all 12 currently reflect the
   corrected char limit and voice-matched prompt). Re-run `POST /api/founders/import` with the
   same `Connections.csv` to process the next batch of the remaining 164 flagged founders whenever
   ready — raise `DAILY_LEAD_CAP` in `.env` first if a bigger batch is wanted.
2. Turn on `DISCOVERY_SCHEDULE_ENABLED` for real unattended daily job-discovery runs, whenever
   the user wants that (currently off; manual trigger via `POST /api/discovery/run` still works).
