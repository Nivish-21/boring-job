const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'gh_src',
  'gh_jid',
  'li_fat_id',
  'ref',
  'source'
]);

const isTrackingParameter = (name) => name.startsWith('utm_') || TRACKING_PARAMETERS.has(name.toLowerCase());

export const normalizeJobUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('source_url is required');

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('source_url must be an http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('source_url must be an http or https URL');

  url.protocol = 'https:';
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParameter(name)) url.searchParams.delete(name);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
};

const parseGreenhouse = (url) => {
  if (!['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname)) return null;
  const match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)$/);
  if (!match) return null;
  return { provider: 'greenhouse', board_token: decodeURIComponent(match[1]), job_id: decodeURIComponent(match[2]) };
};

const parseLever = (url) => {
  if (url.hostname !== 'jobs.lever.co') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { provider: 'lever', site: decodeURIComponent(match[1]), job_id: decodeURIComponent(match[2]) };
};

const parseAshby = (url) => {
  if (url.hostname !== 'jobs.ashbyhq.com') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { provider: 'ashby', board_name: decodeURIComponent(match[1]), job_id: decodeURIComponent(match[2]) };
};

export const selectProvider = (sourceUrl) => {
  const normalizedUrl = normalizeJobUrl(sourceUrl);
  const url = new URL(normalizedUrl);
  const match = parseGreenhouse(url) || parseLever(url) || parseAshby(url);

  if (!match) {
    return {
      source_url: normalizedUrl,
      provider: 'manual',
      verification_mode: 'manual_review',
      reason: 'No supported public ATS URL pattern matched.'
    };
  }

  return {
    source_url: normalizedUrl,
    ...match,
    verification_mode: 'public_adapter',
    reason: `Use the ${match.provider} public adapter before considering a browser fallback.`
  };
};
