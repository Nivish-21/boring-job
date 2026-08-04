# n8n workflows

`local-job-pipeline.json` is an importable, credential-free smoke-test workflow.
It invokes the worker's safe local pipeline and leaves every external action under
human control.

## Import and run

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

## What it does not do

The workflow does not require an Apify, Greenhouse, Lever, Ashby, Notion, or LLM
key. It does not scrape login-only pages, send messages, or submit applications.

Future workflows should build on this one by adding a Notion trigger or schedule,
then an IF/Switch branch for `needs_review`, `skipped`, `expired`, `duplicate`,
and `manual_review` results. Keep the review decision separate from any external
action.
