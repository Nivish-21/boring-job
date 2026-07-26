# Boring Job

This is a separate Docker scaffold for the Career-Ops automation layer. It does not modify or execute the existing `career-ops-main` project.

## Current components

- `n8n` — orchestration, schedules, Notion updates, LLM calls, and approval waits.
- `postgres` — durable n8n execution/state storage.
- `worker` — internal HTTP service with a health endpoint and a local review-queue API; provider adapters remain to be added.
- `data/artifacts` — local output volume for reports and generated documents.
- `contracts/approval.json` — channel-neutral approval payload shape.
- `review/` — documentation for the local review dashboard/API served by the worker.

## Start locally

```sh
cp .env.example .env
# Replace both placeholder secrets in .env.
docker compose up -d --build
docker compose ps
```

Open n8n at `http://localhost:5678` and the local review queue at `http://localhost:8080`. Do not expose either directly to the public internet yet. The review dashboard remains localhost-only by default; set its Basic Auth credentials before any remote exposure.

## How Compose fits together

The `compose.yml` file starts the whole learning stack:

- `postgres` stores n8n data.
- `worker` serves the local review dashboard and review API.
- `n8n` is the visual workflow editor you use in the browser.

Use Docker Compose when you want the same local stack every time without running three separate containers by hand. The file also mounts local folders so data survives restarts.

## Intended approval flow

```text
Notion job → n8n → worker → application packet
           → pending approval → local review dashboard/Form
           → explicit approval → supervised external action → audit record
```

Telegram, email, Matrix, or Notion status changes can be added later as notification/approval adapters. They are not required by this scaffold.

## Review decisions

The review queue uses three decisions:

- `approve` means the packet is good enough to move to the next supervised step.
- `reject` means stop using that packet and close the item out.
- `regenerate` means keep the item pending and ask the orchestrator to produce a new draft or revised evidence.

All three decisions are recorded with the opaque `approval_id` so the queue can audit who decided what and when.

The review dashboard only records decisions. It does not submit applications or send messages.

## Provider selection API

The worker can now normalize a public job URL and choose the appropriate adapter
without fetching the page:

```sh
curl -X POST http://localhost:8080/api/providers/resolve \
  -H 'content-type: application/json' \
  -d '{"source_url":"https://boards.greenhouse.io/example/jobs/123?utm_source=linkedin"}'
```

Greenhouse, Lever, and Ashby URL patterns are selected for future public API
adapters. Unknown URLs are deliberately routed to `manual_review`; this endpoint
does not scrape, log in, or submit anything.

The first adapter is Greenhouse verification:

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

- Notion credentials/workflows
- LLM prompts and model calls
- ATS/API adapters
- Apify fallback
- browser login or submission
- ATS/provider adapters, LLM evaluation, and PDF generation
- Telegram/email integrations

Never put browser cookies, API keys, or candidate identity documents in workflow JSON or source control.
