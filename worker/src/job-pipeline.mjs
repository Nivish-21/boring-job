import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyJob } from './job-verifier.mjs';

const SUPPORTED_STACK = [['Node.js', /\bnode(?:\.js)?\b/i], ['JavaScript', /\bjavascript\b/i], ['TypeScript', /\btypescript\b/i], ['Python', /\bpython\b/i], ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i], ['Docker', /\bdocker\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b/i]];
const EXCLUDED_STACK = [['mobile-only', /\b(?:android|ios|swift|react native|flutter)\b/i], ['data-science/ML-infrastructure', /\b(?:data scientist|machine learning engineer|ml infrastructure|gpu|cuda)\b/i], ['specialist language', /\b(?:kotlin|golang|go developer|rust|ruby on rails|c\+\+|embedded c)\b/i]];
const cleanText = (value, max = 400) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const companyName = (result) => cleanText(result.board_token || result.site || result.board_name || 'Unknown company');

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

const packetDraft = (job, evaluation, candidate) => {
  const name = cleanText(candidate?.name, 120) || 'Candidate';
  const facts = Array.isArray(candidate?.verified_facts) ? candidate.verified_facts.map((fact) => cleanText(fact, 280)).filter(Boolean).slice(0, 5) : [];
  const factLines = facts.length ? facts.map((fact) => `- ${fact}`).join('\n') : '- Add verified candidate facts before using this draft.';
  return `# Application packet — ${job.title || 'Role'}\n\nStatus: needs_review\n\n## Verified job evidence\n\n- Source: ${job.source_url}\n- Location: ${job.location || 'Not specified'}\n- Fit: ${evaluation.fit_score}/10 (${evaluation.recommendation})\n\n## Candidate facts supplied for this draft\n\n${factLines}\n\n## Draft note\n\nHello hiring team,\n\nI'm ${name}. I'm interested in the ${job.title || 'open'} role. My relevant, verified experience is listed above. I would welcome the chance to discuss whether it fits the team's needs.\n\nBest,\n${name}\n\n## Review checklist\n\n- Confirm location and work-authorization requirements.\n- Confirm every candidate fact is current and truthful.\n- Open the original posting before any supervised application action.\n`;
};

export class JobPipeline {
  constructor({ store, reviewStore, artifactDir, verify = verifyJob }) { Object.assign(this, { store, reviewStore, artifactDir, verify }); }
  async process({ source_url: sourceUrl, candidate } = {}) {
    const verification = await this.verify(sourceUrl);
    if (verification.liveness !== 'live') return { stage: verification.liveness === 'closed' ? 'expired' : 'manual_review', verification };
    const existing = await this.store.getByStableId(verification.job.stable_id);
    if (existing?.status === 'needs_review' || existing?.status === 'approved') return { stage: 'duplicate', existing, verification };
    const evaluation = evaluateJob(verification.job);
    if (evaluation.recommendation === 'skip') {
      const record = await this.store.record({ stable_id: verification.job.stable_id, status: 'skipped', source_url: verification.job.source_url, evaluation });
      return { stage: 'skipped', verification, evaluation, record };
    }
    await mkdir(this.artifactDir, { recursive: true });
    const artifactPath = join(this.artifactDir, `packet-${randomUUID()}.md`);
    const draft = packetDraft(verification.job, evaluation, candidate);
    await writeFile(artifactPath, draft, { encoding: 'utf8', mode: 0o600 });
    const review = await this.reviewStore.create({ item_id: verification.job.stable_id, kind: 'job', title: `${verification.job.title || 'Untitled role'} — ${companyName(verification)}`, source_url: verification.job.source_url, summary: `${evaluation.reason} Location: ${evaluation.location_status}. This draft requires human review before any application action.`, draft, fit_score: evaluation.fit_score, evidence: evaluation.evidence });
    const record = await this.store.record({ stable_id: verification.job.stable_id, status: 'needs_review', source_url: verification.job.source_url, artifact_path: artifactPath, review_item_id: review.id, evaluation });
    return { stage: 'needs_review', verification, evaluation, artifact_path: artifactPath, review, record };
  }
}
