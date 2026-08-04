# Boring Job

This is a separate Docker scaffold for the Career-Ops automation layer. It does not modify or execute the existing `career-ops-main` project.

## Current components

- `n8n` — orchestration, schedules, Notion updates, LLM calls, and approval waits.
- `postgres` — durable n8n execution/state storage.
- `worker` — internal HTTP service with public-ATS verification, local pipeline, and review-queue APIs.
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

Create the local configuration file and generate the two required secrets:

```sh
cp .env.example .env
openssl rand -hex 32
# Paste a different generated value into each placeholder in .env:
# N8N_ENCRYPTION_KEY and POSTGRES_PASSWORD.
docker compose up -d --build
docker compose ps
```

Open n8n at `http://localhost:5678` and the local review queue at
`http://localhost:8080`. On n8n's first visit, create its owner account. Both
ports bind to `localhost` only, so they are not reachable from another machine.

If a service fails to start, inspect it with:

```sh
docker compose logs --follow worker
docker compose logs --follow n8n
```

To stop the stack without deleting its data:

```sh
docker compose down
```

To start it again later, use `docker compose up -d`. Do not use `down --volumes`
unless you intend to erase the local n8n/Postgres data.

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

The `compose.yml` file starts the whole learning stack:

- `postgres` stores n8n data.
- `worker` serves the local review dashboard and review API.
- `n8n` is the visual workflow editor you use in the browser.

Use Docker Compose when you want the same local stack every time without running three separate containers by hand. The file also mounts local folders so data survives restarts.

## Start the n8n workflow now

Yes—start it now, before connecting Notion or an LLM. The first workflow can be
tested entirely against the local worker and a public job URL.

1. Open `http://localhost:5678` and create a workflow.
   Or use the three-node starter in
   [`workflows/local-job-pipeline.json`](workflows/local-job-pipeline.json):
   in n8n, select the menu in the upper-right, choose **Import from File**, and
   select it. Replace its placeholder job URL before executing it.
2. Add **Manual Trigger**.
3. Add **Edit Fields** and set `source_url` to a real Greenhouse, Lever, or
   Ashby job URL. Add `candidate` as a JSON object with `name` and
   `verified_facts`.
4. Add **HTTP Request**: method `POST`, URL
   `http://worker:8080/api/pipeline/jobs`, body type **JSON**, body
   expression `={{ $json }}`.
5. If `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` are set, attach an n8n
   Basic Auth credential using those same values. Otherwise keep the worker
   dashboard localhost-only and leave authentication blank for this local test.
6. Execute the workflow, inspect the returned `result.stage`, and open the
   review dashboard if it is `needs_review`.

Add an **IF** node after the request when you want separate branches for
`needs_review`, `skipped`, `expired`, `duplicate`, and `manual_review`. Only
after this path works should the Manual Trigger be replaced with a Notion trigger
or schedule.

The importable workflow intentionally has no credentials. If you enable review
Basic Auth, edit its **Run local job pipeline** HTTP Request node and attach an
n8n Basic Auth credential before executing it.

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
