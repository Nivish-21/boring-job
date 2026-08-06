const listings = document.querySelector('#listings');
const usage = document.querySelector('#usage');
const template = document.querySelector('#item-template');
const refreshButton = document.querySelector('#refresh');
const resultCount = document.querySelector('#result-count');
const clearFiltersButton = document.querySelector('#clear-filters');
const filterCompany = document.querySelector('#filter-company');
const filterFitMin = document.querySelector('#filter-fit-min');
const filterFitGroup = document.querySelector('#filter-fit-group');
const statusCheckboxes = [...document.querySelectorAll('input[name="status"]')];
const tabs = [...document.querySelectorAll('.tab')];

// Job applications and founder-outreach messages are fundamentally different tasks (read a
// generated packet vs. copy a short message and send it elsewhere) that used to sit interleaved
// in one flat list with no way to tell them apart at a glance -- user feedback: "I don't know
// which one to send to whom". Tabs are a standard, expected pattern for this (not a novel
// affordance); each kind gets its own explicit, exclusive view. Defaults to Founder outreach
// since that's the active to-do list; Job applications is the larger, denser archive.
let activeKind = 'founder';

const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const formatResetDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
// Founder-outreach timestamps show IST specifically, per an explicit user ask -- job cards stay
// on the browser's local time zone, unchanged.
const formatDateIst = (value) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const formatCardDate = (card, value) => (card.kind === 'founder' ? formatDateIst : formatDate)(value);

const KIND_LABELS = { job: 'Job', founder: 'Founder outreach' };

const STATUS_LABELS = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  skipped: 'Skipped (not a fit)',
  daily_cap_reached: 'Waiting for cap',
  unverified: "Couldn't verify",
  expired: 'Expired / closed',
  aggregator_rejected: 'Rejected (bad source)'
};

// Founder-outreach titles are built as "<name> — <company>" (see founder-outreach.mjs); derived
// here rather than stored a second time, since ReviewStore's schema has no dedicated company
// field -- keeps the company filter working for founder cards without a store schema change.
const founderCompanyFromTitle = (title) => {
  const parts = String(title || '').split(' — ');
  return parts.length > 1 ? parts.slice(1).join(' — ') : null;
};

let allCards = [];

const showMessage = (container, message, type = 'info') => {
  container.replaceChildren();
  const panel = document.createElement('section');
  panel.className = `message message-${type}`;
  panel.textContent = message;
  container.append(panel);
};

// A pipeline job that reached human review shares its `id` with a review-store item
// (`job.review_item_id`). That review item is the source of truth for status/draft/evidence
// once a decision is made — `job-pipeline.mjs` never updates the pipeline record afterward. All
// other pipeline jobs (skipped/expired/unverified/daily_cap_reached/rejected) have no review
// item and are rendered read-only. `PipelineStore`'s own `'rejected'` status (aggregator
// domain, rejected before verification) is remapped to `aggregator_rejected` so it doesn't
// collide with `ReviewStore`'s human-decision `'rejected'` status.
const buildCards = (pipelineJobs, reviewItems) => {
  const reviewById = new Map(reviewItems.map((item) => [item.id, item]));
  const referencedReviewIds = new Set(pipelineJobs.map((job) => job.review_item_id).filter(Boolean));

  const jobCards = pipelineJobs.map((job) => {
    const reviewItem = job.review_item_id ? reviewById.get(job.review_item_id) : null;
    if (reviewItem) {
      return {
        key: job.stable_id,
        kind: 'job',
        status: reviewItem.status,
        title: reviewItem.title,
        company: job.company,
        location: job.location,
        source_url: reviewItem.source_url,
        summary: reviewItem.summary,
        fit_score: reviewItem.fit_score,
        created_at: reviewItem.created_at,
        expires_at: reviewItem.expires_at,
        draft: reviewItem.draft,
        evidence: reviewItem.evidence,
        artifact_url: reviewItem.artifact_url,
        company_links: job.company_links,
        reviewItem
      };
    }
    return {
      key: job.stable_id,
      kind: 'job',
      status: job.status === 'rejected' ? 'aggregator_rejected' : job.status,
      title: job.title || job.source_url,
      company: job.company,
      location: job.location,
      source_url: job.source_url,
      summary: job.evaluation?.reason || job.error || 'No further detail recorded.',
      fit_score: job.evaluation?.fit_score ?? null,
      created_at: job.created_at,
      updated_at: job.updated_at,
      draft: null,
      evidence: [],
      artifact_url: null,
      company_links: job.company_links,
      reviewItem: null
    };
  });

  // Review items with no pipeline-job counterpart never surfaced before this pass -- currently
  // that's only `kind: 'founder'` items, since every `kind: 'job'` review item is created from
  // inside JobPipeline.process() and therefore always has a matching pipeline job.
  const standaloneCards = reviewItems
    .filter((item) => !referencedReviewIds.has(item.id))
    .map((item) => ({
      key: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      company: item.kind === 'founder' ? founderCompanyFromTitle(item.title) : null,
      location: null,
      source_url: item.source_url,
      summary: item.summary,
      fit_score: item.fit_score,
      created_at: item.created_at,
      expires_at: item.expires_at,
      draft: item.draft,
      evidence: item.evidence,
      artifact_url: item.artifact_url,
      company_links: null,
      reviewItem: item
    }));

  return [...jobCards, ...standaloneCards];
};

const applyFilters = (cards) => {
  const checkedStatuses = statusCheckboxes.filter((box) => box.checked).map((box) => box.value);
  const company = filterCompany.value.trim().toLowerCase();
  const fitMin = filterFitMin.value === '' ? null : Number(filterFitMin.value);
  return cards.filter((card) => {
    if (card.kind !== activeKind) return false;
    if (!checkedStatuses.includes(card.status)) return false;
    if (company && !(card.company || '').toLowerCase().includes(company)) return false;
    if (fitMin !== null && (typeof card.fit_score !== 'number' || card.fit_score < fitMin)) return false;
    return true;
  });
};

// Founder and job cards both route "Regenerate" to a dedicated endpoint that actually redrafts
// (rejects the stale item, reruns the source pipeline, creates a fresh one) -- ReviewStore's own
// `decide()` 'regenerate' action only flips status back to pending, it never touches draft content.
const decide = async (reviewItem, action, button) => {
  button.disabled = true;
  if (reviewItem.kind === 'founder' && action === 'regenerate') {
    try {
      const response = await fetch(`/api/founders/${encodeURIComponent(reviewItem.item_id)}/regenerate`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not regenerate the draft');
      await loadAll();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
    return;
  }
  if (reviewItem.kind === 'job' && action === 'regenerate') {
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(reviewItem.item_id)}/regenerate`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not regenerate the draft');
      await loadAll();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
    return;
  }
  const reason = action === 'reject' ? window.prompt('Optional rejection reason:') : null;
  try {
    const response = await fetch(`/api/review/items/${reviewItem.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, approval_id: reviewItem.approval_id, actor: 'local-dashboard', reason })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not record the decision');
    await loadAll();
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
};

const copyDraft = async (draft, button) => {
  const originalLabel = button.textContent;
  try {
    await navigator.clipboard.writeText(draft);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = originalLabel; }, 1800);
};

const renderCard = (card) => {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector('.review-item');
  fragment.querySelector('.item-meta').textContent = `${card.company || 'Unknown company'} · discovered ${formatCardDate(card, card.created_at)}`;
  fragment.querySelector('h2').textContent = card.title;
  fragment.querySelector('.kind').textContent = KIND_LABELS[card.kind] || card.kind;
  fragment.querySelector('.kind').classList.add(`kind-${card.kind}`);
  fragment.querySelector('.status').textContent = STATUS_LABELS[card.status] || card.status;
  fragment.querySelector('.status').classList.add(`status-${card.status}`);
  fragment.querySelector('.summary').textContent = card.summary;
  fragment.querySelector('.source-link').href = card.source_url;

  const details = fragment.querySelector('.details');
  const fitClass = typeof card.fit_score === 'number' ? (card.fit_score >= 7 ? 'fit-good' : card.fit_score >= 5 ? 'fit-maybe' : 'fit-poor') : null;
  const fields = [
    ['Discovered', formatCardDate(card, card.created_at)],
    ['Fit score', typeof card.fit_score === 'number' ? `${card.fit_score}/10` : null, fitClass],
    ['Location', card.location],
    ['Expires', card.status === 'pending' ? formatCardDate(card, card.expires_at) : null],
    ['Last updated', card.status !== 'pending' && card.updated_at ? formatCardDate(card, card.updated_at) : null]
  ];
  fields.filter(([, value]) => value).forEach(([label, value, className]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = value;
    if (className) definition.classList.add(className);
    details.append(term, definition);
  });

  if (card.artifact_url) {
    const link = fragment.querySelector('.artifact-link');
    link.href = card.artifact_url;
    link.hidden = false;
  }
  if (card.company_links?.website_url) {
    const link = fragment.querySelector('.website-link');
    link.href = card.company_links.website_url;
    link.hidden = false;
  }
  if (card.company_links?.linkedin_url) {
    const link = fragment.querySelector('.linkedin-link');
    link.href = card.company_links.linkedin_url;
    link.hidden = false;
  }
  if (card.draft) {
    fragment.querySelector('.draft-wrap').hidden = false;
    fragment.querySelector('.draft').textContent = card.draft;
  }
  // Copy-to-send is the actual task-completing action for a founder message (it gets pasted into
  // LinkedIn, never sent from here) -- shown whenever a draft exists, independent of status, so
  // it still works after approving. Downgrades "Approve" to secondary on these cards specifically
  // so there's one clear primary action, not two competing blue buttons.
  if (card.kind === 'founder' && card.draft) {
    const copyButton = fragment.querySelector('.copy-draft');
    copyButton.hidden = false;
    copyButton.addEventListener('click', () => copyDraft(card.draft, copyButton));
    const approveButton = fragment.querySelector('[data-action="approve"]');
    approveButton.classList.remove('button-primary');
    approveButton.classList.add('button-secondary');
  }
  if (card.evidence.length) {
    fragment.querySelector('.evidence-wrap').hidden = false;
    const list = fragment.querySelector('.evidence');
    card.evidence.forEach((entry) => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = entry.label;
      row.append(link);
      if (entry.note) row.append(` — ${entry.note}`);
      list.append(row);
    });
  }
  if (card.status === 'pending') {
    article.querySelectorAll('[data-action]').forEach((button) => {
      button.hidden = false;
      button.addEventListener('click', () => decide(card.reviewItem, button.dataset.action, button));
    });
  }
  return fragment;
};

const renderResults = () => {
  const kindTotal = allCards.filter((card) => card.kind === activeKind).length;
  const filtered = applyFilters(allCards);
  const noun = activeKind === 'founder' ? 'messages' : 'jobs';
  resultCount.textContent = `${filtered.length} of ${kindTotal} ${noun}`;
  listings.setAttribute('aria-labelledby', `tab-${activeKind}`);
  listings.replaceChildren();
  if (!filtered.length) {
    const empty = activeKind === 'founder'
      ? (kindTotal ? 'No founder messages match the current filters.' : 'No founder-outreach messages yet. Import a connections CSV to populate this list.')
      : (kindTotal ? 'No jobs match the current filters.' : 'No jobs discovered yet. Run the discovery workflow to populate this list.');
    return showMessage(listings, empty);
  }
  filtered.forEach((card) => listings.append(renderCard(card)));
};

const updateTabCounts = () => {
  document.querySelector('#tab-count-founder').textContent = `(${allCards.filter((card) => card.kind === 'founder').length})`;
  document.querySelector('#tab-count-job').textContent = `(${allCards.filter((card) => card.kind === 'job').length})`;
};

const setActiveTab = (kind) => {
  activeKind = kind;
  tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.kind === kind)));
  filterFitGroup.hidden = kind === 'founder';
  renderResults();
};

async function loadAll() {
  listings.setAttribute('aria-busy', 'true');
  try {
    const [jobsResponse, itemsResponse] = await Promise.all([fetch('/api/pipeline/jobs'), fetch('/api/review/items')]);
    const jobsPayload = await jobsResponse.json();
    const itemsPayload = await itemsResponse.json();
    if (!jobsResponse.ok) throw new Error(jobsPayload.error || 'Could not load discovered jobs');
    if (!itemsResponse.ok) throw new Error(itemsPayload.error || 'Could not load the review queue');
    allCards = buildCards(jobsPayload.jobs, itemsPayload.items);
    updateTabCounts();
    renderResults();
  } catch (error) {
    showMessage(listings, error.message, 'error');
  } finally {
    listings.setAttribute('aria-busy', 'false');
  }
}

const usagePill = (label, remaining, total, resetAt, unit = '') => {
  const item = document.createElement('p');
  item.className = 'usage-item';
  if (typeof remaining === 'number' && typeof total === 'number' && total > 0) {
    const remainingRatio = remaining / total;
    if (remainingRatio <= 0.2) item.classList.add('usage-warn');
    const formatAmount = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const strong = document.createElement('strong');
    strong.textContent = `${label}: ${unit}${formatAmount(remaining)} / ${unit}${formatAmount(total)} left`;
    item.append(strong);
    if (resetAt) item.append(` · resets ${formatResetDate(resetAt)}`);
  } else {
    item.textContent = `${label}: usage unavailable`;
  }
  return item;
};

async function loadUsage() {
  try {
    const response = await fetch('/api/usage');
    const payload = await response.json();
    if (!response.ok) throw new Error('Could not load usage');
    usage.replaceChildren();
    usage.append(usagePill('Firecrawl', payload.firecrawl?.remaining_credits, payload.firecrawl?.plan_credits, payload.firecrawl?.billing_period_end));
    usage.append(usagePill('Apify', payload.apify?.max_monthly_usage_usd - payload.apify?.monthly_usage_usd, payload.apify?.max_monthly_usage_usd, payload.apify?.cycle_end, '$'));
    usage.hidden = false;
  } catch {
    usage.hidden = true;
  }
}

statusCheckboxes.forEach((box) => box.addEventListener('change', renderResults));
filterCompany.addEventListener('input', renderResults);
filterFitMin.addEventListener('input', renderResults);
tabs.forEach((tab) => tab.addEventListener('click', () => setActiveTab(tab.dataset.kind)));
clearFiltersButton.addEventListener('click', () => {
  statusCheckboxes.forEach((box) => { box.checked = true; });
  filterCompany.value = '';
  filterFitMin.value = '';
  renderResults();
});
refreshButton.addEventListener('click', () => { loadAll(); loadUsage(); });
setActiveTab(activeKind);
loadAll();
loadUsage();
