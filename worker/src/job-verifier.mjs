import { selectProvider } from './provider-selector.mjs';

const requestTimeoutMs = 10_000;

const decodeHtml = (value) => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'");

export const htmlToText = (value) => {
  if (typeof value !== 'string') return '';
  return decodeHtml(value
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const getNames = (entries) => Array.isArray(entries)
  ? entries.map((entry) => entry?.name).filter((name) => typeof name === 'string' && name.trim())
  : [];

const responseError = (response) => {
  if (response.status === 404) return { liveness: 'closed', error: 'Greenhouse no longer returns this job posting.' };
  return { liveness: 'unverified', error: `Greenhouse returned HTTP ${response.status}.` };
};

const fetchJson = async (endpoint, fetchImpl, controller) => {
  const response = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: controller.signal });
  return { response, json: response.ok ? await response.json() : null };
};

const normalizedJob = ({ stableId, selection, title, applicationUrl, location, updatedAt, departments = [], offices = [], descriptionHtml = '', descriptionText }) => ({
  stable_id: stableId,
  title: typeof title === 'string' ? title.trim() : null,
  source_url: selection.source_url,
  direct_application_url: typeof applicationUrl === 'string' ? applicationUrl : selection.source_url,
  location: typeof location === 'string' ? location.trim() : null,
  updated_at: typeof updatedAt === 'string' ? updatedAt : null,
  departments,
  offices,
  description_html: descriptionHtml,
  description_text: descriptionText || htmlToText(descriptionHtml)
});

const verifyLever = async (selection, fetchImpl, controller) => {
  const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(selection.site)}/${encodeURIComponent(selection.job_id)}`;
  const { response, json: job } = await fetchJson(endpoint, fetchImpl, controller);
  if (!response.ok) return { ...selection, verification_status: 'checked', ...responseError(response) };
  const descriptionHtml = typeof job.description === 'string' ? job.description : '';
  const descriptionText = typeof job.descriptionPlain === 'string' ? job.descriptionPlain.trim() : htmlToText(descriptionHtml);
  if (!descriptionText) return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Lever returned a job without usable description text.' };
  return {
    ...selection,
    verification_status: 'checked', liveness: 'live', retrieved_at: new Date().toISOString(),
    job: normalizedJob({
      stableId: `lever:${selection.site}:${selection.job_id}`, selection, title: job.text,
      applicationUrl: job.hostedUrl, location: job.categories?.location, updatedAt: job.createdAt,
      departments: [job.categories?.team].filter(Boolean), offices: [job.categories?.location].filter(Boolean),
      descriptionHtml, descriptionText
    })
  };
};

const verifyAshby = async (selection, fetchImpl, controller) => {
  const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(selection.board_name)}`;
  const { response, json } = await fetchJson(endpoint, fetchImpl, controller);
  if (!response.ok) return { ...selection, verification_status: 'checked', ...responseError(response) };
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const job = jobs.find((entry) => [entry.id, entry.jobUrl, entry.applyUrl].some((value) => typeof value === 'string' && (value === selection.job_id || value.endsWith(`/${selection.job_id}`))));
  if (!job) return { ...selection, verification_status: 'checked', liveness: 'closed', error: 'Ashby no longer returns this job posting.' };
  const descriptionHtml = typeof job.descriptionHtml === 'string' ? job.descriptionHtml : '';
  const descriptionText = typeof job.descriptionPlain === 'string' ? job.descriptionPlain.trim() : htmlToText(descriptionHtml);
  if (!descriptionText) return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Ashby returned a job without usable description text.' };
  return {
    ...selection,
    verification_status: 'checked', liveness: 'live', retrieved_at: new Date().toISOString(),
    job: normalizedJob({
      stableId: `ashby:${selection.board_name}:${selection.job_id}`, selection, title: job.title,
      applicationUrl: job.applyUrl || job.jobUrl, location: job.location, updatedAt: job.publishedAt,
      departments: [job.department].filter(Boolean), offices: [job.team].filter(Boolean), descriptionHtml, descriptionText
    })
  };
};

export const verifyJob = async (sourceUrl, { fetchImpl = fetch } = {}) => {
  const selection = selectProvider(sourceUrl);
  if (selection.provider === 'manual') {
    return {
      ...selection,
      liveness: 'unverified',
      verification_status: selection.verification_mode === 'manual_review' ? 'manual_review' : 'adapter_not_available'
    };
  }

  const endpoint = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(selection.board_token)}/jobs/${encodeURIComponent(selection.job_id)}`);
  endpoint.searchParams.set('content', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    if (selection.provider === 'lever') return await verifyLever(selection, fetchImpl, controller);
    if (selection.provider === 'ashby') return await verifyAshby(selection, fetchImpl, controller);
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return { ...selection, verification_status: 'checked', ...responseError(response) };

    const job = await response.json();
    if (!job || typeof job !== 'object' || String(job.id) !== selection.job_id) {
      return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Greenhouse returned an unexpected job record.' };
    }
    const descriptionHtml = typeof job.content === 'string' ? job.content : '';
    const descriptionText = htmlToText(descriptionHtml);
    if (!descriptionText) {
      return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Greenhouse returned a job without usable description text.' };
    }

    return {
      ...selection,
      verification_status: 'checked',
      liveness: 'live',
      retrieved_at: new Date().toISOString(),
      job: {
        stable_id: `greenhouse:${selection.board_token}:${selection.job_id}`,
        title: typeof job.title === 'string' ? job.title.trim() : null,
        source_url: selection.source_url,
        direct_application_url: typeof job.absolute_url === 'string' ? job.absolute_url : selection.source_url,
        location: typeof job.location?.name === 'string' ? job.location.name.trim() : null,
        updated_at: typeof job.updated_at === 'string' ? job.updated_at : null,
        departments: getNames(job.departments),
        offices: getNames(job.offices),
        description_html: descriptionHtml,
        description_text: descriptionText
      }
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Greenhouse request timed out.' : 'Greenhouse request failed.';
    return { ...selection, liveness: 'unverified', verification_status: 'checked', error: message };
  } finally {
    clearTimeout(timeout);
  }
};
