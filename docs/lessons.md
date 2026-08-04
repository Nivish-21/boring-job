# Lessons

## 2026-08-04 — Printed real .env secret values into the conversation transcript

**Mistake.** While checking which env vars were configured before the first live
founder-outreach run, ran `grep -vE '^\s*(#|$)' .env` in the repo root to see the file
minus blank/comment lines. This prints full line content, not just key names — it exposed
the real values of `OPENAI_API_KEY`, `APIFY_API_TOKEN`, `FIRECRAWL_API_KEY`,
`N8N_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` directly into the chat transcript. Earlier in
the same session, a safer check (`awk` printing only key name + character count) had already
been used correctly for the same purpose — this later command didn't reuse that pattern.

**Root cause:** treated ".env" as safe to grep because the *intent* was informational
("what's set"), without checking whether the *command itself* would only reveal presence,
not values.

**Fix:** told the user immediately, recommended rotating the three live keys
(`FIRECRAWL_API_KEY`, `APIFY_API_TOKEN`, `OPENAI_API_KEY`). The n8n/Postgres credentials are
lower priority since those services were already decommissioned this project (see
`docs/decisions.md`'s "Dropped n8n + Postgres" entry).

**New rule (also logged to `~/.claude/lessons.md` in generalised form):** never run
`cat`/plain `grep`/`head`/`tail` on a `.env` file or any file that may hold secrets. Always
mask: print only the key name and whether it's set (and optionally length), never the value
itself. This holds even if a safer pattern was already used earlier in the same session for
a similar check — each command needs its own masking, not inherited caution.
