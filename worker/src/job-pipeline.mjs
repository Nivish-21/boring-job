import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyJob } from './job-verifier.mjs';
import { selectProvider } from './provider-selector.mjs';

const computeStableId = (selection) => {
  if (selection.provider === 'greenhouse') return `greenhouse:${selection.board_token}:${selection.job_id}`;
  if (selection.provider === 'lever') return `lever:${selection.site}:${selection.job_id}`;
  if (selection.provider === 'ashby') return `ashby:${selection.board_name}:${selection.job_id}`;
  return `manual:${selection.source_url}`;
};

// Job-board/aggregator hub domains -- category and search-results pages, never a single job
// posting. Discovering one of these wastes a full Firecrawl/Apify scrape on unusable content
// (see docs/decisions.md). Excludes the ATS platforms themselves (greenhouse.io/lever.co/
// ashbyhq.com), which are the individual postings this pipeline actually wants.
const AGGREGATOR_HOSTNAMES = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'wellfound.com',
  'weworkremotely.com', 'ambitionbox.com', 'naukri.com', 'monster.com', 'simplyhired.com',
  'builtin.com', 'crossover.com', 'remoterocketship.com'
];
const isAggregatorUrl = (sourceUrl) => {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return AGGREGATOR_HOSTNAMES.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
};

const SUPPORTED_STACK = [['Node.js', /\bnode(?:\.js)?\b/i], ['JavaScript', /\bjavascript\b/i], ['TypeScript', /\btypescript\b/i], ['Python', /\bpython\b/i], ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i], ['Docker', /\bdocker\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b/i]];
const EXCLUDED_STACK = [['mobile-only', /\b(?:android|ios|swift|react native|flutter)\b/i], ['data-science/ML-infrastructure', /\b(?:data scientist|machine learning engineer|ml infrastructure|gpu|cuda)\b/i], ['specialist language', /\b(?:kotlin|golang|go developer|rust|ruby on rails|c\+\+|embedded c)\b/i]];
const cleanText = (value, max = 400) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const hostnameGuess = (sourceUrl) => {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^(www\.|careers\.|jobs\.|apply\.)/, '');
    const labels = hostname.split('.');
    return labels.length > 1 ? labels.slice(0, -1).join('.') : hostname;
  } catch {
    return null;
  }
};
const companyName = (result) => cleanText(result.board_token || result.site || result.board_name || hostnameGuess(result.source_url) || 'Unknown company');

export const evaluateJob = (job) => {
  const text = `${job.title || ''}\n${job.location || ''}\n${job.description_text || ''}`;
  const stackMatch = SUPPORTED_STACK.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const hardGaps = EXCLUDED_STACK.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const isRemote = /\bremote\b/i.test(text);
  const india = /\bindia\b|\bglobal\b|\bworldwide\b/i.test(text);
  const usOnly = /\b(?:us[- ]?only|united states only|must be (?:located|based) in (?:the )?u\.?s\.?|us work authorization)\b/i.test(text);
  const senior = /\b(?:3|4|5|6|7|8|9|\d{2})\+?\s+years?\b|\b(?:senior|staff|principal|lead)\b/i.test(text);
  const locationStatus = usOnly ? 'ineligible' : india || isRemote ? 'confirmed' : 'unconfirmed';
  if (senior) hardGaps.push('3+ years or senior-level requirement');
  if (locationStatus === 'ineligible') hardGaps.push('location/work authorization restriction');
  const score = Math.max(0, Math.min(10, 3 + stackMatch.length - hardGaps.length * 3 + (locationStatus === 'confirmed' ? 1 : 0)));
  const recommendation = hardGaps.length ? 'skip' : score >= 7 ? 'apply' : score >= 5 ? 'maybe' : 'skip';
  return { fit_score: score, recommendation, stack_match: stackMatch, hard_gaps: hardGaps, location_status: locationStatus, experience_status: senior ? 'too_senior' : 'junior', evidence: [{ label: 'Verified job posting', url: job.source_url, note: 'Retrieved job text supports the evaluated requirements.' }], questions_for_candidate: locationStatus === 'unconfirmed' ? ['Confirm the role can be performed from India.'] : [], reason: hardGaps.length ? `Skipped because: ${hardGaps.join(', ')}.` : `Matched stack: ${stackMatch.join(', ') || 'limited explicit match'}.` };
};

const packetDraft = (job, evaluation, candidate, { resumeBucket, companyLinks } = {}) => {
  const name = cleanText(candidate?.name, 120) || 'Candidate';
  const facts = Array.isArray(candidate?.verified_facts) ? candidate.verified_facts.map((fact) => cleanText(fact, 280)).filter(Boolean).slice(0, 5) : [];
  const factLines = facts.length ? facts.map((fact) => `- ${fact}`).join('\n') : '- Add verified candidate facts before using this draft.';
  const referenceExcerpt = resumeBucket?.reference_text ? cleanText(resumeBucket.reference_text, 1200) : '';
  const resumeSection = resumeBucket ? `\n## Suggested resume\n\n- ${resumeBucket.target_role} (${resumeBucket.pdf_path})\n- Positioning: ${resumeBucket.positioning_angle}\n${referenceExcerpt ? `\n### Reference resume excerpt (structure/tone/experience only — verify before reuse)\n\n${referenceExcerpt}\n` : ''}` : '';
  const companyLines = [
    companyLinks?.website_url ? `- Website: ${companyLinks.website_url}` : null,
    companyLinks?.linkedin_url ? `- LinkedIn: ${companyLinks.linkedin_url}` : null
  ].filter(Boolean);
  const companySection = companyLines.length ? `\n## Company links\n\n${companyLines.join('\n')}\n` : '';
  return `# Application packet — ${job.title || 'Role'}\n\nStatus: needs_review\n\n## Verified job evidence\n\n- Source: ${job.source_url}\n- Location: ${job.location || 'Not specified'}\n- Fit: ${evaluation.fit_score}/10 (${evaluation.recommendation})\n${resumeSection}${companySection}\n## Candidate facts supplied for this draft\n\n${factLines}\n\n## Draft note\n\nHello hiring team,\n\nI'm ${name}. I'm interested in the ${job.title || 'open'} role. My relevant, verified experience is listed above. I would welcome the chance to discuss whether it fits the team's needs.\n\nBest,\n${name}\n\n## Review checklist\n\n- Confirm location and work-authorization requirements.\n- Confirm every candidate fact is current and truthful.\n- Open the original posting before any supervised application action.\n`;
};

export class JobPipeline {
  constructor({ store, reviewStore, artifactDir, verify = verifyJob, verifyFallback = null, resumeClassifier = null, resumeBuckets = [], companyLookup = null, dailyCap = 20, defaultCandidate = null, factSelector = null }) {
    Object.assign(this, { store, reviewStore, artifactDir, verify, verifyFallback, resumeClassifier, resumeBuckets, companyLookup, dailyCap, defaultCandidate, factSelector });
  }
  async process({ source_url: sourceUrl, candidate } = {}) {
    // Reject known aggregator/job-board hub pages before spending anything -- they're category
    // or search-results pages, never a single job posting, so verifying one is pure waste.
    if (isAggregatorUrl(sourceUrl)) {
      const record = await this.store.record({ stable_id: `manual:${sourceUrl}`, status: 'rejected', source_url: sourceUrl, error: 'Known job-board aggregator domain, not an individual posting.' });
      return { stage: 'rejected', record };
    }

    // Dedupe by the URL's own provider-derived ID before spending anything on verification —
    // a URL already recorded as needs_review/skipped/expired/unverified is not worth re-paying
    // Firecrawl/Apify for on every discovery run (see docs/decisions.md). daily_cap_reached is
    // the one non-terminal status: today's cap doesn't mean the job is bad, so it stays
    // eligible for a future run to actually verify and queue it.
    const selection = selectProvider(sourceUrl);
    const priorStableId = computeStableId(selection);
    const priorRecord = await this.store.getByStableId(priorStableId);
    if (priorRecord && priorRecord.status !== 'daily_cap_reached') return { stage: 'duplicate', existing: priorRecord };

    let verification = await this.verify(sourceUrl);
    if (verification.liveness === 'unverified' && this.verifyFallback) {
      verification = await this.verifyFallback(sourceUrl);
    }
    if (verification.liveness !== 'live') {
      const status = verification.liveness === 'closed' ? 'expired' : 'unverified';
      const record = await this.store.record({ stable_id: priorStableId, status, source_url: selection.source_url, error: verification.error || null });
      return { stage: status === 'expired' ? 'expired' : 'manual_review', verification, record };
    }
    const existing = await this.store.getByStableId(verification.job.stable_id);
    if (existing?.status === 'needs_review' || existing?.status === 'approved') return { stage: 'duplicate', existing, verification };
    const evaluation = evaluateJob(verification.job);
    // Company profile is looked up for every live-verified job (not just accepted ones) so the
    // full job-listings view has context even on skipped/capped entries -- see docs/decisions.md.
    const companyLinks = this.companyLookup ? await this.companyLookup(companyName(verification)) : null;
    const listingFields = { title: verification.job.title, location: verification.job.location, company: companyName(verification), company_links: companyLinks };

    if (evaluation.recommendation === 'skip') {
      const record = await this.store.record({ stable_id: verification.job.stable_id, status: 'skipped', source_url: verification.job.source_url, evaluation, ...listingFields });
      return { stage: 'skipped', verification, evaluation, record };
    }

    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const createdToday = await this.store.countCreatedSince(startOfDayUtc.toISOString());
    if (createdToday >= this.dailyCap) {
      const record = await this.store.record({ stable_id: verification.job.stable_id, status: 'daily_cap_reached', source_url: verification.job.source_url, evaluation, ...listingFields });
      return { stage: 'daily_cap_reached', verification, evaluation, record };
    }

    const { review, artifactPath, record } = await this.#draft(verification, evaluation, companyLinks, candidate, listingFields);
    return { stage: 'needs_review', verification, evaluation, artifact_path: artifactPath, review, record };
  }

  // Redrafts a single already-processed job -- for a stuck placeholder draft, a stale fact set,
  // or any other reason a human wants a fresh packet without re-running the whole daily pipeline.
  // Bypasses process()'s dedupe/skip/daily-cap checks entirely (they protect bulk discovery, not a
  // targeted single-item retry) -- same precedent as FounderOutreachRunner.regenerateOne (see
  // docs/decisions.md). Re-verifies and re-evaluates from scratch rather than trusting the stored
  // record, so a posting that has gone dead since it was first discovered fails loudly instead of
  // drafting an application for a job that no longer exists.
  async regenerateOne(stableId) {
    const existing = await this.store.getByStableId(stableId);
    if (!existing) throw new Error('job not found for this stable_id');

    if (existing.review_item_id) {
      const items = await this.reviewStore.list({});
      const oldItem = items.find((item) => item.id === existing.review_item_id);
      if (oldItem && oldItem.status === 'pending') {
        await this.reviewStore.decide(oldItem.id, { action: 'reject', approval_id: oldItem.approval_id, actor: 'system', reason: 'Superseded by regenerated draft' });
      }
    }

    let verification = await this.verify(existing.source_url);
    if (verification.liveness === 'unverified' && this.verifyFallback) {
      verification = await this.verifyFallback(existing.source_url);
    }
    if (verification.liveness !== 'live') throw new Error(`cannot regenerate: job is no longer live (${verification.liveness})`);

    const evaluation = evaluateJob(verification.job);
    const companyLinks = this.companyLookup ? await this.companyLookup(companyName(verification)) : null;
    const listingFields = { title: verification.job.title, location: verification.job.location, company: companyName(verification), company_links: companyLinks };

    const { review, artifactPath, record } = await this.#draft(verification, evaluation, companyLinks, null, listingFields);
    return { stage: 'needs_review', verification, evaluation, artifact_path: artifactPath, review, record };
  }

  async #draft(verification, evaluation, companyLinks, candidate, listingFields) {
    const resumeMatch = this.resumeClassifier && this.resumeBuckets.length
      ? await this.resumeClassifier(verification.job, this.resumeBuckets)
      : null;
    const resumeBucket = resumeMatch?.bucket_id ? this.resumeBuckets.find((bucket) => bucket.id === resumeMatch.bucket_id) : null;

    // Explicit candidate always wins over defaultCandidate -- a caller that supplies its own name
    // or facts is never overridden. factSelector only fires when nothing already supplied
    // verified_facts and a resumeBucket actually matched (nothing to extract facts from otherwise).
    const mergedCandidate = { ...(this.defaultCandidate || {}), ...(candidate || {}) };
    if (this.factSelector && resumeBucket && !mergedCandidate.verified_facts) {
      const factResult = await this.factSelector(verification.job, resumeBucket);
      if (factResult?.facts?.length) mergedCandidate.verified_facts = factResult.facts;
    }

    await mkdir(this.artifactDir, { recursive: true });
    const artifactPath = join(this.artifactDir, `packet-${randomUUID()}.md`);
    const draft = packetDraft(verification.job, evaluation, mergedCandidate, { resumeBucket, companyLinks });
    await writeFile(artifactPath, draft, { encoding: 'utf8', mode: 0o600 });
    const review = await this.reviewStore.create({ item_id: verification.job.stable_id, kind: 'job', title: `${verification.job.title || 'Untitled role'} — ${companyName(verification)}`, source_url: verification.job.source_url, summary: `${evaluation.reason} Location: ${evaluation.location_status}. This draft requires human review before any application action.`, draft, fit_score: evaluation.fit_score, evidence: evaluation.evidence });
    const record = await this.store.record({ stable_id: verification.job.stable_id, status: 'needs_review', source_url: verification.job.source_url, artifact_path: artifactPath, review_item_id: review.id, evaluation, ...listingFields });
    return { review, artifactPath, record };
  }
}
