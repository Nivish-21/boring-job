import assert from 'node:assert/strict';
import test from 'node:test';
import { findCareersUrl, draftOutreachMessage, FounderOutreachRunner } from '../src/founder-outreach.mjs';

const founder = { first_name: 'Jane', last_name: 'Doe', position: 'Co-Founder', company: 'Nimbus Systems' };

test('findCareersUrl sorts ATS-board URLs before generic ones', async () => {
  const result = await findCareersUrl('Nimbus Systems', null, {
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { web: [
        { url: 'https://nimbus.systems/careers', title: 'Careers' },
        { url: 'https://boards.greenhouse.io/nimbus/jobs/1', title: 'Backend Engineer' }
      ] }
    }), { status: 200 })
  });
  assert.deepEqual(result, ['https://boards.greenhouse.io/nimbus/jobs/1', 'https://nimbus.systems/careers']);
});

test('findCareersUrl also searches the company\'s own domain when websiteUrl is known', async () => {
  const result = await findCareersUrl('Nimbus Systems', 'https://www.nimbus.systems', {
    apiKey: 'fc-test',
    fetchImpl: async (url, init) => {
      const { query } = JSON.parse(init.body);
      const web = query.includes('site:nimbus.systems') ? [{ url: 'https://nimbus.systems/careers', title: 'Careers' }] : [];
      return new Response(JSON.stringify({ success: true, data: { web } }), { status: 200 });
    }
  });
  assert.deepEqual(result, ['https://nimbus.systems/careers']);
});

test('findCareersUrl degrades to an empty list when Firecrawl search fails', async () => {
  const result = await findCareersUrl('Nimbus Systems', null, {
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
  });
  assert.deepEqual(result, []);
});

test('findCareersUrl returns an empty list when no companyName is given', async () => {
  const result = await findCareersUrl('', null, { apiKey: 'fc-test', fetchImpl: async () => new Response('{}') });
  assert.deepEqual(result, []);
});

const chatResponse = (content) => async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
};

test('draftOutreachMessage returns the drafted message and reason', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane, ...', reason: 'Generic value-add message' })
  });
  assert.deepEqual(result, { message: 'Hi Jane, ...', reason: 'Generic value-add message' });
});

test('draftOutreachMessage degrades to message null without throwing when the API key is missing', async () => {
  const result = await draftOutreachMessage({ founder }, { fetchImpl: async () => new Response('{}') });
  assert.equal(result.message, null);
  assert.match(result.reason, /API key is not configured/);
});

test('draftOutreachMessage degrades to message null without throwing when no founder is supplied', async () => {
  const result = await draftOutreachMessage({}, { apiKey: 'sk-test', fetchImpl: async () => new Response('{}') });
  assert.equal(result.message, null);
  assert.match(result.reason, /No founder supplied/);
});

test('draftOutreachMessage degrades to message null without throwing on an OpenAI HTTP error', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 429 })
  });
  assert.equal(result.message, null);
  assert.equal(result.reason, 'insufficient_quota');
});

test('draftOutreachMessage degrades to message null without throwing on a request timeout', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
  });
  assert.equal(result.message, null);
  assert.equal(result.reason, 'OpenAI request timed out');
});

const fakeFounderStore = () => {
  const records = new Map();
  return {
    records,
    async getByProfileUrl(url) { return records.get(url) || null; },
    async record(input) { records.set(input.profile_url, input); return input; }
  };
};

const fakeReviewStore = () => {
  const created = [];
  return { created, async create(input) { const item = { id: `review-${created.length + 1}`, ...input }; created.push(item); return item; } };
};

test('run skips founders with a non-http profile_url', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async () => ({ message: 'hi', reason: '' })
  });
  const summary = await runner.run([{ profile_url: 'not-a-url', company: 'Acme' }]);
  assert.deepEqual(summary, { processed: 0, stage_counts: { invalid_profile_url: 1 } });
  assert.equal(reviewStore.created.length, 0);
});

test('run skips a founder already recorded in founderStore', async () => {
  const founderStore = fakeFounderStore();
  await founderStore.record({ profile_url: 'https://www.linkedin.com/in/jane' });
  const reviewStore = fakeReviewStore();
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async () => ({ message: 'hi', reason: '' })
  });
  const summary = await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', company: 'Acme' }]);
  assert.deepEqual(summary, { processed: 0, stage_counts: { duplicate: 1 } });
  assert.equal(reviewStore.created.length, 0);
});

test('run stops processing new founders once cap is reached', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async () => ({ message: 'hi', reason: '' }),
    cap: 1
  });
  const founders = [
    { profile_url: 'https://www.linkedin.com/in/a', first_name: 'A', last_name: 'One', company: 'Acme' },
    { profile_url: 'https://www.linkedin.com/in/b', first_name: 'B', last_name: 'Two', company: 'Acme' }
  ];
  const summary = await runner.run(founders);
  assert.equal(summary.processed, 1);
  assert.equal(summary.stage_counts.cap_reached, 1);
  assert.equal(reviewStore.created.length, 1);
});

test('run stops trying careers URLs at the first needs_review match', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  const processed = [];
  const pipeline = {
    async process({ source_url: sourceUrl }) {
      processed.push(sourceUrl);
      if (sourceUrl === 'https://boards.greenhouse.io/acme/jobs/1') {
        return { stage: 'needs_review', verification: { job: { title: 'Backend Engineer', source_url: sourceUrl } } };
      }
      return { stage: 'skipped' };
    }
  };
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline,
    lookupCompany: async () => ({ website_url: 'https://acme.com', linkedin_url: null }),
    findCareers: async () => ['https://acme.com/careers', 'https://boards.greenhouse.io/acme/jobs/1', 'https://acme.com/other'],
    draftMessage: async ({ matchedJob }) => ({ message: `role: ${matchedJob?.title}`, reason: '' })
  });
  await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);
  assert.deepEqual(processed, ['https://acme.com/careers', 'https://boards.greenhouse.io/acme/jobs/1']);
  assert.equal(reviewStore.created[0].draft, 'role: Backend Engineer');
});

test('run always creates a review item and records the founder, even when drafting fails', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async () => ({ message: null, reason: 'OpenAI API key is not configured' })
  });
  await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);

  assert.equal(reviewStore.created.length, 1);
  assert.equal(reviewStore.created[0].draft, null);
  assert.match(reviewStore.created[0].summary, /OpenAI API key is not configured/);

  const recorded = await founderStore.getByProfileUrl('https://www.linkedin.com/in/jane');
  assert.equal(recorded.draft_error, 'OpenAI API key is not configured');
  assert.equal(recorded.review_item_id, 'review-1');
});
