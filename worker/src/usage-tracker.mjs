const FIRECRAWL_USAGE_URL = 'https://api.firecrawl.dev/v2/team/credit-usage';
const APIFY_LIMITS_URL = 'https://api.apify.com/v2/users/me/limits';
const requestTimeoutMs = 10_000;

const fetchWithTimeout = async (fetchImpl, url, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export const getFirecrawlUsage = async ({ apiKey, fetchImpl = fetch } = {}) => {
  if (!apiKey) return { error: 'Firecrawl API key is not configured' };
  try {
    const response = await fetchWithTimeout(fetchImpl, FIRECRAWL_USAGE_URL, { headers: { authorization: `Bearer ${apiKey}` } });
    const json = await response.json().catch(() => null);
    if (!response.ok) return { error: json?.error || `Firecrawl returned HTTP ${response.status}` };
    const data = json?.data || {};
    return {
      remaining_credits: data.remainingCredits ?? null,
      plan_credits: data.planCredits ?? null,
      billing_period_start: data.billingPeriodStart ?? null,
      billing_period_end: data.billingPeriodEnd ?? null
    };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'Firecrawl usage request timed out' : error.message };
  }
};

export const getApifyUsage = async ({ apiToken, fetchImpl = fetch } = {}) => {
  if (!apiToken) return { error: 'Apify API token is not configured' };
  try {
    const response = await fetchWithTimeout(fetchImpl, `${APIFY_LIMITS_URL}?token=${encodeURIComponent(apiToken)}`, {});
    const json = await response.json().catch(() => null);
    if (!response.ok) return { error: json?.error?.message || `Apify returned HTTP ${response.status}` };
    const data = json?.data || {};
    return {
      monthly_usage_usd: data.current?.monthlyUsageUsd ?? null,
      max_monthly_usage_usd: data.limits?.maxMonthlyUsageUsd ?? null,
      cycle_start: data.monthlyUsageCycle?.startAt ?? null,
      cycle_end: data.monthlyUsageCycle?.endAt ?? null
    };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'Apify usage request timed out' : error.message };
  }
};
