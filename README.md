# Boring Job

This is a separate Docker scaffold for the Career-Ops automation layer. It does not modify or execute the existing `career-ops-main` project.

## Current components

- `n8n` — orchestration, schedules, Notion updates, LLM calls, and approval waits.
- `postgres` — durable n8n execution/state storage.
- `worker` — private HTTP service placeholder for fetching, verification, PDF generation, and browser-assisted work.
- `data/artifacts` — local output volume for reports and generated documents.
- `contracts/approval.json` — channel-neutral approval payload shape.
- `review/` — placeholder for the local review UI/API.

## Start locally

```sh
cp .env.example .env
# Replace both placeholder secrets in .env.
docker compose up -d --build
docker compose ps
```

Open n8n at `http://localhost:5678`. Do not expose this directly to the public internet yet. HTTPS, authentication, backups, and a private review surface must be configured before remote access or webhooks are enabled.

## Intended approval flow

```text
Notion job → n8n → worker → application packet
           → pending approval → local review dashboard/Form
           → explicit approval → supervised external action → audit record
```

Telegram, email, Matrix, or Notion status changes can be added later as notification/approval adapters. They are not required by this scaffold.

## Not implemented yet

- Notion credentials/workflows
- LLM prompts and model calls
- ATS/API adapters
- Apify fallback
- browser login or submission
- local review dashboard
- Telegram/email integrations

Never put browser cookies, API keys, or candidate identity documents in workflow JSON or source control.
