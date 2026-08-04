import { firecrawlSearch } from './firecrawl-client.mjs';

const JOB_BOARD_HOSTNAMES = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'ycombinator.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'wellfound.com', 'ambitionbox.com',
  'naukri.com', 'monster.com', 'simplyhired.com', 'builtin.com', 'crunchbase.com'
];

const hostnameOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

const isJobBoardHost = (hostname) => Boolean(hostname) && JOB_BOARD_HOSTNAMES.some((board) => hostname === board || hostname.endsWith(`.${board}`));

const isLinkedInCompanyUrl = (url) => {
  try {
    const parsed = new URL(url);
    return hostnameOf(url) === 'linkedin.com' && parsed.pathname.startsWith('/company/');
  } catch {
    return false;
  }
};

export const lookupCompany = async (companyName, { apiKey, fetchImpl } = {}) => {
  if (!companyName) return { website_url: null, linkedin_url: null };

  const [websiteResults, linkedinResults] = await Promise.all([
    firecrawlSearch(`${companyName} official website`, { apiKey, limit: 5, fetchImpl }).catch(() => []),
    firecrawlSearch(`${companyName} LinkedIn company page`, { apiKey, limit: 5, fetchImpl }).catch(() => [])
  ]);

  const website = websiteResults.find((result) => !isJobBoardHost(hostnameOf(result.url)));
  const linkedin = linkedinResults.find((result) => isLinkedInCompanyUrl(result.url));

  return {
    website_url: website?.url || null,
    linkedin_url: linkedin?.url || null
  };
};
