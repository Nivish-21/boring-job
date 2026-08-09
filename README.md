# Boring Job

Boring Job is a local-first, human-in-the-loop career-operations assistant. It
discovers and verifies job postings, evaluates fit, matches a trusted resume,
prepares review packets, and drafts outreach to founders who are already in the
user's LinkedIn connections export.

It never submits an application or sends a message. Every external action stays
manual and supervised.

This repository is independent of `career-ops-main`; running it does not modify
or execute that project.

## Project status

The worker, dashboard, job pipeline, founder-outreach pipeline, local scheduler,
and provider fallbacks are implemented. The automated test suite currently has
174 passing tests.

The project is designed for one operator on one machine. It stores state in
local JSON files and Markdown artifacts rather than in a hosted database.

## What is implemented

### Job workflow

- Firecrawl search for individual job URLs, biased towards Greenhouse, Lever,
  and Ashby postings.
- Direct verification through the public Greenhouse, Lever, and Ashby job APIs.
- Firecrawl scrape fallback for unsupported URLs, with Apify as the secondary
  fallback.
- Provider circuit breakers that pause a failing fallback instead of repeatedly
  spending credits.
- Rejection of known aggregator pages and scraped company homepages that do not
  look like individual postings.
- Stable-ID deduplication, a configurable daily review-packet cap, and durable
  recording of skipped, closed, unverified, and capped jobs.
- Deterministic location, seniority, and technology-fit gates.
- OpenAI-assisted resume-bucket matching and extraction of relevant facts from
  local reference-resume text.
- Markdown application packets and pending review items for jobs that pass the
  gates.

### Founder-outreach workflow

- Import of the user's own LinkedIn `Connections.csv` export.
- Filtering for founder, co-founder, founding, CEO, and chief-executive titles.
- Company website, LinkedIn, careers-page, and open-role research.
- Reuse of the verified job pipeline when a matching role is found.
- Optional recent LinkedIn-post context through Apify.
- OpenAI-drafted messages with prompts that prohibit unsupported claims and
  code-level checks for placeholders, generic phrases, and other known failure
  patterns.
- Company context and talking points for the human who handles any reply.
- Per-profile deduplication and targeted regeneration of a draft.

Founder outreach is manually triggered. There is no founder-import scheduler.

### Review dashboard

The worker serves a dashboard at `http://localhost:8080` with separate job and
founder-outreach views. It includes status, company, and fit filters; source
evidence; drafts; company context; talking points; regeneration; and
Firecrawl/Apify usage indicators.

Approving or rejecting an item records a decision only. Copying a founder draft
copies text to the clipboard only. Neither action sends or submits anything.

## Architecture

Docker Compose runs one Node.js service:

```text
manual URL / Firecrawl discovery / LinkedIn CSV
                         |
                         v
                 Node.js worker
       verification -> fit/research -> draft
                         |
             local JSON + Markdown artifacts
                         |
                         v
              local review dashboard
                         |
                         v
             supervised external action
```

The worker contains the HTTP API, static dashboard, pipelines, durable local
stores, and optional daily job-discovery scheduler. n8n and PostgreSQL are not
part of the current architecture.

## Requirements

- Docker Desktop with Docker Compose, or Node.js 22 for running the worker
  directly.
- A directory containing the resume catalogue expected by
  `worker/src/resume-catalog.mjs` if resume matching is required.
- `curl` for the examples below.
- `jq` only for the optional bulk-regeneration example.

External credentials are feature-specific:

| Variable | Used for | Required? |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | Job discovery, fallback scraping, and company research | Required for discovery and research |
| `OPENAI_API_KEY` | Resume matching, fact selection, and founder drafts | Required for those AI-assisted steps |
| `APIFY_API_TOKEN` | Secondary scrape fallback and recent founder-post context | Optional |
| `APIFY_ACTOR_ID` | Custom fallback scraper actor | Optional |
| `CANDIDATE_NAME` | Name placed in generated job packets | Recommended |
| `RESUME_HOST_DIR` | Host directory mounted read-only at `/app/resumes` | Required for resume matching |
| `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` | Basic Auth for the dashboard and APIs | Required together if the service is exposed beyond localhost |

`NOTION_TOKEN` is present in the example environment file for a possible future
adapter, but the current worker does not use it.

### Resume catalogue contract

`RESUME_HOST_DIR` must contain a `README.md` table and matching files. The
worker reads five columns in this order: number, file stem, target role, fit
score, and positioning angle.

```markdown
| # | File | Target Role | Fit Score | Positioning Angle |
| --- | --- | --- | --- | --- |
| 01 | Backend-Engineer | Backend Engineer | 9.0 | Production API experience |
```

For that row, the catalogue layout is:

```text
README.md
01-Backend-Engineer.pdf
01-Backend-Engineer.docx
reference/01-Backend-Engineer.txt
```

The reference text is the source used for AI-assisted fact selection. A missing
reference file degrades to no extracted facts. The worker does not create or
edit the PDF and DOCX files.

## Quick start

Start Docker Desktop and confirm that its engine is available:

```sh
open -a Docker
docker version
```

Create local configuration:

```sh
cp .env.example .env
```

At minimum, set `RESUME_HOST_DIR` to an existing resume-catalogue directory if
you want resume matching. Add only the provider keys required by the workflows
you intend to run. Do not commit `.env`, connections exports, resumes, or API
credentials.

Build and start the worker:

```sh
docker compose up -d --build
docker compose ps
curl http://localhost:8080/health
```

Open `http://localhost:8080`. The published port is bound to `127.0.0.1` by
default.

If startup fails:

```sh
docker compose logs --follow worker
```

Stop the service without deleting local state:

```sh
docker compose down
```

Do not use `docker compose down --volumes` unless deleting Docker-managed
volumes is intentional. This project primarily uses bind-mounted local data,
which should still be backed up separately.

## Run the job pipeline

Process one public job posting:

```sh
curl -X POST http://localhost:8080/api/pipeline/jobs \
  -H 'content-type: application/json' \
  -d '{"source_url":"PASTE_A_REAL_PUBLIC_JOB_URL"}'
```

The response reports the stage reached. A job that passes verification and fit
gates becomes `needs_review`; it is not applied to automatically.

An API caller may explicitly provide trusted candidate facts. Those facts take
precedence over automatic extraction:

```sh
curl -X POST http://localhost:8080/api/pipeline/jobs \
  -H 'content-type: application/json' \
  -d '{"source_url":"PASTE_A_REAL_PUBLIC_JOB_URL","candidate":{"name":"YOUR_NAME","verified_facts":["A fact verified against the candidate resume."]}}'
```

Trigger a discovery run manually:

```sh
curl -X POST http://localhost:8080/api/discovery/run
```

Discovery and fallbacks can consume paid provider credits. Review the usage
indicators in the dashboard before enabling unattended runs.

### Optional daily job discovery

Set these values in `.env`, then rebuild the worker:

```dotenv
DISCOVERY_SCHEDULE_ENABLED=true
DISCOVERY_HOUR_UTC=7
```

```sh
docker compose up -d --build
```

The scheduler is off by default. It runs job discovery once during the selected
UTC hour. It does not schedule founder imports.

## Import founder connections

Request a LinkedIn connections export from the account that owns the
connections, then post its `Connections.csv` file directly to the worker:

```sh
curl -X POST http://localhost:8080/api/founders/import \
  -H 'content-type: text/csv' \
  --data-binary @/path/to/Connections.csv
```

Each call processes at most `DAILY_LEAD_CAP` new founder profiles, defaulting to
20. Previously recorded profile URLs are skipped. Re-run the import manually on
later days to process a larger file.

The workflow may spend Firecrawl, OpenAI, and Apify credits. It creates review
items even when drafting fails, so failures remain visible instead of being
silently discarded. The dashboard's regenerate action retries one stored
profile without re-importing the CSV.

Never commit the LinkedIn export. It contains personal data.

## Review and regeneration

Pending review tokens expire after 48 hours. The dashboard supports:

- **Approve** — record that the current packet or message passed review.
- **Reject** — close the current review item.
- **Regenerate** — reject the stale pending item, re-run the relevant workflow,
  and create a fresh review item.

Job regeneration re-verifies the original posting. It fails deliberately if the
job is no longer live.

To regenerate one job by API:

```sh
curl -X POST "http://localhost:8080/api/pipeline/jobs/URL_ENCODED_STABLE_ID/regenerate"
```

To regenerate every job currently waiting for review:

```sh
curl -s 'http://localhost:8080/api/pipeline/jobs?status=needs_review' \
  | jq -r '.jobs[].stable_id' \
  | while read -r stable_id; do
      encoded_id="$(jq -rn --arg value "$stable_id" '$value | @uri')"
      curl -s -X POST "http://localhost:8080/api/pipeline/jobs/$encoded_id/regenerate" \
        | jq --arg stable_id "$stable_id" '{stable_id: $stable_id, ok, error}'
    done
```

Bulk regeneration can consume the same paid provider credits as normal
processing. Run it deliberately and inspect the resulting packets.

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public worker health check |
| `GET` | `/api/review/items` | List review items; optional `status` query |
| `POST` | `/api/review/items` | Create a validated review item |
| `POST` | `/api/review/items/:id/decision` | Record an approval, rejection, regeneration marker, or skip |
| `POST` | `/api/providers/resolve` | Normalise a URL and select its provider adapter |
| `POST` | `/api/jobs/verify` | Verify a supported ATS URL through its public API |
| `POST` | `/api/pipeline/jobs` | Process one job through the safe pipeline |
| `GET` | `/api/pipeline/jobs` | List pipeline records; optional `status` query |
| `POST` | `/api/pipeline/jobs/:stableId/regenerate` | Rebuild one stored job packet |
| `POST` | `/api/discovery/run` | Run job discovery now |
| `POST` | `/api/founders/import` | Import a LinkedIn connections CSV |
| `POST` | `/api/founders/:profile/regenerate` | Rebuild one stored founder draft |
| `GET` | `/api/usage` | Read Firecrawl and Apify usage summaries |

When Basic Auth is configured, every route except `/health` requires it.

The legacy `/scan`, `/verify`, `/evaluate`, and `/generate` routes intentionally
return HTTP 501 and must not be treated as working endpoints.

## Local data

Compose bind-mounts these directories:

- `data/review/` — review items, pipeline jobs, founder records, and provider
  circuit-breaker state.
- `data/artifacts/` — generated Markdown job packets.
- `RESUME_HOST_DIR` — the external resume catalogue, mounted read-only.

The JSON stores use atomic replacement for writes but are not a multi-user
database. Back up `data/review/` before moving machines or making manual edits.

## Verification

Run the worker tests with Node.js 22:

```sh
cd worker
npm test
```

Validate the Compose configuration from the repository root:

```sh
docker compose config --quiet
```

## Deliberate limitations

- No automatic application submission, browser login, or form filling.
- No automatic LinkedIn, email, Telegram, or other message sending.
- No Notion integration.
- No generation of a new tailored PDF or DOCX resume. The worker selects from an
  existing, externally managed resume catalogue and generates Markdown packets.
- No hosted database, multi-user locking, or remote deployment configuration.
- Generic non-ATS pages use heuristic scrape validation and may remain
  `unverified` for manual review.
- The job fit evaluator contains project-specific rules, including an India/
  remote eligibility bias and a seniority gate. Review them before adapting the
  project for another candidate.

## Repository map

```text
compose.yml             One-service local deployment
worker/src/             API, pipelines, providers, stores, and scheduler
worker/public/          Review dashboard
contracts/              Approval payload contract
review/README.md        Review-surface behaviour and integration notes
data/artifacts/         Generated Markdown packets
data/review/            Durable local state
PLAN.md                 Historical design record; not the current architecture
```

Never place browser cookies, API keys, connections exports, resumes, or other
candidate identity documents in source control.
