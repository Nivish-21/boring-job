import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupCompany } from '../src/company-lookup.mjs';

const respondFor = (websiteResults, linkedinResults) => async (url, init) => {
  const { query } = JSON.parse(init.body);
  const web = query.includes('LinkedIn company page') ? linkedinResults : websiteResults;
  return new Response(JSON.stringify({ success: true, data: { web } }), { status: 200 });
};

test('skips job-board domains and picks the first genuine company website', async () => {
  const result = await lookupCompany('Acme Robotics', {
    apiKey: 'fc-test',
    fetchImpl: respondFor(
      [
        { url: 'https://www.linkedin.com/jobs/view/123', title: 'Acme Robotics hiring' },
        { url: 'https://acme.com', title: 'Acme Robotics — Official Site' }
      ],
      []
    )
  });
  assert.equal(result.website_url, 'https://acme.com');
});

test('picks a linkedin.com/company/ URL, ignoring job or personal profile links', async () => {
  const result = await lookupCompany('Acme Robotics', {
    apiKey: 'fc-test',
    fetchImpl: respondFor(
      [],
      [
        { url: 'https://www.linkedin.com/in/some-person', title: 'Some Person' },
        { url: 'https://www.linkedin.com/company/acme-robotics', title: 'Acme Robotics | LinkedIn' }
      ]
    )
  });
  assert.equal(result.linkedin_url, 'https://www.linkedin.com/company/acme-robotics');
});

test('returns nulls when no companyName is given', async () => {
  const result = await lookupCompany('', { apiKey: 'fc-test', fetchImpl: async () => new Response('{}') });
  assert.deepEqual(result, { website_url: null, linkedin_url: null });
});

test('degrades gracefully to nulls when both Firecrawl searches fail', async () => {
  const result = await lookupCompany('Acme Robotics', {
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
  });
  assert.deepEqual(result, { website_url: null, linkedin_url: null });
});

test('returns nulls when no result passes the filter', async () => {
  const result = await lookupCompany('Acme Robotics', {
    apiKey: 'fc-test',
    fetchImpl: respondFor(
      [{ url: 'https://www.indeed.com/jobs/acme', title: 'Acme jobs' }],
      [{ url: 'https://www.linkedin.com/in/someone', title: 'Someone' }]
    )
  });
  assert.deepEqual(result, { website_url: null, linkedin_url: null });
});
