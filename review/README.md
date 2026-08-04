# Review surface

The first review surface is now served by the worker at `http://localhost:8080`.
It is intentionally a local queue: it records review decisions but cannot submit
an application or send a message.

Set `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` in `.env` before exposing the
dashboard anywhere beyond localhost. For a local n8n workflow, use the worker
hostname (`http://worker:8080`) rather than `localhost`, because n8n runs in its
own container. Configure the same Basic Auth values in n8n's HTTP Request
credential when they are enabled. n8n can create a review item with:

```http
POST http://worker:8080/api/review/items
Content-Type: application/json

{
  "item_id": "notion-page-id",
  "kind": "job",
  "title": "Backend Engineer — Example Co",
  "source_url": "https://jobs.example.com/backend-engineer",
  "summary": "Evidence-backed fit summary for human review.",
  "fit_score": 8,
  "draft": "Tailored cover-letter or application-answer draft.",
  "evidence": [{ "label": "Job posting", "url": "https://jobs.example.com/backend-engineer" }]
}
```

The dashboard includes the opaque `approval_id` in every decision request. That
ID expires after 48 hours and is consumed after approval or rejection. A
regenerate request keeps the item in the queue with the same approval token.
An orchestrator must still perform a separate, supervised next step.

Decision meanings:

- `approve` records that the current packet can move to the next supervised step.
- `reject` records that this packet should not be used as-is and closes the item.
- `regenerate` records that the item should stay pending while the orchestrator builds a revised draft.

This surface records decisions only. It does not submit an application or send a message.

Each item shows:

- source job/founder evidence;
- fit score and uncertainty;
- generated resume/message;
- direct source/application link;
- approve, reject, and regenerate actions.

External submission must require a second confirmation after the artifact is opened.

## Local checklist

1. Start Docker Desktop, then run `docker compose up -d --build` in the project
   root.
2. Check `curl http://localhost:8080/health`.
3. Open the dashboard at `http://localhost:8080`.
4. Run the documented pipeline endpoint or the n8n Manual Trigger workflow.
5. Review the source and draft; record a decision. No decision sends or submits
   anything externally.
