const API_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR_ID = 'apify~website-content-crawler';
// Verified live against a real profile: no cookies/login required (no risk to the user's own
// LinkedIn account), and a maxPosts:0 call returned a genuine complete history (22 posts,
// 2015-2021) rather than silently truncating -- an empty/stale result for a given founder is a
// real signal, not a scraper bug.
const DEFAULT_POSTS_ACTOR_ID = 'harvestapi~linkedin-profile-posts';
const requestTimeoutMs = 45_000;

const classifyError = (status) => {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 402 || status === 403) return 'quota_exhausted';
  return 'unknown';
};

export const apifyScrape = async (url, { apiToken, actorId = DEFAULT_ACTOR_ID, fetchImpl = fetch } = {}) => {
  if (!apiToken) throw new Error('Apify API token is not configured');
  const endpoint = `${API_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apiToken)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], maxCrawlPages: 1, maxCrawlDepth: 0, saveMarkdown: true }),
      signal: controller.signal
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error?.message || `Apify returned HTTP ${response.status}`);
      error.errorType = classifyError(response.status);
      throw error;
    }
    const item = Array.isArray(json) ? json[0] : null;
    const metadata = item?.metadata || {};
    return {
      markdown: item?.markdown || item?.text || '',
      title: metadata.title || '',
      location: ''
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Apify request timed out');
      timeoutError.errorType = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Transport only, same division of labour as apifyScrape -- recency filtering and content
// trimming for prompt use lives in founder-outreach.mjs, not here.
export const fetchFounderPosts = async (profileUrl, { apiToken, actorId = DEFAULT_POSTS_ACTOR_ID, maxPosts = 5, fetchImpl = fetch } = {}) => {
  if (!apiToken) throw new Error('Apify API token is not configured');
  const endpoint = `${API_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apiToken)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUrls: [profileUrl], maxPosts }),
      signal: controller.signal
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error?.message || `Apify returned HTTP ${response.status}`);
      error.errorType = classifyError(response.status);
      throw error;
    }
    const items = Array.isArray(json) ? json : [];
    return items
      .filter((item) => typeof item?.content === 'string' && item.content.trim())
      .map((item) => ({ content: item.content.trim(), postedAt: item?.postedAt?.date || null }));
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Apify request timed out');
      timeoutError.errorType = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
