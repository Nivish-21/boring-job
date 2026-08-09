# Review surface

The review dashboard is served by the worker at `http://localhost:8080`. It
combines durable pipeline records with pending and completed review items so the
operator can inspect both successful drafts and jobs that were skipped, closed,
unverified, rejected as bad sources, or deferred by the daily cap.

It is a decision and copy surface only. It cannot submit an application or send
a founder message.

## Security boundary

Docker Compose binds the worker to `127.0.0.1` by default. Set both
`REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` before exposing it beyond the
local machine. The worker refuses to start if only one value is set.

When Basic Auth is enabled, `/health` remains public and all dashboard assets
and `/api/*` routes require authentication.

## What the dashboard shows

- Separate founder-outreach and job views.
- Pending, approved, rejected, skipped, capped, unverified, expired, and bad-
  source statuses.
- Company search and minimum-fit filters.
- Original source links and supporting evidence.
- Job packets, founder messages, company context, and talking points.
- Firecrawl and Apify usage summaries when those providers are configured.
- Copy, approve, reject, and kind-specific regenerate actions.

Founder messages are copied to the clipboard for manual pasting. External
submission or sending always requires a separate action outside this project.

## Review lifecycle

A new review item receives an opaque `approval_id` and expires after 48 hours.
Every decision request must present the matching token. Final approve, reject,
and skip decisions consume it and are appended to the item's decision history.

The dashboard's regenerate button does more than record a generic review
decision:

- For a job, it calls `/api/pipeline/jobs/:stableId/regenerate`, re-verifies the
  posting, and produces a fresh packet.
- For a founder, it calls `/api/founders/:profile/regenerate` and re-runs the
  stored profile's research and drafting workflow.

In both cases, the old pending item is rejected as superseded and a new review
item is created. A dead job fails regeneration rather than producing a packet
from stale evidence.

## Creating a review item directly

The normal pipelines create their own review items. A separate trusted local
tool can also use the validated API directly:

```http
POST http://localhost:8080/api/review/items
Content-Type: application/json

{
  "item_id": "source-system-id",
  "kind": "job",
  "title": "Backend Engineer — Example Co",
  "source_url": "https://jobs.example.com/backend-engineer",
  "summary": "Evidence-backed fit summary for human review.",
  "fit_score": 8,
  "draft": "Draft content that still requires human review.",
  "evidence": [
    {
      "label": "Job posting",
      "url": "https://jobs.example.com/backend-engineer"
    }
  ]
}
```

`kind` must be `job` or `founder`. URLs must use HTTP or HTTPS. Field lengths,
fit-score bounds, and evidence counts are validated before the item is stored.

## Decision API

Record a decision against a pending item:

```http
POST http://localhost:8080/api/review/items/REVIEW_ITEM_ID/decision
Content-Type: application/json

{
  "action": "approve",
  "approval_id": "OPAQUE_APPROVAL_ID",
  "actor": "local-reviewer",
  "reason": "Evidence and draft checked."
}
```

The low-level decision endpoint accepts `approve`, `reject`, `regenerate`, and
`skip`. A low-level `regenerate` decision only leaves the item pending; it does
not rebuild content. Use the dashboard or the kind-specific regeneration routes
when a new draft is required.

## Local verification

1. Run `docker compose up -d --build` from the repository root.
2. Check `curl http://localhost:8080/health`.
3. Open `http://localhost:8080`.
4. Run a documented job or founder workflow from the root README.
5. Inspect the evidence and draft, then record a decision.
6. Confirm that no decision has sent a message or submitted an application.

n8n and PostgreSQL are not part of the current deployment. The worker owns the
API, dashboard, scheduler, pipelines, and local state.
