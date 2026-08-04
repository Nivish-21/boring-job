# Boring Job

This is a separate Docker scaffold for the Career-Ops automation layer. It does not modify or execute the existing `career-ops-main` project.

## Current components

- `worker` — the whole thing: public-ATS verification, job discovery, fit evaluation,
  resume matching, review-queue APIs, the review dashboard, and its own daily
  discovery scheduler (see below). One service, no orchestrator.
- `data/artifacts` — local output volume for reports and generated documents.
- `contracts/approval.json` — channel-neutral approval payload shape.
- `review/` — documentation for the local review dashboard/API served by the worker.

## Run locally

On macOS, start Docker Desktop from Applications, or from Terminal:

```sh
open -a Docker
```

Wait until Docker Desktop says its engine is running. Confirm it from this
repository:

```sh
docker version
```

Create the local configuration file:

```sh
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Open the review dashboard at `http://localhost:8080`. It binds to `localhost`
only, so it is not reachable from another machine.

If the service fails to start, inspect it with:

```sh
docker compose logs --follow worker
```

To stop the stack without deleting its data:

```sh
docker compose down
```

To start it again later, use `docker compose up -d`. Do not use `down --volumes`
unless you intend to erase the local review-queue/pipeline data.

### First smoke test

After `docker compose ps` shows `worker` running, verify it:

```sh
curl http://localhost:8080/health
```

Then run the pipeline with a real, public job URL from Greenhouse, Lever, or
Ashby. Replace the URL and candidate facts below; do not use the example URL as
it is deliberately not a live posting.

```sh
curl -X POST http://localhost:8080/api/pipeline/jobs \
  -H 'content-type: application/json' \
  -d '{"source_url":"PASTE_A_REAL_PUBLIC_ATS_JOB_URL","candidate":{"name":"Nivish","verified_facts":["Built and operated Node.js production systems.","Works with Docker and PostgreSQL."]}}'
```

For a recommendation of `apply` or `maybe`, open the review dashboard and check
that one pending item appears. An `approve` decision only records the review; it
does not submit an application.

## How Compose fits together

The `compose.yml` file runs one service: `worker`, which serves the review
dashboard, the review API, and the job-discovery pipeline. It also mounts
local folders (`data/artifacts`, `data/review`, your resume folder) so data
survives restarts.

There used to be an n8n + Postgres pair here whose only job was firing one
daily HTTP call. n8n added no logic of its own — all discovery, verification,
fit-scoring, and resume-matching already live in the worker as tested code —
so it was dropped in favor of a small scheduler built into the worker itself
(see below). Postgres existed only as n8n's database and went with it.

## Running discovery

Trigger a discovery run manually any time:

```sh
curl -X POST http://localhost:8080/api/discovery/run
```

Results land in the review dashboard at `http://localhost:8080`, same as
everything else. Nothing auto-applies or auto-sends.

For unattended daily runs, set in `.env`:

```sh
DISCOVERY_SCHEDULE_ENABLED=true
DISCOVERY_HOUR_UTC=7   # optional, defaults to 7
```

then `docker compose up -d --build`. This is off by default — turning it on
means real Firecrawl (and possibly Apify) credits get spent every day
unattended, so leave it off until you've reviewed a few manual runs' worth of
output and cost via the usage strip on the dashboard.

## Intended approval flow

```text
Discovered/pasted job → worker → application packet
           → pending approval → local review dashboard
           → explicit approval → supervised external action → audit record
```

Telegram, email, or Notion notifications can be added later as separate
adapters if wanted. They are not required by this scaffold. If any of them
end up needing genuine scheduling/branching/integration glue rather than
pipeline logic, that's the point where reaching for something like n8n would
actually earn its keep — unlike the daily-trigger role it played before.

## Review decisions

The review queue uses three decisions:

- `approve` means the packet is good enough to move to the next supervised step.
- `reject` means stop using that packet and close the item out.
- `regenerate` means keep the item pending and ask the orchestrator to produce a new draft or revised evidence.

All three decisions are recorded with the opaque `approval_id` so the queue can audit who decided what and when.

The review dashboard only records decisions. It does not submit applications or send messages.

## Provider selection and verification APIs

The worker can now normalize a public job URL and choose the appropriate adapter
without fetching the page:

```sh
curl -X POST http://localhost:8080/api/providers/resolve \
  -H 'content-type: application/json' \
  -d '{"source_url":"https://boards.greenhouse.io/example/jobs/123?utm_source=linkedin"}'
```

Greenhouse, Lever, and Ashby URL patterns are selected for public API adapters.
Unknown URLs are deliberately routed to `manual_review`; this endpoint does not
scrape, log in, or submit anything.

Verify a direct job URL:

```sh
curl -X POST http://localhost:8080/api/jobs/verify \
  -H 'content-type: application/json' \
  -d '{"source_url":"https://boards.greenhouse.io/example/jobs/123"}'
```

It calls the matching Greenhouse, Lever, or Ashby public job endpoint, returns a
normalized job record with retrieval time and source URL, and marks a missing
posting as `closed`. It does not make applications or use a browser.

## End-to-end local job pipeline

`POST /api/pipeline/jobs` runs the safe local workflow in one request: public
verification, stable-ID deduplication, hard location/seniority/stack gates,
evidence-backed fit evaluation, a review packet, and a pending review-queue
item. It never submits an application.

```sh
curl -X POST http://localhost:8080/api/pipeline/jobs \
  -H 'content-type: application/json' \
  -d '{"source_url":"https://boards.greenhouse.io/example/jobs/123","candidate":{"name":"Nivish","verified_facts":["Built and operated Node.js production systems.","Works with Docker and PostgreSQL."]}}'
```

Generated review packets are written to the worker artifact volume. The caller
must still use the review dashboard to record an explicit decision; approval is
not a submit action.

## Not implemented yet

- Notion credentials/property mapping and production workflow
- LLM prompts and model calls
- Apify fallback
- browser login or submission
- Canonical CV/PDF generation
- Telegram/email integrations

Never put browser cookies, API keys, or candidate identity documents in workflow JSON or source control.
