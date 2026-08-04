# n8n workflows

`local-job-pipeline.json` is an importable, credential-free smoke-test workflow.
It invokes the worker's safe local pipeline and leaves every external action under
human control.

`scheduled-job-discovery.json` is the daily automated discovery workflow. It is a
thin scheduler only — all discovery, verification, fit-scoring, and resume-matching
logic lives in the worker (`POST /api/discovery/run`), not in n8n.

## Import and run — local-job-pipeline

1. Start the stack from the repository root with `docker compose up -d --build`.
2. Open `http://localhost:5678` and create the initial n8n owner account.
3. In n8n, open the upper-right menu, choose **Import from File**, and select
   `local-job-pipeline.json`.
4. Open **Set job and candidate** and replace the placeholder `source_url` with
   a real public Greenhouse, Lever, or Ashby job URL.
5. Execute the workflow manually. Its HTTP request calls
   `http://worker:8080/api/pipeline/jobs` inside the Docker network.
6. If the result stage is `needs_review`, inspect the queue at
   `http://localhost:8080`.

If `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` are both set in `.env`, create
an n8n Basic Auth credential with the same values and attach it to the workflow's
HTTP Request node before executing it.

## Import and run — scheduled-job-discovery

1. Set `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, and `APIFY_API_TOKEN` in `.env`
   (worker-container env vars — see `.env.example`), then
   `docker compose up -d --build` so the worker picks them up.
2. In n8n, **Import from File** and select `scheduled-job-discovery.json`.
3. The **Every day at 07:00** node is a Schedule Trigger; adjust the hour to
   taste.
4. Its HTTP request calls `http://worker:8080/api/discovery/run` with no body —
   the worker reads its own config (`DISCOVERY_QUERY`, `DAILY_LEAD_CAP`,
   resume catalog) from its environment and the mounted resume folder.
5. Set the workflow **Active** once you're ready for it to run unattended.
   Results land in the review queue at `http://localhost:8080`, same as the
   manual pipeline — nothing auto-applies or auto-sends.

If `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` are both set in `.env`, the
`/api/discovery/run` endpoint is gated the same as every other worker route
(except `/health`) — create the n8n Basic Auth credential described above and
attach it to this workflow's HTTP Request node too, or the scheduled run will
get a 401.

## What local-job-pipeline does not do

The workflow does not require an Apify, Greenhouse, Lever, Ashby, Notion, or LLM
key. It does not scrape login-only pages, send messages, or submit applications.

Future workflows should build on these by adding an IF/Switch branch for
`needs_review`, `skipped`, `expired`, `duplicate`, and `manual_review` results.
Keep the review decision separate from any external action — neither workflow
auto-applies or auto-messages.
