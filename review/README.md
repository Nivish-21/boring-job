# Review surface

The first review surface is now served by the worker at `http://localhost:8080`.
It is intentionally a local queue: it records review decisions but cannot submit
an application or send a message.

Set `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` in `.env` before exposing the
dashboard anywhere beyond localhost. n8n can create a review item with:

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

Each item shows:

- source job/founder evidence;
- fit score and uncertainty;
- generated resume/message;
- direct source/application link;
- approve, reject, and regenerate actions.

External submission must require a second confirmation after the artifact is opened.
