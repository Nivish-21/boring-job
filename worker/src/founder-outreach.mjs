import { firecrawlSearch, firecrawlScrape } from './firecrawl-client.mjs';
import { fetchFounderPosts } from './apify-client.mjs';
import { selectProvider } from './provider-selector.mjs';

const API_URL = 'https://api.openai.com/v1/chat/completions';
// Mid-tier model, not the cheapest -- outreach drafting is a creative-writing task where a
// stronger model measurably reduces filler/generic phrasing and placeholder artifacts (verified
// live: the cheaper tier left a literal "[specific area related to tech]" in a real draft).
const DEFAULT_MODEL = 'gpt-5.6-terra';
const requestTimeoutMs = 30_000;
// Every founder this feature processes is already a 1st-degree LinkedIn connection (the feature
// only exists because it reads the user's own connections export), so the actual message sent is
// a regular direct message, not a connection-request note -- those are different LinkedIn
// products with different limits (300 chars for a connection-request note vs ~8,000 for a regular
// DM to an existing connection, verified live against multiple independent sources). This is a
// safety backstop against a runaway response, not a style target -- the prompt does not aim for
// this length.
const MAX_MESSAGE_CHARS = 8_000;
// Backstop for the "never leave a placeholder" prompt rule -- catches it in code rather than
// trusting the model to always follow a negative instruction (same principle as fit-evaluator
// .mjs nulling out a hallucinated bucket_id instead of trusting it blindly).
const PLACEHOLDER_PATTERN = /\[[^\]]+\]/;
// Same principle, different failure mode: live drafts kept reproducing the prompt's own labelled
// bad-example phrasing almost verbatim (generic compliment openers) despite an explicit prompt
// rule against it -- prompt-only instructions aren't reliable here either.
const GENERIC_OPENER_PATTERN = /impressed by|innovative approach|following your journey|reaching out because|hope this message finds you well/i;
// Same principle, closing-line version: live drafts converged on this exact phrase (or the
// near-identical "jump on a call") because the prompt itself used to hand it out as the
// illustration of a good ask -- fixed in the prompt below, but caught in code too since a
// prompt-only fix isn't reliably followed (same lesson as the two guards above).
// Extended after a live 5-draft/5-critic test: independently of the phrases above, drafts
// converged on "swap notes"/"compare notes"/"hear how you're thinking about" as a one-way
// extraction closer with nothing offered back -- same crutch-phrase failure mode as the original
// two patterns, so it gets the same code-level ban rather than trusting the new reciprocity
// prompt rule below to be followed on its own.
const GENERIC_CLOSER_PATTERN = /happy to (hop|jump) on a call|whenever works for you|swap notes|compare notes|hear how you('re| are) thinking about|pick your brain/i;
// Same principle again: an em dash is one of the clearest AI-writing tells and the user's real
// voice (see USER_VOICE_SAMPLE) never uses one -- caught in code since a prompt rule alone isn't
// reliably followed (same lesson as the two guards above).
const EM_DASH_PATTERN = /—/;
// A real sample of how the candidate actually writes, given by the user directly (not invented) --
// used in the prompt as a tone/cadence reference only, never copied verbatim unless a founder's
// situation genuinely matches it.
const USER_VOICE_SAMPLE = "Hey there, I just saw this new company and I've been doing something similar. I also run a ride-hailing platform. We found a couple of bloggers here and this is how I solved it and I think I could do the same for you guys too. Would be happy to join a call whenever you're free.";

const isAtsBoardUrl = (url) => {
  try { return selectProvider(url).provider !== 'manual'; } catch { return false; }
};

const hostnameOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

// Biased toward Greenhouse/Lever/Ashby (same targeting as job-discovery.mjs's default query) --
// those verify for free and are guaranteed a single posting, not a hub page. Also tries a
// site-scoped search against the company's own domain (if known) to catch a careers page hosted
// directly on their site. Each search is independently caught (matches company-lookup.mjs) so a
// Firecrawl failure degrades to an empty list rather than throwing.
export const findCareersUrl = async (companyName, websiteUrl, { apiKey, limit = 5, fetchImpl } = {}) => {
  if (!companyName) return [];
  const hostname = hostnameOf(websiteUrl);
  const queries = [
    `${companyName} careers (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)`,
    hostname ? `${companyName} careers site:${hostname}` : null
  ].filter(Boolean);

  const batches = await Promise.all(queries.map((query) => firecrawlSearch(query, { apiKey, limit, fetchImpl }).catch(() => [])));
  const urls = [...new Set(batches.flat().map((result) => result.url))];
  return urls.sort((left, right) => Number(isAtsBoardUrl(right)) - Number(isAtsBoardUrl(left)));
};

// A monitoring/context nicety, not a pipeline-blocking dependency -- degrades to null on any
// failure (missing key, scrape rejection) rather than throwing, same as company-lookup.mjs.
const scrapeCompanyContext = async (websiteUrl, { apiKey, fetchImpl } = {}) => {
  if (!websiteUrl) return null;
  try {
    const scrape = await firecrawlScrape(websiteUrl, { apiKey, fetchImpl });
    return scrape.markdown ? scrape.markdown.replace(/\s+/g, ' ').trim().slice(0, 2_000) : null;
  } catch {
    return null;
  }
};

// The actor returns a founder's full post history regardless of age (verified live: a real
// profile's maxPosts:0 call returned 22 posts spanning 2015-2021) -- most founders will have
// nothing within this window, and that's a real signal (they don't post) rather than a fetch
// failure, so it degrades to null exactly like an empty result.
const FOUNDER_POST_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const FOUNDER_POST_CONTENT_CHAR_CAP = 400;
const MAX_FOUNDER_POSTS_IN_PROMPT = 3;

// Human-readable note appended to the review item's summary for each outcome -- a QA subagent
// flagged live that "fetch ran and found nothing" vs. "fetch failed silently" vs. "never
// configured" were all indistinguishable to a human reviewer since every path just showed up as
// no context in the draft. Never throws or blocks the pipeline; purely observational.
const FOUNDER_POSTS_STATUS_NOTES = {
  used: 'LinkedIn posts: found recent activity, used as context.',
  not_configured: 'LinkedIn posts: not checked (Apify not configured).',
  none_found: 'LinkedIn posts: none found for this profile.',
  all_stale: 'LinkedIn posts: found posts, but none within the last 12 months.',
  fetch_failed: 'LinkedIn posts: fetch failed, skipped.'
};

// Same nicety/degrade contract as scrapeCompanyContext -- an Apify error, empty result, or a
// founder with nothing posted in the last year all collapse to a null context, never throw. The
// `status` alongside it exists purely for the observability note above -- draftMessage only ever
// sees `context`.
const scrapeFounderPosts = async (profileUrl, { apiToken, fetchImpl } = {}) => {
  if (!apiToken) return { context: null, status: 'not_configured' };
  try {
    const posts = await fetchFounderPosts(profileUrl, { apiToken, fetchImpl });
    if (!posts.length) return { context: null, status: 'none_found' };
    const cutoff = Date.now() - FOUNDER_POST_MAX_AGE_MS;
    const recent = posts.filter((post) => post.postedAt && new Date(post.postedAt).getTime() >= cutoff);
    if (!recent.length) return { context: null, status: 'all_stale' };
    const context = recent
      .slice(0, MAX_FOUNDER_POSTS_IN_PROMPT)
      .map((post) => post.content.replace(/\s+/g, ' ').trim().slice(0, FOUNDER_POST_CONTENT_CHAR_CAP))
      .join('\n---\n');
    return { context, status: 'used' };
  } catch {
    return { context: null, status: 'fetch_failed' };
  }
};

const buildMessages = ({ founder, companyContext, matchedJob, resumeBucket, founderPostsContext }) => {
  const roleContext = matchedJob
    ? `They have a real open role, already verified live: "${matchedJob.title || 'Untitled role'}" (${matchedJob.source_url}). Draft the message around this specific role.`
    : 'No specific open role was found at this company. Draft a short, generic value-add "let\'s connect" message -- not a job application.';
  const resumeContext = resumeBucket
    ? `Candidate's relevant background for this role: ${resumeBucket.target_role} -- ${resumeBucket.positioning_angle}.${resumeBucket.reference_text ? ` Reference resume excerpt (structure/tone/experience only): ${resumeBucket.reference_text.slice(0, 1_200)}` : ''}`
    : 'No specific resume bucket matched this opportunity.';
  const founderPostsPrompt = founderPostsContext
    ? `The founder's own recent (last 12 months) public LinkedIn posts, given only as a signal of what they're currently thinking about and how they talk -- never assert anything from this as a fact about the company, never quote it directly unless reusing their own words as an explicit callback would genuinely land, and never mention that you "saw their posts" or "have been following" them (that reads as surveillance, not genuine): ${founderPostsContext}`
    : 'No recent public LinkedIn posts were found for this founder -- most founders don\'t post regularly, so absence of this is normal and not a gap to apologize for.';
  return [
    {
      role: 'system',
      content: `You draft a warm, casual, genuinely human-sounding direct message from a job-seeking candidate to a founder who is already a 1st-degree LinkedIn connection of theirs -- this is a regular direct message, NOT a connection-request note, so there is no tight platform character wall to write around.

Voice reference -- a real example of how the candidate actually writes. Match its tone and sentence rhythm, but NEVER copy its specific content unless it happens to be genuinely true for the founder being messaged: "${USER_VOICE_SAMPLE}"

Match that voice specifically: a casual opener (not "Hi [Name], I hope..."), run-on sentences chained together with "and" rather than clipped, over-polished corporate sentences, a real personal angle leading the message when one genuinely exists, and a low-key, easygoing ask at the end -- not "would you be open to a 15-minute conversation next week". The ask must be specific to something you just said in this message, not a generic offer to talk: tie it to the role, the detail you raised, or the angle you led with, so it reads as an ask only this founder could receive.

Write with genuine confidence, not deference -- this is a peer starting a conversation, not someone asking permission to exist. Skip hedges like "I just wanted to", "I hope it's okay to reach out", or "sorry to bother you". State the specific reason for reaching out plainly, like it's obviously worth the founder's time. Confidence must come from the specific, concrete detail already in the message (the role, the metric, the real angle) -- never from generic bravado, hype language, or telling the founder how great/bold/exciting this is, since that reads as gimmicky rather than earned.

The closing ask must be a two-way trade, not a one-way extraction. A live test of this prompt showed drafts converging on "would love to hear how you're thinking about X, let's swap notes" -- that pattern asks the founder to hand over their thinking while offering nothing back, which reads as fishing for insight, not a peer proposing an exchange. Instead, the ask must offer something concrete first (a specific idea, an observation, something the candidate has actually seen or built that's relevant) before or alongside asking for the founder's time -- so the message reads as "here's something real from me, and here's what I'd want from you," not just "tell me about your business."

Hard rules:
- Never use an em dash anywhere in the message -- it's one of the clearest tells of AI-written text and the candidate never writes that way.
- Do not open with "I noticed you're building/leading [Company] as [Title] and wanted to introduce myself" or any close variant of it -- vary the opening structure between messages the way a real person naturally would, never a repeated template.
- There is no fixed length target. Write however long it needs to be to be specific and genuine -- usually a short paragraph or two. Never pad with filler just to fill space, and never cut a real, specific point short just to sound punchy.
- Never use these banned phrases or close variants of them: "I hope this message finds you well", "I've been following your journey", "impressed by", "innovative approach", "reaching out because", "happy to hop on a call", "happy to jump on a call", "whenever works for you", "swap notes", "compare notes", "pick your brain", "hear how you're thinking about".
- Never invent a fact not given in the prompt, and never leave a bracketed placeholder like "[your area of expertise]" -- if there is no specific real detail to use, omit that clause instead of guessing. The offer in the closing ask must come from the candidate's real background/resume context given below, never a fabricated idea.
- Lead with one specific, concrete reason for reaching out (the open role if given, or a real detail from the company context) -- not a compliment.
- End with a single, low-friction, casual ask that includes a real offer, per the reciprocity rule above -- not just "let's connect" or a bare request to learn the founder's thinking.

Good example (matches the voice reference's casual, run-on style, specific, no filler, and the ask is a two-way trade, not extraction):
"Hey Raj, saw Nimbus is hiring a Senior Backend Engineer and that's basically what I've been doing for the last 4 years, building production Node/Python APIs at scale and most recently leading a rewrite of a payments service that cut p99 latency by about 40%. I've got a few specific ideas on where that kind of latency usually hides once you scale past this hire, happy to walk through what worked for us, got 15 minutes this week to trade notes?"

Bad example #1, do NOT write like this -- formulaic template opener, stiff corporate cadence, weak ask:
"Hi Raj, I noticed you're leading Nimbus as CEO and wanted to introduce myself. I'd be interested in hearing how you're thinking about the company's priorities. Would you be open to a 15-minute conversation next week?"

Bad example #2, do NOT write like this either -- specific and confident opener, but the ask is a one-way extraction with nothing offered back:
"Hey Raj, saw Nimbus is hiring a Senior Backend Engineer and that's really interesting given where you're headed. Would love to hear how you're thinking about scaling the backend team past this hire, would be good to swap notes on it sometime."

Respond with JSON only: {"message": string, "reason": string}.`
    },
    {
      role: 'user',
      content: `Founder: ${founder.first_name} ${founder.last_name}, ${founder.position || 'unknown title'} at ${founder.company || 'an unknown company'}.\nCompany website content (may be partial): ${companyContext || 'unavailable'}.\n${roleContext}\n${resumeContext}\n${founderPostsPrompt}`
    }
  ];
};

// Backstop for MAX_MESSAGE_CHARS -- the prompt asks the model to stay under the limit, but LLMs
// don't reliably hit an exact character target, so this is enforced in code regardless of what
// the model returns. Cuts at the last full word boundary rather than mid-word.
const truncateToWordBoundary = (text, maxChars) => {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
};

export const draftOutreachMessage = async ({ founder, companyContext, matchedJob, resumeBucket, founderPostsContext } = {}, { apiKey, fetchImpl = fetch, model = DEFAULT_MODEL } = {}) => {
  if (!apiKey) return { message: null, reason: 'OpenAI API key is not configured' };
  if (!founder) return { message: null, reason: 'No founder supplied' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        // gpt-5.6-terra (the default model) rejects any non-default temperature outright
        // (verified live: "Only the default (1) value is supported") -- omit it rather than
        // pin a value that only worked for the older gpt-4o-mini default.
        messages: buildMessages({ founder, companyContext, matchedJob, resumeBucket, founderPostsContext }),
        response_format: { type: 'json_object' },
        // Verified live against the real API (not assumed from the model family name): gpt-5.6-
        // terra accepts reasoning_effort ('none'/'low'/'medium'/'high'/'xhigh'); 'high' spends
        // real reasoning tokens and measurably improves adherence to the tight constraints here
        // (char cap, no filler, no placeholders). Cost is trivial at this feature's volume.
        reasoning_effort: 'high'
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => null);
      return { message: null, reason: errorJson?.error?.message || `OpenAI returned HTTP ${response.status}` };
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    let message = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : null;
    let reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    if (message && PLACEHOLDER_PATTERN.test(message)) {
      return { message: null, reason: 'Model left a bracketed placeholder in the draft -- needs regeneration' };
    }
    if (message && EM_DASH_PATTERN.test(message)) {
      return { message: null, reason: 'Model used an em dash -- needs regeneration' };
    }
    if (message && GENERIC_OPENER_PATTERN.test(message)) {
      return { message: null, reason: 'Model used a banned generic-opener phrase -- needs regeneration' };
    }
    if (message && GENERIC_CLOSER_PATTERN.test(message)) {
      return { message: null, reason: 'Model used a banned generic-closer phrase -- needs regeneration' };
    }
    if (message && message.length > MAX_MESSAGE_CHARS) {
      message = truncateToWordBoundary(message, MAX_MESSAGE_CHARS);
      reason = reason ? `${reason} (truncated to fit the ${MAX_MESSAGE_CHARS}-character limit)` : `Truncated to fit the ${MAX_MESSAGE_CHARS}-character limit`;
    }
    return { message, reason };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'OpenAI request timed out' : (error?.message || 'OpenAI request failed');
    return { message: null, reason };
  } finally {
    clearTimeout(timeout);
  }
};

const isHttpUrl = (value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

export class FounderOutreachRunner {
  constructor({ founderStore, reviewStore, pipeline, lookupCompany, findCareers = findCareersUrl, draftMessage = draftOutreachMessage, resumeClassifier = null, resumeBuckets = [], firecrawlApiKey, openaiApiKey, apifyApiToken, cap = 20, fetchImpl }) {
    Object.assign(this, { founderStore, reviewStore, pipeline, lookupCompany, findCareers, draftMessage, resumeClassifier, resumeBuckets, firecrawlApiKey, openaiApiKey, apifyApiToken, cap, fetchImpl });
  }

  // Processes at most `cap` new founders per call (cost control, mirrors JobPipeline's
  // dailyCap) -- a founder already recorded in founderStore is never re-researched.
  async run(founders) {
    const stageCounts = {};
    let processed = 0;

    for (const founder of founders) {
      if (!isHttpUrl(founder?.profile_url)) { stageCounts.invalid_profile_url = (stageCounts.invalid_profile_url || 0) + 1; continue; }
      if (processed >= this.cap) { stageCounts.cap_reached = (stageCounts.cap_reached || 0) + 1; continue; }
      const already = await this.founderStore.getByProfileUrl(founder.profile_url);
      if (already) { stageCounts.duplicate = (stageCounts.duplicate || 0) + 1; continue; }

      const stage = await this.#processFounder(founder);
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      processed += 1;
    }

    return { processed, stage_counts: stageCounts };
  }

  // Redrafts a single already-processed founder -- for a stuck/bad review item (empty draft from
  // a transient API failure, a placeholder that predates the guard, etc). Bypasses run()'s
  // dedup/cap checks entirely (they exist to protect the daily import, not a targeted single-item
  // retry). Reconstructs a founder-shaped object from the stored founderStore record rather than
  // persisting a second copy of the original CSV row -- lossy only for a multi-word first name,
  // an accepted tradeoff for a low-volume, human-triggered action.
  async regenerateOne(profileUrl) {
    const existing = await this.founderStore.getByProfileUrl(profileUrl);
    if (!existing) throw new Error('founder not found for this profile_url');

    if (existing.review_item_id) {
      const items = await this.reviewStore.list({});
      const oldItem = items.find((item) => item.id === existing.review_item_id);
      if (oldItem && oldItem.status === 'pending') {
        await this.reviewStore.decide(oldItem.id, {
          action: 'reject',
          approval_id: oldItem.approval_id,
          actor: 'system',
          reason: 'Superseded by regenerated draft'
        });
      }
    }

    const [firstName, ...rest] = existing.name.split(' ');
    await this.#processFounder({
      first_name: firstName || '',
      last_name: rest.join(' '),
      company: existing.company,
      position: existing.position,
      profile_url: existing.profile_url
    });

    const updated = await this.founderStore.getByProfileUrl(profileUrl);
    const items = await this.reviewStore.list({});
    return items.find((item) => item.id === updated.review_item_id) || null;
  }

  async #processFounder(founder) {
    const companyLinks = founder.company
      ? await this.lookupCompany(founder.company)
      : { website_url: null, linkedin_url: null };

    const careersUrls = founder.company
      ? await this.findCareers(founder.company, companyLinks.website_url, { apiKey: this.firecrawlApiKey, fetchImpl: this.fetchImpl })
      : [];

    // Reuses the unmodified JobPipeline: any real posting found gets the exact same
    // verification/fit-scoring/resume-matching every other job in this project already gets.
    // Stops at the first needs_review match rather than exhausting every candidate URL, since
    // one confirmed open role is all a founder-outreach draft needs.
    let matchedJob = null;
    for (const url of careersUrls.slice(0, 3)) {
      const result = await this.pipeline.process({ source_url: url });
      if (result.stage === 'needs_review') { matchedJob = result.verification.job; break; }
    }

    const resumeMatch = matchedJob && this.resumeClassifier && this.resumeBuckets.length
      ? await this.resumeClassifier(matchedJob, this.resumeBuckets)
      : null;
    const resumeBucket = resumeMatch?.bucket_id ? this.resumeBuckets.find((bucket) => bucket.id === resumeMatch.bucket_id) : null;

    const companyContext = await scrapeCompanyContext(companyLinks.website_url, { apiKey: this.firecrawlApiKey, fetchImpl: this.fetchImpl });
    const founderPosts = await scrapeFounderPosts(founder.profile_url, { apiToken: this.apifyApiToken, fetchImpl: this.fetchImpl });
    const drafted = await this.draftMessage({ founder, companyContext, matchedJob, resumeBucket, founderPostsContext: founderPosts.context }, { apiKey: this.openaiApiKey, fetchImpl: this.fetchImpl });

    const title = `${founder.first_name} ${founder.last_name} — ${founder.company || 'Unknown company'}`.trim();
    const founderPostsNote = FOUNDER_POSTS_STATUS_NOTES[founderPosts.status];
    const summary = matchedJob
      ? `Open role found: ${matchedJob.title || 'Untitled role'} at ${founder.company}. This draft requires human review before anything is sent. ${founderPostsNote}`
      : `No open role found at ${founder.company || 'this company'}. Generic value-add outreach drafted. This draft requires human review before anything is sent.${drafted.message ? '' : ` (${drafted.reason})`} ${founderPostsNote}`;
    const evidence = [
      companyLinks.website_url ? { label: 'Company website', url: companyLinks.website_url } : null,
      companyLinks.linkedin_url ? { label: 'Company LinkedIn', url: companyLinks.linkedin_url } : null,
      matchedJob ? { label: 'Matched open role', url: matchedJob.source_url } : null
    ].filter(Boolean);

    const review = await this.reviewStore.create({
      kind: 'founder',
      item_id: founder.profile_url,
      title,
      source_url: founder.profile_url,
      summary,
      draft: drafted.message,
      evidence
    });

    // Marked processed regardless of outcome -- mirrors JobPipeline's own "persist every
    // outcome, never re-pay for a dead end" rule.
    await this.founderStore.record({
      profile_url: founder.profile_url,
      name: `${founder.first_name} ${founder.last_name}`.trim(),
      company: founder.company || null,
      position: founder.position || null,
      review_item_id: review.id,
      matched_job_url: matchedJob?.source_url || null,
      draft_error: drafted.message ? null : drafted.reason
    });

    return 'processed';
  }
}
