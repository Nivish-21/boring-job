const API_BASE = 'https://api.firecrawl.dev/v2';
const requestTimeoutMs = 20_000;

const classifyError = (status) => {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  // 403 also covers per-URL "we don't support this site" rejections, not just
  // account-level quota — 'unknown' gets a short cooldown instead of disabling
  // the whole provider indefinitely on a single unrelated site.
  return 'unknown';
};

const post = async (path, body, { apiKey, fetchImpl = fetch }) => {
  if (!apiKey) throw new Error('Firecrawl API key is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error || `Firecrawl returned HTTP ${response.status}`);
      error.errorType = classifyError(response.status);
      throw error;
    }
    return json;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Firecrawl request timed out');
      timeoutError.errorType = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const firecrawlSearch = async (query, { apiKey, limit = 10, fetchImpl } = {}) => {
  const json = await post('/search', { query, limit }, { apiKey, fetchImpl });
  return (json?.data?.web || []).map((entry) => ({ url: entry.url, title: entry.title || '', description: entry.description || '' }));
};

export const firecrawlScrape = async (url, { apiKey, fetchImpl } = {}) => {
  const json = await post('/scrape', { url, formats: ['markdown'] }, { apiKey, fetchImpl });
  const data = json?.data || {};
  const metadata = data.metadata || {};
  return {
    markdown: data.markdown || '',
    title: metadata.title || metadata.ogTitle || ''
  };
};
