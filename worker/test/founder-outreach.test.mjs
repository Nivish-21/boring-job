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

test('draftOutreachMessage returns the drafted message and reason, using the mid-tier default model', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-5.6-terra');
      return chatResponse({ message: 'Hi Jane, ...', reason: 'Generic value-add message' })(url, init);
    }
  });
  assert.deepEqual(result, { message: 'Hi Jane, ...', reason: 'Generic value-add message' });
});

test('draftOutreachMessage nulls out a message that still contains a bracketed placeholder', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane, I have experience in [relevant area] and would love to chat.', reason: 'Generic outreach' })
  });
  assert.equal(result.message, null);
  assert.match(result.reason, /placeholder/);
});

test('draftOutreachMessage nulls out a message that uses a banned generic-opener phrase', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: "Hi Jane, I've been following your journey and am really impressed by your innovative approach.", reason: 'Generic outreach' })
  });
  assert.equal(result.message, null);
  assert.match(result.reason, /banned generic-opener phrase/);
});

test('draftOutreachMessage nulls out a message that uses a banned generic-closer phrase', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane, saw Nimbus is hiring, happy to hop on a call whenever works for you.', reason: 'Generic outreach' })
  });
  assert.equal(result.message, null);
  assert.match(result.reason, /banned generic-closer phrase/);
});

test('draftOutreachMessage passes through a message with a genuinely specific, reciprocal closing ask', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane, saw Nimbus is hiring a Backend Engineer, I\'ve got a few ideas on where scaling issues usually hide at this stage, happy to walk through what worked for us, got 15 minutes this week?', reason: 'Role-specific outreach' })
  });
  assert.equal(result.message, 'Hi Jane, saw Nimbus is hiring a Backend Engineer, I\'ve got a few ideas on where scaling issues usually hide at this stage, happy to walk through what worked for us, got 15 minutes this week?');
});

test('draftOutreachMessage nulls out a one-way extraction closer with no reciprocity', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane, saw Nimbus is hiring, would love to hear how you\'re thinking about scaling the team, would be good to swap notes sometime.', reason: 'Generic outreach' })
  });
  assert.equal(result.message, null);
  assert.match(result.reason, /generic-closer/);
});

test('draftOutreachMessage includes founderPostsContext in the prompt when given', async () => {
  let capturedUserContent;
  await draftOutreachMessage({ founder, founderPostsContext: 'Excited to announce our Series A' }, {
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      capturedUserContent = JSON.parse(init.body).messages.find((message) => message.role === 'user').content;
      return chatResponse({ message: 'Hi Jane', reason: '' })(url, init);
    }
  });
  assert.match(capturedUserContent, /Excited to announce our Series A/);
});

test('draftOutreachMessage tells the model absence of recent posts is normal when founderPostsContext is not given', async () => {
  let capturedUserContent;
  await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      capturedUserContent = JSON.parse(init.body).messages.find((message) => message.role === 'user').content;
      return chatResponse({ message: 'Hi Jane', reason: '' })(url, init);
    }
  });
  assert.match(capturedUserContent, /don't post regularly/);
});

test('draftOutreachMessage nulls out a message that uses an em dash', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: 'Hi Jane — saw Nimbus is hiring, would love to chat.', reason: 'Generic outreach' })
  });
  assert.equal(result.message, null);
  assert.match(result.reason, /em dash/);
});

test('draftOutreachMessage sends reasoning_effort: high in the request body', async () => {
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.reasoning_effort, 'high');
      return chatResponse({ message: 'Hi Jane, ...', reason: 'Generic value-add message' })(url, init);
    }
  });
  assert.equal(result.message, 'Hi Jane, ...');
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

test('draftOutreachMessage truncates a runaway-length message to 8,000 chars at a word boundary', async () => {
  const longMessage = 'This is a very long outreach message that keeps going and going far past any reasonable length '.repeat(90).trim();
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: longMessage, reason: 'Generic outreach' })
  });
  assert.ok(result.message.length <= 8_000);
  assert.notEqual(result.message.at(-1), ' ');
  assert.ok(longMessage.startsWith(result.message));
  assert.match(result.reason, /truncated to fit the 8000-character limit/);
});

test('draftOutreachMessage leaves a genuinely substantive ~800-char message untouched -- no artificial short cap remains', async () => {
  const substantiveMessage = 'Hi Jane, saw Nimbus is hiring a Senior Backend Engineer -- that caught my eye since I have spent the last 4 years building production Node and Python APIs at scale, most recently leading a rewrite of a payments service that cut p99 latency by roughly 40 percent under real production load. I would genuinely enjoy hearing more about what the role actually involves day to day, and specifically where the team feels its biggest technical bottleneck is right now, since that is usually the most useful thing to understand before a first conversation. Would you have 15 to 20 minutes this week for a call, or would a short set of async questions work better for your schedule instead?';
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: substantiveMessage, reason: 'Role-specific outreach' })
  });
  assert.equal(result.message, substantiveMessage);
  assert.equal(result.reason, 'Role-specific outreach');
});

test('draftOutreachMessage leaves a message at or under 8,000 chars untouched', async () => {
  const shortMessage = 'Hi Jane, saw Nimbus is hiring a backend engineer -- I have shipped production Node/Python systems and would love to chat about the role.';
  const result = await draftOutreachMessage({ founder }, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ message: shortMessage, reason: 'Role-specific outreach' })
  });
  assert.equal(result.message, shortMessage);
  assert.equal(result.reason, 'Role-specific outreach');
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
  return {
    created,
    async create(input) {
      const item = { id: `review-${created.length + 1}`, approval_id: `approval-${created.length + 1}`, status: 'pending', decisions: [], ...input };
      created.push(item);
      return item;
    },
    async list() { return created; },
    async decide(id, input) {
      const item = created.find((entry) => entry.id === id);
      if (!item) throw new Error('review item not found');
      if (item.approval_id !== input.approval_id) throw new Error('approval_id does not match this review item');
      item.status = input.action === 'approve' ? 'approved' : input.action === 'regenerate' ? 'pending' : 'rejected';
      item.decisions.push({ action: input.action, reason: input.reason, actor: input.actor });
      return item;
    }
  };
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

test('run fetches the founder\'s LinkedIn posts and filters out anything older than 12 months', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  const now = Date.now();
  const recent = new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const stale = new Date(now - 400 * 24 * 60 * 60 * 1_000).toISOString();
  let capturedContext;
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    apifyApiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([
      { content: 'Stale post from over a year ago', postedAt: { date: stale } },
      { content: 'Recent post about hiring', postedAt: { date: recent } }
    ]), { status: 200 }),
    draftMessage: async ({ founderPostsContext }) => { capturedContext = founderPostsContext; return { message: 'hi', reason: '' }; }
  });
  await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);
  assert.equal(capturedContext, 'Recent post about hiring');
});

test('run passes null founderPostsContext when the founder has no recent posts', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  let capturedContext = 'not set';
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    apifyApiToken: 'apify-test-token',
    fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 }),
    draftMessage: async ({ founderPostsContext }) => { capturedContext = founderPostsContext; return { message: 'hi', reason: '' }; }
  });
  await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);
  assert.equal(capturedContext, null);
});

test('run degrades to null founderPostsContext without throwing when no apifyApiToken is configured', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  let capturedContext = 'not set';
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async ({ founderPostsContext }) => { capturedContext = founderPostsContext; return { message: 'hi', reason: '' }; }
  });
  await runner.run([{ profile_url: 'https://www.linkedin.com/in/jane', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);
  assert.equal(capturedContext, null);
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

test('regenerateOne rejects the stale review item and creates a fresh one with a new draft', async () => {
  const founderStore = fakeFounderStore();
  const reviewStore = fakeReviewStore();
  let draftCallCount = 0;
  const runner = new FounderOutreachRunner({
    founderStore,
    reviewStore,
    pipeline: { process: async () => ({ stage: 'skipped' }) },
    lookupCompany: async () => ({ website_url: null, linkedin_url: null }),
    findCareers: async () => [],
    draftMessage: async () => {
      draftCallCount += 1;
      return draftCallCount === 1
        ? { message: 'Hi Vibhav, I have experience in [relevant area].', reason: 'Bad first draft' }
        : { message: 'Hi Vibhav, saw Playroot Golf is expanding -- worth a 15-min chat?', reason: 'Regenerated draft' };
    }
  });

  await runner.run([{ profile_url: 'https://www.linkedin.com/in/vibhav', first_name: 'Vibhav', last_name: 'Gadwal', company: 'Playroot Golf' }]);
  assert.equal(reviewStore.created.length, 1);
  const originalItemId = reviewStore.created[0].id;

  const regenerated = await runner.regenerateOne('https://www.linkedin.com/in/vibhav');

  assert.equal(reviewStore.created[reviewStore.created.findIndex((item) => item.id === originalItemId)].status, 'rejected');
  assert.equal(reviewStore.created.find((item) => item.id === originalItemId).decisions.at(-1).reason, 'Superseded by regenerated draft');
  assert.equal(reviewStore.created.length, 2);
  assert.equal(regenerated.draft, 'Hi Vibhav, saw Playroot Golf is expanding -- worth a 15-min chat?');

  const recorded = await founderStore.getByProfileUrl('https://www.linkedin.com/in/vibhav');
  assert.equal(recorded.review_item_id, regenerated.id);
  assert.notEqual(recorded.review_item_id, originalItemId);
});

test('regenerateOne throws when no founder record exists for the profile_url', async () => {
  const runner = new FounderOutreachRunner({ founderStore: fakeFounderStore(), reviewStore: fakeReviewStore() });
  await assert.rejects(() => runner.regenerateOne('https://www.linkedin.com/in/unknown'), /founder not found/);
});
