# n8n Job Search Automation Plan

**Status:** Local job-pipeline foundation implemented; production integrations remain unconfigured.

**Purpose:** Define a self-hosted n8n system that uses the existing `career-ops` project as the candidate-knowledge and document-generation layer, while keeping application submission and outbound networking under explicit human control.

## Implementation status

The repository now includes a local Docker stack, review dashboard, durable local
review/pipeline stores, direct public-ATS verification for Greenhouse, Lever, and
Ashby, deterministic safety/fit gates, application-packet Markdown artifacts,
and an importable n8n manual-smoke-test workflow. The worker never logs in,
sends a message, or submits an application.

| Area | Status | Remaining work |
|---|---|---|
| Docker stack and health checks | Implemented | Start Docker Desktop and perform a live smoke test. |
| ATS URL selection and verification | Implemented for Greenhouse, Lever, Ashby | Add adapters only for future permitted sources. |
| Local fit gates and review packets | Implemented | Connect canonical CV/PDF generation and optional LLM evaluation. |
| Human review dashboard | Implemented | Optional notification adapters. |
| n8n workflow | Importable manual smoke test | Add Notion mapping, schedule, branches, and credentials. |
| Apify | Planned, disabled by default | Choose a permitted Actor, input schema, budget, and max-run charge. |
| Founder research/outreach | Planned | Supply an approved/manual input source and build the public-source research flow. |

**Candidate context:** Nivish Vincent Raj, India-based junior/early engineer targeting small, early-stage teams hiring for Node.js, Python/FastAPI/Django, JavaScript/TypeScript, full-stack, product, forward-deployed, and AI-native engineering work.

**Primary signal:** Shipped and operated production systems end-to-end (Cabocab) plus high-velocity AI-native building. Do not treat OSRM/PostGIS as a geospatial specialization.

---

## 0. Feasibility reassessment

The earlier conclusion was too categorical. The correct distinction is:

- **Technically possible:** yes, multiple public workflows and open-source projects demonstrate job scraping, LLM matching, resume generation, browser form filling, and application logging.
- **Available through approved APIs:** sometimes; access depends on the platform, app approval, and scopes.
- **Reliable across every site:** no; forms, authentication, CAPTCHA, anti-bot controls, and required declarations vary.
- **Permitted for unattended use:** depends on the platform's terms and the specific approved integration.

Evidence found in the follow-up search:

- [ApplyAgent.AI open-source project](https://github.com/Dinesh-Satram/job_application_agent_SL) demonstrates a real Playwright/browser-use application agent that logs in, discovers LinkedIn Easy Apply jobs, fills forms, uploads resumes, submits, and records application history. Its claimed speed/success metrics are self-reported by the repository and should not be treated as independently validated.
- [n8n LinkedIn job intelligence template](https://n8n.io/workflows/12838-build-a-linkedin-job-intelligence-pipeline-with-apify-and-google-sheets/) demonstrates scheduled Apify job collection, deduplication, date calculations, batching, and structured output.
- [n8n LinkedIn profile research/email-draft template](https://n8n.io/workflows/8012-automate-linkedin-profile-research-and-email-outreach-with-apify-gemini-and-sheets/) demonstrates profile enrichment through Apify, LLM personalization, and saving email drafts.
- [n8n AI resume-tailoring template](https://n8n.io/workflows/11215-automate-job-applications-with-ai-resume-tailoring-using-gpt-4o-linkedin-and-gmail/) demonstrates job collection, LLM fit filtering, tailored documents, and outreach drafts.

Therefore, the system should not be described as impossible. It should be described as a feasible automation project with variable provider access, site-specific reliability, and explicit approval/terms constraints.

The implementation plan should test the narrowest end-to-end slice first instead of rejecting the entire concept:

```text
one known job source → one extractor → one LLM evaluator → one tailored PDF → one Notion update
```

Only after that works should we add Apify fallback logic, more sources, browser form filling, or founder research.

## 0A. Independently researched implementation alternatives

The two ideas do not need to become one large LinkedIn bot. A more robust design is source-agnostic: n8n orchestrates, a small worker service fetches and normalizes data, an LLM evaluates and drafts artifacts, and a human approves external actions.

### Alternative A — ATS/API-first job pipeline (recommended baseline)

Use the Notion database as the work queue, then resolve each job to the employer's public ATS endpoint before opening a browser. Greenhouse exposes public job-board data; Ashby exposes public job postings; Lever exposes published postings and an application endpoint, although submission requires an employer-authorized API key. These adapters are cheaper and more deterministic than portal scraping.

Pipeline: `Notion row → provider detector → Greenhouse/Ashby/Lever/YC fetcher → canonical job record → fit evaluation → tailored resume/cover-letter packet → review queue`.

Add adapters for the YC company API and a company's own careers page for small startups. Use Apify only when an adapter cannot resolve a page, with a circuit breaker and a per-provider error budget.

### Alternative B — Source-agnostic crawler with provider adapters

Run a self-hosted Node/TypeScript worker using Playwright/Crawlee for public pages. Each adapter implements `discover`, `fetch`, `normalize`, `health`, and `cost`. n8n calls the worker over an internal HTTP endpoint and stores state in Postgres (or SQLite for a single-user pilot). This keeps browser logic out of n8n and makes it possible to replace Apify, a portal, or a parser without redesigning the workflow.

### Alternative C — Application packet first, assisted submission second (recommended application mode)

Generate a verified application packet first: resume PDF/DOCX, cover letter, answers to recurring questions, source URL, and a fit rationale. A headed Playwright session can then fill a form while the user watches and approves the final submit. This captures most of the time savings while avoiding silent submission, wrong-company applications, duplicate applications, and unexpected screening answers.

### Alternative D — Full browser autopilot (experimental only)

Open-source projects such as ApplyAgent.AI demonstrate that browser-use/Playwright agents can discover LinkedIn Easy Apply listings, fill forms, upload a profile, and run in Docker. Their speed and success percentages are self-reported repository claims, not independent benchmarks. Treat this as a disposable experiment behind a feature flag, not the default production path; websites change selectors, CAPTCHAs and login challenges interrupt runs, and an unattended agent can submit an incorrect answer.

### Alternative E — Employer-authorized ATS submission

For an employer that explicitly provides an integration, submit through its ATS API rather than automating a browser. Greenhouse and Lever document candidate/application APIs, but the application endpoints are not general-purpose public keys: they require employer-side authorization and validation. This is useful only for a permitted partner integration, not for arbitrary job applications.

### Alternative F — Founder research without scraping LinkedIn

Use one of these input methods, in descending order of automation and control:

1. **Official export:** periodically download LinkedIn's account archive/connections export, place it in an n8n watch folder, and diff snapshots by profile URL/name/company. Verify the current archive fields before relying on a connection-date column.
2. **Manual capture webhook:** paste a founder's profile URL (and optionally copied public text) into a small n8n form. The workflow researches only public sources: company website, careers/ATS pages, YC directory/API, GitHub organization, product docs/changelog, blog/RSS, press, and public videos.
3. **Approved OAuth APIs:** if LinkedIn grants the application access, use the Connections, Posts, and Communications APIs. These are restricted products; documented connection responses do not provide a reliable “connected on” timestamp, so snapshot-diffing is still needed.
4. **Public-signal discovery:** discover founders from YC, company sites, GitHub, Product Hunt, RSS/news, podcasts, and conference pages, then let the user open LinkedIn and send the approved draft manually.

The LLM should produce a concise research brief with three labels: **observed fact**, **reasonable inference**, and **unknown**. It should propose a specific, low-pressure conversation opener tied to an observed product or hiring signal—not claim to know a private problem.

### Cost/reliability comparison

| Method | External cost | Reliability | Coverage | Best use |
|---|---:|---|---|---|
| Greenhouse/Ashby/Lever/YC public APIs | $0 | High | Medium | Primary job ingestion |
| Self-hosted Playwright/Crawlee | $0 | Medium | Medium | Public pages and fallback adapters |
| Apify free allowance | $0 until allowance is exhausted | Medium–high convenience | High where actor works | Burst/fallback extraction |
| LinkedIn export/manual capture | $0 | High | Low–medium | Founder input and compliant review |
| Approved LinkedIn APIs | Usually no per-call fee | High after approval | Restricted | Permitted first-party integrations |
| Unattended browser autopilot | LLM/server costs | Low–medium | Potentially high | Short, supervised experiment only |

### Recommended staged architecture

`Ingest → Normalize → Fetch → Evaluate → Generate → Human review → Submit/send → Track`

- **n8n:** schedules, retries, branching, Notion writes, notifications, and approval gates.
- **Worker container:** provider adapters, Playwright/Crawlee, PDF/text extraction, rate limits, and health checks.
- **State store:** Postgres for durable runs, hashes, provider health, submissions, and audit logs; SQLite is acceptable for a local pilot.
- **LLM boundary:** send only normalized job/founder evidence and the user's profile; keep prompts/versioned outputs in the state store.
- **Safety boundary:** require an explicit approval token immediately before an application submit or message send; enforce one-company/one-role dedupe and a daily cap.
- **Fallback policy:** direct API → self-hosted fetcher → Apify actor → manual review. A provider error opens a circuit breaker; it does not silently switch to a different identity or submit blindly.

### Validation plan before scaling

1. Replay 10–20 existing Notion jobs from two ATS providers; measure fetch success, field completeness, duplicate rate, and fit-review agreement.
2. Generate packets for five roles and manually compare them with the source JD and the profile; fix extraction/prompt errors before any submission automation.
3. Run the assisted browser path on two sandbox/test applications or user-approved real forms with submit disabled; record selector failures and CAPTCHA frequency.
4. Pilot founder research with five manually captured founders; require evidence links and a human approval for every draft. Only then consider an approved outbound send integration.

---

## 1. Executive decision

Build two related workflows:

1. **Job pipeline:** Notion jobs → fetch and verify public job page → compare against CV/profile → generate a tailored resume/application packet → update Notion → human reviews and submits.
2. **Founder research/outreach:** user-provided or approved connection data → research public company sources → identify evidence-backed product/problem hypotheses → draft a conversation opener → human reviews and sends.

Do **not** build a system that independently submits job applications, scrapes LinkedIn continuously, bypasses CAPTCHA/MFA/rate limits, or sends LinkedIn messages without review and approved access.

The right automation boundary is:

```text
automate discovery, verification, research, scoring, drafting, document generation, and tracking
human approves identity-sensitive, legal, reputational, and send/submit actions
```

---

## 2. Current repository facts

This repository is a local CLI/workspace, not a hosted application server. It contains Node.js scripts, Markdown modes, Playwright-based utilities, CV templates, and tracker files.

Existing personalized files:

- `cv.md` — canonical CV source
- `config/profile.yml` — candidate identity, targeting, narrative, and compensation
- `modes/_profile.md` — user-specific targeting rules
- `portals.yml` — scanner configuration
- `.env` — currently contains the Notion token; never commit it
- `config/notion.yml` — Notion database IDs and sync configuration

Current setup check:

- `npm run doctor` found the required user files.
- Dependencies are not currently installed.
- Playwright Chromium is not currently installed.
- No `Dockerfile` or `docker-compose.yml` currently exists in the repository.

Existing useful scripts include:

- `scan.mjs` — zero-LLM-token scanner for configured public ATS APIs and remote sources
- `check-liveness.mjs` — Playwright-based posting liveness verification
- `generate-pdf.mjs` — tailored PDF generation
- `verify-pipeline.mjs` — tracker integrity validation
- `cv-sync-check.mjs` — CV/profile consistency checks
- `push-jobs.mjs` and related Notion scripts — direct REST-based Notion writes using `NOTION_TOKEN`

The existing project rules require junior/early roles, small companies, stack alignment, India/global-remote feasibility, live direct links, one company/role row, and no automatic applications.

Before the first production scan, reconcile two profile issues:

- `config/profile.yml` currently says ₹10–18 LPA while the targeting rules emphasize approximately ₹5–12 LPA India roles.
- `AI Agent Architect` should remain future/secondary only; do not target roles that require LangGraph, CrewAI, or complex agent orchestration before those skills are genuinely acquired.

---

## 3. Fact check: job workflow

| Capability | Feasibility | Notes |
|---|---|---|
| Read jobs from Notion | Yes | Use the Notion API or n8n Notion node. The jobs database IDs are already in `config/notion.yml`. |
| Visit public job pages | Yes, with limits | HTTP requests and Playwright can handle public pages. Login-only, CAPTCHA, heavily dynamic, or blocked pages need a manual queue. |
| Verify a posting is live | Yes | Use direct ATS APIs where available, then Playwright/browser verification for important pages. |
| Score candidate compatibility | Yes, advisory | LLM compares JD, CV, and profile. It can be wrong; require evidence and a confidence field. |
| Generate a tailored resume | Yes | Reuse `career-ops` templates and `generate-pdf.mjs`. Never invent experience, metrics, or skills. |
| Generate application answers | Yes, draft-only | The LLM can draft truthful answers from the CV and JD. Required declarations must be confirmed by the user. |
| Submit every application automatically | No reliable general solution | Job forms differ, and application APIs are usually employer-facing or require employer credentials. Greenhouse's public job API is readable, but its application submission endpoint requires the employer's Job Board API key. |

The job workflow is therefore a high-value preparation and tracking automation, not an unattended applicant.

---

## 4. Fact check: founder/LinkedIn workflow

| Capability | Feasibility | Notes |
|---|---|---|
| Detect newly added connections | Limited | LinkedIn's Connections API is restricted to approved applications and returns first-degree connection data. The documented response does not provide a dependable connection-date field; use a user-provided export or periodic approved snapshot/diff if needed. |
| Identify founders | Limited | Requires enough profile information from approved API access or user-provided data. Do not infer identity from name alone. |
| Read LinkedIn posts | Limited | LinkedIn's Posts API requires restricted member-social permissions and approved access. |
| Research public company websites | Yes | Fetch public pages, documentation, changelog, careers, pricing, and product pages. Respect robots, rate limits, and terms. |
| Infer a company's problems | Partly | Generate hypotheses from public evidence; do not claim knowledge of confidential/internal problems. |
| Draft a personalized message | Yes | Draft from verified facts and a concrete, modest value proposition. |
| Send LinkedIn messages automatically | Usually no | Communication APIs exist but are restricted. LinkedIn prohibits unauthorized bots, scraping, automated contact handling, and automated messaging. |

This workflow should be a research and drafting assistant. The user reviews and sends the final message.

---

## 5. External references reviewed

### YouTube/tutorial material

These are useful for workflow ideas, not proof that the demonstrated automation is permitted or reliable:

- [Automate Your Job Search with LinkedIn & n8n — Jono Catliff](https://www.classcentral.com/course/youtube-automate-your-job-search-with-linkedin-n8n-489775)
  - Describes LinkedIn job collection, OpenAI fit scoring, cover-letter generation, and Google Sheets tracking.
  - Useful pattern: jobs → structured score → tailored document → tracker.
  - The advertised autopilot submission behavior is not evidence of reliable cross-site operation.
- [Automate Your Job Search Using AI — Indeed, LinkedIn, ZipRecruiter](https://www.classcentral.com/course/youtube-automate-your-job-search-using-ai-indeed-linkedin-ziprecruiter-491982)
  - Advertises multi-platform scraping and automated submission.
  - Treat the claims as a demo, not as a universal or compliant implementation.
- [How to Scrape LinkedIn Without Paid APIs Using n8n](https://www.classcentral.com/course/youtube-how-to-scrape-linkedin-without-paid-apis-using-n8n-490283)
  - Uses Google Search results to discover LinkedIn profiles and write them to Sheets.
  - This is search-result collection, not official LinkedIn API access, and it is not an authorization loophole.

### n8n templates

- [AI resume tailoring with GPT-4o, LinkedIn, and Gmail](https://n8n.io/workflows/11215-automate-job-applications-with-ai-resume-tailoring-using-gpt-4o-linkedin-and-gmail/)
  - Uses Apify for job collection, an LLM for filtering and rewriting, Google Docs for documents, and Gmail drafts for outreach.
  - Good model for draft-first output; do not copy its scraping assumptions blindly.
- [Job application forms with human editing](https://n8n.io/workflows/2579-handling-job-application-submissions-with-ai-and-n8n-forms/)
  - Extracts application data from a CV, pre-fills a form, and lets the applicant edit it.
  - This human-editable pattern is preferred for application preparation.

### Official platform references

- [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) — prohibits unauthorized scraping, bots, automated contact handling, and automated messaging.
- [LinkedIn Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api) — restricted approved access; first-degree connections only.
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) — restricted member-social permissions for member posts.
- [LinkedIn Communication APIs](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/overview) — messaging capabilities exist but access is restricted.
- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) — public job reads; application submission requires an employer Job Board API key.

---

## 6. Apify: role, cost, and scope

Apify did not come from this repository. It appeared in the n8n video/template because those creators used Apify as a hosted scraping/browser-automation provider.

Apify concepts:

- **Actor:** a reusable scraper, browser automation job, data extractor, or custom program.
- **Store Actor:** a third-party or public Actor that can be run through Apify.
- **Dataset/key-value store:** output storage for a run.
- **API:** n8n can start an Actor run, poll its status, and fetch results.

Apify can be used for many public websites, but it is not a universal scraper. Each target can require different selectors, login handling, browser behavior, rate limits, and terms review.

Current official pricing facts:

- Free plan: $0/month.
- $5/month in platform usage credits.
- No credit card required.
- Usage covers compute and related platform services.
- Free usage is blocked after the allowance is exhausted until the next cycle.
- Some Store Actors, residential proxies, high-volume data transfer, and other services may have additional costs.
- Apify also advertises a temporary $500 allowance for building custom Actors/agents; this is promotional and not a permanent entitlement.

Strict no-additional-paid-service policy:

- Apify is optional, not required.
- Use the free allowance only if it materially improves coverage.
- Do not enable paid overage.
- Do not rotate accounts/tokens/proxies to bypass limits.
- Keep an Apify-free fallback available from the first implementation.

Apify can also be developed locally using its CLI/SDK, but that does not make third-party site collection automatically permitted. For public ATS/company pages, local Playwright/Crawlee code may be simpler and cheaper.

---

## 7. Provider-fallback design

### Provider order

1. Existing public ATS APIs: Greenhouse, Ashby, Lever, when a supported direct job URL is available.
2. Apify Actor for discovery from a permitted target where it materially improves coverage.
3. Local Dockerized HTTP fetcher for permitted, stable public company pages.
4. Manual review queue.

Apify is a discovery service, not the source of truth for a known ATS posting.
Every discovered Greenhouse, Ashby, or Lever URL should be verified again through
the direct provider API before it can be evaluated. If Apify reaches its free-tier
or configured spending limit, disable Apify for the period; keep direct ATS
verification running and route unsupported sources to manual review. Do not switch
automatically to browser automation to bypass a provider restriction.

Do not use a fallback to defeat a site block. If an Apify LinkedIn Actor fails because LinkedIn blocks or restricts it, do not automatically switch to browser automation or another scraper to bypass that control. For LinkedIn use approved API access or user-provided/exported data.

### Circuit-breaker state

Store provider state in n8n's database or a small Postgres table, not in a prompt:

```json
{
  "provider": "apify",
  "enabled": true,
  "disabled_until": null,
  "last_error_type": null,
  "last_error_message": null,
  "last_success_at": null,
  "estimated_monthly_usage_usd": 0,
  "consecutive_failures": 0
}
```

### Error policy

- Successful run: reset transient failure count and store run ID/output URL.
- HTTP `429` or equivalent rate-limit response: retry with backoff; do not disable for the whole billing cycle.
- Confirmed quota/payment exhaustion: disable Apify until the next known reset period and use fallback.
- HTTP `401`: credentials/token problem; alert and stop Apify attempts until fixed.
- HTTP `403`: inspect the error type. Do not treat every `403` as quota exhaustion; it may indicate Actor permission approval or access denial.
- Actor `FAILED`/`TIMED-OUT`: retry once with a bounded timeout, then fallback.
- Unknown error: record it, alert, and fallback without deleting credentials.

“Dump Apify” means stop invoking it for the current period—not delete the Actor, token, or configuration.

### Reactivation

At each scheduled run:

1. If `disabled_until` is in the future, skip Apify.
2. If the reset time has passed, run one small health/test job.
3. Re-enable only after a successful test.
4. If it fails again, extend the cooldown and retain the fallback.

---

## 8. Job workflow design

### Trigger

- Cron schedule (for example, once or twice daily), or
- Notion polling for rows with `Status = Pipeline` and `Processed = false`.

### Nodes/stages

1. **Notion read**
   - Fetch pending job rows.
   - Require a direct application link.
   - Skip rows already processed, applied, rejected, or duplicated.

2. **URL normalization and deduplication**
   - Canonicalize URL.
   - Deduplicate by company + role and by normalized URL.

3. **Provider selector**
   - Use Apify only for configured target sources.
   - Otherwise use direct HTTP/ATS/API path.

4. **Posting extraction**
   - Extract title, company, location, employment type, salary, requirements, years of experience, application URL, and full description.
   - Preserve source URL and retrieval timestamp.

5. **Liveness and eligibility gate**
   - Confirm the posting is active.
   - Require India/global-remote/EU/Gulf feasibility.
   - Skip US-only restricted roles.
   - Drop roles requiring 3+ years unless the profile rules explicitly allow an exception.
   - Drop Java/Kotlin/Go/Rust/Ruby/C/C++, mobile-only, frontend-only, data-science, GPU/ML-infrastructure, and unavailable agent-orchestration requirements.

6. **LLM evaluation**
   - Input: normalized JD, `cv.md`, `config/profile.yml`, `modes/_profile.md`, and evidence constraints.
   - Output strict JSON:

```json
{
  "fit_score": "T1 · 8/10",
  "recommendation": "apply|maybe|skip",
  "stack_match": [],
  "hard_gaps": [],
  "location_status": "confirmed|unconfirmed|ineligible",
  "experience_status": "junior|unclear|too_senior",
  "evidence": [],
  "questions_for_candidate": [],
  "reason": ""
}
```

   - The LLM must not invent experience, employment dates, metrics, salary, authorization, or project details.

7. **Resume generation**
   - Generate an HTML/Markdown tailored CV from verified CV facts.
   - Run the existing PDF generator in the career-ops container.
   - Store output under `output/` with company/role/date naming.
   - Keep the master CV unchanged.

8. **Application packet**
   - Produce tailored resume PDF.
   - Produce concise truthful answers for common fields.
   - Produce optional cover letter or short note.
   - Mark all generated content as `needs_review`.

9. **Notion write**
   - Update score, fit summary, location, requirements, report URL, resume URL/path, verification timestamp, and processing status.
   - Never replace a live direct application link with a homepage.
   - Preserve `Date Added`.

10. **Human approval**
   - Send a notification with the direct link and generated files.
   - Require explicit approval before any external send/submit step.

### Suggested job statuses

```text
Pipeline
Fetched
Verified
Evaluated
Packet Ready
Needs Review
Applied
Interview
Rejected
Skipped
Expired
Error
```

---

## 9. Founder research/outreach workflow

### Permitted inputs

Preferred sources, in order:

1. User-uploaded CSV/export of recent connections.
2. A manually maintained Notion “Connections” database.
3. Approved LinkedIn API data if the application has the required permissions.
4. Public company website URLs supplied by the user.

Do not use browser cookies, session copying, or an unapproved LinkedIn scraper as an automatic data source.

### Connection record

```json
{
  "name": "",
  "profile_url": "",
  "company": "",
  "title": "",
  "connected_at": "user-provided or unknown",
  "source": "csv|manual|approved_api",
  "status": "new|researched|draft_ready|approved|sent|replied|closed"
}
```

### Research stages

1. Confirm the person/company identity from supplied data.
2. Fetch public company pages: homepage, product, docs, pricing, changelog, careers, blog, and public announcements.
3. Collect source URLs and retrieval dates.
4. Summarize what the company actually builds.
5. Identify public signals of friction: hiring needs, product gaps, operational pain, integration requests, reliability concerns, or explicitly stated roadmap problems.
6. Separate facts from hypotheses.
7. Map only real candidate capabilities to possible solutions:
   - Node.js/Express APIs
   - Python/FastAPI/Django work in progress
   - Docker/Nginx/Linux production ownership
   - integrations, WhatsApp/Twilio, real-time systems, debugging, and AI-native delivery
8. Draft a short conversation opener, not a hard sell.

### Draft output

```json
{
  "person": "",
  "company": "",
  "verified_facts": [],
  "public_problem_signals": [],
  "hypotheses": [],
  "candidate_relevance": [],
  "message_draft": "",
  "claims_requiring_review": [],
  "source_urls": [],
  "status": "needs_review"
}
```

The message must not claim that the founder has a problem unless they publicly stated it. Use language such as “I noticed…” and “I wondered whether…” rather than pretending to know their internal roadmap.

---

## 10. Credentials and services

Required:

- Self-hosted n8n instance.
- Notion integration token and database access.
- LLM API key.
- Public HTTPS egress from the n8n/worker containers.
- Persistent storage for n8n, reports, PDFs, and state.

Optional:

- `APIFY_API_TOKEN` and Actor IDs.
- Approved LinkedIn OAuth integration, only if LinkedIn grants the required access.
- SMTP/Gmail credential for notifications or drafts.
- Approved ATS/employer API credentials, only where legitimately provided.

Secret rules:

- Store secrets in n8n credentials or a secrets manager, not Code nodes or prompts.
- Keep `.env` outside version control.
- Do not put browser cookies, LinkedIn session data, or Notion tokens in Docker images.
- Use least-privilege tokens and separate test/production credentials.
- Rotate any token that appears in logs or exported workflow JSON.

---

## 11. Self-hosted Docker topology

Recommended services:

```text
n8n
  ├─ persistent database/storage
  ├─ career-ops worker container
  │    ├─ Node.js
  │    ├─ Playwright Chromium
  │    └─ career-ops repository mounted read/write for data/output/reports
  ├─ optional local review dashboard or n8n Form
  └─ optional reverse proxy with HTTPS
```

The career-ops worker should expose a narrow command or internal HTTP interface for:

- `scan`
- `verify URL`
- `evaluate JD`
- `generate PDF`
- `write report`

It should not expose arbitrary shell execution to public webhooks.

No browser session should be shared from a personal host into an unattended server. Public-page verification and user-operated browser review are separate modes.

### Optional approval channels (Telegram is only one option)

**Default for the first implementation:** use a local review dashboard or an authenticated n8n Form. No Telegram account, bot token, or messaging integration is required for the core workflow.

Telegram can be the notification and control surface; it does not run the job scraper, browser, or LLM. The n8n Telegram node provides both send operations and a Telegram trigger. Telegram supports either webhooks or long-polling; for a normal self-hosted deployment, expose only n8n's webhook endpoint through HTTPS and keep the worker/database private.

Other valid approval channels are:

- **Local review dashboard (best default):** n8n creates a pending item and you open a password-protected page on your own server. This is the most flexible option for showing the full resume, source evidence, and application form.
- **n8n Form/Webhook:** a minimal approve/reject/edit form. It is easy to build, but must be protected with authentication or a one-time signed link.
- **Email:** n8n can send a review email with approve/disapprove actions; this is convenient but email links must expire and be single-use.
- **Telegram/Signal/Matrix/Discord/Slack:** notification and button-based approval adapters. Telegram and Slack/Discord are easiest to integrate; Matrix is a stronger self-hosting/privacy option, while Signal is less convenient for bot-style workflows.
- **Notion status changes:** set a row to `Approved`, `Rejected`, or `Needs edits`. This requires no extra messaging service, but approval is slower and less expressive.
- **CLI/local desktop prompt:** useful during development and safest for testing, but not convenient when the workflow runs unattended.

The approval engine should be channel-independent. Each channel calls the same `approve(item_id, version, actor)` operation, so changing from Telegram to a dashboard does not change the application workflow.

Approval message example:

```text
Packet ready: Backend/Product Engineer — Example Co
Fit: T2 · 8/10 | India eligibility: confirmed
Resume: [open protected review page]

[Review] [Approve application] [Reject] [Regenerate]
```

The buttons must carry an opaque, short-lived approval ID—not the resume, API key, or a command. On callback, n8n verifies the Telegram `user_id`/`chat_id` allowlist, looks up the approval ID in Postgres, checks expiry and current status, consumes it once, and only then starts the next workflow step. The external submit/send action should have a second confirmation after the review page is opened.

Recommended commands:

```text
/status       running jobs, errors, pending approvals
/queue        pending applications and founder drafts
/approve ID   approve a specific pending item
/reject ID    reject and archive it
/pause        stop all external actions
/resume       re-enable the approval queue
```

Telegram is convenient but is an external chat service. Do not send full identity documents or browser cookies into chat; send a summary and a protected review link, and keep PDFs/artifacts in the local volume or authenticated dashboard. If stronger privacy is required, use the same n8n approval workflow with a local web UI, Matrix, or an email-with-link channel instead.

---

## 12. Data contracts

### Job item

Required fields:

- stable ID
- company
- role
- source URL
- direct application URL
- source/provider
- retrieved timestamp
- location
- experience requirement
- stack
- full JD or normalized text
- liveness result
- India eligibility result
- fit score
- recommendation
- report path
- resume path
- application status
- last error

### Founder item

Required fields:

- stable ID
- name
- profile URL if user-provided/approved
- company
- title
- input source
- website URL
- verified facts
- source URLs
- public problem signals
- hypotheses
- draft message
- approval status
- sent/replied timestamps

### Provenance rule

Every factual claim shown to the user should retain a source URL and retrieval date. The LLM output must distinguish:

- `fact`
- `inference`
- `unknown`

---

## 13. Safety and quality gates

### Job gate

Do not generate an “apply” recommendation when:

- the role is expired or unverifiable;
- the direct application URL is missing;
- the location is ineligible or unconfirmed for a hard constraint;
- the JD requires 3+ years without a compelling exception;
- the central stack is outside the candidate’s current scope;
- the role is a prestige/DSA-grill/unicorn target that conflicts with the profile;
- the LLM cannot cite evidence for the match.

### Resume gate

Before output is marked ready:

- compare every bullet against `cv.md`;
- reject invented metrics;
- reject inflated titles;
- reject unearned technologies;
- keep the candidate’s junior level truthful;
- run PDF rendering and text extraction checks.

### Outreach gate

Before a message is marked ready:

- cite at least one public source;
- do not claim confidential knowledge;
- do not mass-send;
- do not use manipulative urgency;
- require explicit human review;
- record the exact final text and destination.

### Provider gate

- Stop on quota exhaustion and use fallback.
- Do not bypass platform limits.
- Respect robots, site terms, rate limits, and access controls.
- Keep a manual queue for blocked or ambiguous sources.

---

## 14. Implementation phases

### Phase 0 — Infrastructure

- **Implemented:** self-hosted n8n/Postgres/worker Compose topology, persistent
  local volumes, worker health endpoint, Compose health check, and localhost-only
  service ports.
- **Remaining:** configure real secrets/backups and perform the live Docker smoke
  test. The referenced `career-ops` commands belong to the separate project and
  are not run by this repository.

### Phase 1 — Notion job ingestion

- **Implemented locally:** URL normalization/deduplication and provider selection;
  direct Greenhouse, Lever, and Ashby verification; a local pipeline endpoint;
  durable local job state.
- **Remaining:** Notion read/write property mapping, an optional Apify Actor behind
  a feature flag, and provider-state/circuit-breaker persistence for Apify.

### Phase 2 — Extraction and evaluation

- **Implemented locally:** normalized job text, liveness, location, seniority, and
  stack gates; deterministic evidence-backed scores.
- **Remaining:** optional strict-JSON LLM evaluator and Notion updates.

### Phase 3 — Documents

- **Implemented locally:** Markdown review packets stored in the artifact volume.
- **Remaining:** call the canonical CV/PDF generator and add an optional review
  notification adapter.

### Phase 4 — Human approval

- **Implemented:** local review dashboard with approve/reject/regenerate and an
  expiring opaque approval ID. No decision can submit an application.
- **Remaining:** n8n Wait/Form and optional notification adapters.

### Phase 5 — Founder research

- Start with a manually maintained Connections database or CSV import.
- Fetch only public company sources.
- Generate evidence-backed research and draft messages.
- Add human approval before sending email or LinkedIn messages.

### Phase 6 — Apify optimization

- Measure Apify success rate, cost per item, and failure causes.
- Keep Apify only for targets where it materially improves coverage.
- Prefer local/public APIs for stable sources.
- Set conservative per-run limits.

---

## 15. Acceptance criteria

The first usable version is complete when:

- A Notion job row can enter the workflow.
- The workflow verifies the URL or marks it for manual review.
- The candidate fit result is structured JSON with evidence.
- A truthful tailored PDF is generated.
- Notion is updated without duplicate company/role rows.
- Apify failure triggers a documented fallback.
- Confirmed quota exhaustion disables Apify until reset.
- A human receives a review notification before any application action.
- No LinkedIn scraping or messaging runs without an approved data source and explicit review.
- Every generated claim has provenance or is labeled as an inference.
- The workflow can be tested end-to-end with mock data without contacting an employer.

---

## 16. Open decisions before implementation

1. Which LLM provider and model will be used?
2. Which Notion database properties will store processing state, evidence, report, and artifact links?
3. Which Apify Actor(s), if any, are allowed for the first test?
4. What is the monthly Apify budget ceiling? Recommended initial ceiling: the free-plan allowance only.
5. Which public sources are permitted for job discovery?
6. Will founder inputs come from CSV, a Notion Connections database, or approved LinkedIn API access?
7. Where will generated PDFs be stored privately?
8. Which approval adapter should be enabled first? Recommended: local dashboard or authenticated n8n Form; optional email, Telegram, Matrix, or Notion status changes.
9. What is the manual review SLA/cadence?
10. Which actions are explicitly forbidden in production (auto-submit, auto-send, LinkedIn scraping, proxy use, etc.)?

---

## 17. Recommended first implementation

Start with one narrow, safe slice:

```text
Notion job row
→ direct public ATS/company URL
→ local/ATS extraction
→ LLM fit score
→ tailored PDF
→ Notion update
→ review notification
```

Add Apify as an optional provider only after the local path works. Then add the circuit breaker and measure whether Apify actually improves coverage. Add founder research only after the job pipeline has reliable provenance, state management, and human approval.
