import { firecrawlSearch, firecrawlScrape } from './firecrawl-client.mjs';
import { selectProvider } from './provider-selector.mjs';

const API_URL = 'https://api.openai.com/v1/chat/completions';
// Mid-tier model, not the cheapest -- outreach drafting is a creative-writing task where a
// stronger model measurably reduces filler/generic phrasing and placeholder artifacts (verified
// live: the cheaper tier left a literal "[specific area related to tech]" in a real draft).
const DEFAULT_MODEL = 'gpt-5.6-terra';
const requestTimeoutMs = 30_000;
// LinkedIn caps a connection-note-style message at 300 characters; 285 leaves headroom so a
// draft never lands right at the platform's hard wall.
const MAX_MESSAGE_CHARS = 285;
// Backstop for the "never leave a placeholder" prompt rule -- catches it in code rather than
// trusting the model to always follow a negative instruction (same principle as fit-evaluator
// .mjs nulling out a hallucinated bucket_id instead of trusting it blindly).
const PLACEHOLDER_PATTERN = /\[[^\]]+\]/;

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

const buildMessages = ({ founder, companyContext, matchedJob, resumeBucket }) => {
  const roleContext = matchedJob
    ? `They have a real open role, already verified live: "${matchedJob.title || 'Untitled role'}" (${matchedJob.source_url}). Draft the message around this specific role.`
    : 'No specific open role was found at this company. Draft a short, generic value-add "let\'s connect" message -- not a job application.';
  const resumeContext = resumeBucket
    ? `Candidate's relevant background for this role: ${resumeBucket.target_role} -- ${resumeBucket.positioning_angle}.${resumeBucket.reference_text ? ` Reference resume excerpt (structure/tone/experience only): ${resumeBucket.reference_text.slice(0, 1_200)}` : ''}`
    : 'No specific resume bucket matched this opportunity.';
  return [
    {
      role: 'system',
      content: `You draft a short, specific, professional cold-outreach message from a job-seeking candidate to a founder they are already connected with on LinkedIn.

Hard rules:
- The message MUST be under ${MAX_MESSAGE_CHARS} characters total, including spaces -- this is a hard platform limit, not a suggestion. Write tight from the start; do not pad it and expect truncation to fix it.
- Never use generic filler openers like "I hope this message finds you well" or "I've been following your journey".
- Never invent a fact not given in the prompt, and never leave a bracketed placeholder like "[your area of expertise]" -- if there is no specific real detail to use, omit that clause instead of guessing.
- Lead with one specific, concrete reason for reaching out (the open role if given, or a real detail from the company context) -- not a compliment.
- End with a single, low-friction, specific ask -- not just "let's connect".

Good example (specific, tight, no filler), 178 characters:
"Hi Raj, saw Nimbus is hiring a Senior Backend Engineer. I've spent 4 years building production Node/Python APIs at scale -- open to a 15-min chat about the role this week?"

Bad example, do NOT write like this -- generic opener, vague compliment, placeholder, weak ask:
"Hi Raj, I hope this message finds you well! I've been following Nimbus's journey and am really impressed by your innovative approach. I have experience in [relevant area] and would love to explore potential synergies. Looking forward to connecting!"

Respond with JSON only: {"message": string, "reason": string}.`
    },
    {
      role: 'user',
      content: `Founder: ${founder.first_name} ${founder.last_name}, ${founder.position || 'unknown title'} at ${founder.company || 'an unknown company'}.\nCompany website content (may be partial): ${companyContext || 'unavailable'}.\n${roleContext}\n${resumeContext}`
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

export const draftOutreachMessage = async ({ founder, companyContext, matchedJob, resumeBucket } = {}, { apiKey, fetchImpl = fetch, model = DEFAULT_MODEL } = {}) => {
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
        messages: buildMessages({ founder, companyContext, matchedJob, resumeBucket }),
        response_format: { type: 'json_object' }
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
  constructor({ founderStore, reviewStore, pipeline, lookupCompany, findCareers = findCareersUrl, draftMessage = draftOutreachMessage, resumeClassifier = null, resumeBuckets = [], firecrawlApiKey, openaiApiKey, cap = 20, fetchImpl }) {
    Object.assign(this, { founderStore, reviewStore, pipeline, lookupCompany, findCareers, draftMessage, resumeClassifier, resumeBuckets, firecrawlApiKey, openaiApiKey, cap, fetchImpl });
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
    const drafted = await this.draftMessage({ founder, companyContext, matchedJob, resumeBucket }, { apiKey: this.openaiApiKey, fetchImpl: this.fetchImpl });

    const title = `${founder.first_name} ${founder.last_name} — ${founder.company || 'Unknown company'}`.trim();
    const summary = matchedJob
      ? `Open role found: ${matchedJob.title || 'Untitled role'} at ${founder.company}. This draft requires human review before anything is sent.`
      : `No open role found at ${founder.company || 'this company'}. Generic value-add outreach drafted. This draft requires human review before anything is sent.${drafted.message ? '' : ` (${drafted.reason})`}`;
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
