const listings = document.querySelector('#listings');
const usage = document.querySelector('#usage');
const template = document.querySelector('#item-template');
const refreshButton = document.querySelector('#refresh');
const resultCount = document.querySelector('#result-count');
const clearFiltersButton = document.querySelector('#clear-filters');
const filterCompany = document.querySelector('#filter-company');
const filterFitMin = document.querySelector('#filter-fit-min');
const statusCheckboxes = [...document.querySelectorAll('input[name="status"]')];

const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const formatResetDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));

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
  return pipelineJobs.map((job) => {
    const reviewItem = job.review_item_id ? reviewById.get(job.review_item_id) : null;
    if (reviewItem) {
      return {
        key: job.stable_id,
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
};

const applyFilters = (cards) => {
  const checkedStatuses = statusCheckboxes.filter((box) => box.checked).map((box) => box.value);
  const company = filterCompany.value.trim().toLowerCase();
  const fitMin = filterFitMin.value === '' ? null : Number(filterFitMin.value);
  return cards.filter((card) => {
    if (!checkedStatuses.includes(card.status)) return false;
    if (company && !(card.company || '').toLowerCase().includes(company)) return false;
    if (fitMin !== null && (typeof card.fit_score !== 'number' || card.fit_score < fitMin)) return false;
    return true;
  });
};

const decide = async (reviewItem, action, button) => {
  const reason = action === 'reject' ? window.prompt('Optional rejection reason:') : null;
  button.disabled = true;
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

const renderCard = (card) => {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector('.review-item');
  fragment.querySelector('.item-meta').textContent = `${card.company || 'Unknown company'} · discovered ${formatDate(card.created_at)}`;
  fragment.querySelector('h2').textContent = card.title;
  fragment.querySelector('.status').textContent = STATUS_LABELS[card.status] || card.status;
  fragment.querySelector('.status').classList.add(`status-${card.status}`);
  fragment.querySelector('.summary').textContent = card.summary;
  fragment.querySelector('.source-link').href = card.source_url;

  const details = fragment.querySelector('.details');
  const fields = [
    ['Fit score', typeof card.fit_score === 'number' ? `${card.fit_score}/10` : null],
    ['Location', card.location],
    ['Expires', card.status === 'pending' ? formatDate(card.expires_at) : null],
    ['Last updated', card.status !== 'pending' && card.updated_at ? formatDate(card.updated_at) : null]
  ];
  fields.filter(([, value]) => value).forEach(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = value;
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
  const filtered = applyFilters(allCards);
  resultCount.textContent = `${filtered.length} of ${allCards.length} jobs`;
  listings.replaceChildren();
  if (!filtered.length) {
    return showMessage(listings, allCards.length ? 'No jobs match the current filters.' : 'No jobs discovered yet. Run the discovery workflow to populate this list.');
  }
  filtered.forEach((card) => listings.append(renderCard(card)));
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
clearFiltersButton.addEventListener('click', () => {
  statusCheckboxes.forEach((box) => { box.checked = true; });
  filterCompany.value = '';
  filterFitMin.value = '';
  renderResults();
});
refreshButton.addEventListener('click', () => { loadAll(); loadUsage(); });
loadAll();
loadUsage();
