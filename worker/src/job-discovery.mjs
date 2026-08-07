import { firecrawlSearch, firecrawlScrape } from './firecrawl-client.mjs';
import { apifyScrape } from './apify-client.mjs';
import { selectProvider } from './provider-selector.mjs';

const cooldownForError = (errorType) => {
  if (errorType === 'rate_limited') return 5 * 60 * 1_000;
  if (errorType === 'timeout' || errorType === 'unknown') return 15 * 60 * 1_000;
  return null;
};

// A scraped non-ATS page (company homepage, careers hub) has no guarantee it describes one
// specific open role -- its <title>/og:title is often just the site/company name. Reject that
// case rather than let a company homepage get evaluated and drafted as if it were a real posting
// (confirmed failure: https://latentforce.ai/ scraped title "Latentforce.ai" reached needs_review
// with a fabricated "Latentforce.ai role" application). Only catches the confirmed pattern --
// title empty, or title reducing to the bare hostname/company name -- not every possible bad
// scrape; a generic marketing-phrase title unrelated to the company name would need its own
// confirmed case before adding a heuristic for it.
const normalizeForComparison = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const looksLikeJobPosting = (title, sourceUrl) => {
  const normalizedTitle = normalizeForComparison(title);
  if (!normalizedTitle) return false;
  let hostname;
  try {
    hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    return true;
  }
  const normalizedHost = normalizeForComparison(hostname);
  if (normalizedTitle === normalizedHost) return false;
  if (normalizedHost.startsWith(normalizedTitle)) return false;
  return true;
};

const buildJobFromScrape = (selection, scrape) => ({
  ...selection,
  verification_status: 'checked',
  liveness: 'live',
  retrieved_at: new Date().toISOString(),
  job: {
    stable_id: `manual:${selection.source_url}`,
    title: scrape.title || null,
    source_url: selection.source_url,
    direct_application_url: selection.source_url,
    location: scrape.location || null,
    updated_at: null,
    departments: [],
    offices: [],
    description_html: '',
    description_text: (scrape.markdown || '').trim()
  }
});

export const discoverJobUrls = async (query, { apiKey, limit = 20, fetchImpl } = {}) => {
  const results = await firecrawlSearch(query, { apiKey, limit, fetchImpl });
  return results.map((result) => result.url);
};

export const verifyDiscoveredUrl = async (sourceUrl, { firecrawlApiKey, apifyApiToken, apifyActorId, providerState, fetchImpl } = {}) => {
  const selection = selectProvider(sourceUrl);
  if (selection.provider !== 'manual') {
    return {
      ...selection,
      liveness: 'unverified',
      verification_status: 'not_applicable',
      error: 'Discovered URL matches a supported ATS provider; use the primary verifier instead.'
    };
  }

  const firecrawlEnabled = !providerState || await providerState.isEnabled('firecrawl');
  if (firecrawlEnabled && firecrawlApiKey) {
    try {
      const scrape = await firecrawlScrape(selection.source_url, { apiKey: firecrawlApiKey, fetchImpl });
      if (providerState) await providerState.recordSuccess('firecrawl');
      if (scrape.markdown?.trim()) {
        if (!looksLikeJobPosting(scrape.title, selection.source_url)) {
          return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Scraped page title does not look like a specific job posting (likely a company homepage or careers hub, not a listing).' };
        }
        return buildJobFromScrape(selection, scrape);
      }
    } catch (error) {
      if (providerState) await providerState.recordFailure('firecrawl', { errorType: error.errorType || 'unknown', message: error.message, cooldownMs: cooldownForError(error.errorType) });
    }
  }

  const apifyEnabled = !providerState || await providerState.isEnabled('apify');
  if (apifyEnabled && apifyApiToken) {
    try {
      const scrape = await apifyScrape(selection.source_url, { apiToken: apifyApiToken, actorId: apifyActorId, fetchImpl });
      if (providerState) await providerState.recordSuccess('apify');
      if (scrape.markdown?.trim()) {
        if (!looksLikeJobPosting(scrape.title, selection.source_url)) {
          return { ...selection, liveness: 'unverified', verification_status: 'checked', error: 'Scraped page title does not look like a specific job posting (likely a company homepage or careers hub, not a listing).' };
        }
        return buildJobFromScrape(selection, scrape);
      }
    } catch (error) {
      if (providerState) await providerState.recordFailure('apify', { errorType: error.errorType || 'unknown', message: error.message, cooldownMs: cooldownForError(error.errorType) });
    }
  }

  return {
    ...selection,
    liveness: 'unverified',
    verification_status: 'checked',
    error: 'Both Firecrawl and Apify scrape fallbacks failed or are disabled.'
  };
};

export class DiscoveryRunner {
  constructor({ pipeline, discoverUrls = discoverJobUrls, query, apiKey, limit = 40, fetchImpl }) {
    Object.assign(this, { pipeline, discoverUrls, query, apiKey, limit, fetchImpl });
  }

  async run() {
    const urls = await this.discoverUrls(this.query, { apiKey: this.apiKey, limit: this.limit, fetchImpl: this.fetchImpl });
    const stageCounts = {};
    let processed = 0;

    for (const url of urls) {
      const result = await this.pipeline.process({ source_url: url });
      stageCounts[result.stage] = (stageCounts[result.stage] || 0) + 1;
      processed += 1;
      if (result.stage === 'daily_cap_reached') break;
    }

    return { discovered: urls.length, processed, stage_counts: stageCounts };
  }
}
