import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyResumeBucket, selectVerifiedFacts } from '../src/fit-evaluator.mjs';

const job = { title: 'Backend Engineer', location: 'Remote', description_text: 'Build APIs with Node.js and Python.' };
const buckets = [
  { id: '01', target_role: 'Backend Software Engineer (Node.js/Python)', positioning_angle: 'Node + Python production build depth' },
  { id: '02', target_role: 'Founding Engineer', positioning_angle: '0→1 ownership' }
];

const chatResponse = (content) => async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body);
  assert.equal(body.response_format.type, 'json_object');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
};

test('returns the matched bucket id, confidence, and reason', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ bucket_id: '01', confidence: 0.9, reason: 'Strong Node/Python match' })
  });
  assert.deepEqual(result, { bucket_id: '01', confidence: 0.9, reason: 'Strong Node/Python match' });
});

test('rejects a bucket_id that is not in the provided bucket list', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ bucket_id: '99', confidence: 0.8, reason: 'hallucinated id' })
  });
  assert.equal(result.bucket_id, null);
});

test('clamps confidence into the 0-1 range', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ bucket_id: '01', confidence: 1.5, reason: 'over-confident' })
  });
  assert.equal(result.confidence, 1);
});

test('degrades to bucket_id null without throwing when the API key is missing', async () => {
  const result = await classifyResumeBucket(job, buckets, { fetchImpl: async () => new Response('{}') });
  assert.equal(result.bucket_id, null);
  assert.match(result.reason, /API key is not configured/);
});

test('degrades to bucket_id null without throwing on an empty bucket list', async () => {
  const result = await classifyResumeBucket(job, [], { apiKey: 'sk-test', fetchImpl: async () => new Response('{}') });
  assert.equal(result.bucket_id, null);
  assert.match(result.reason, /No resume buckets available/);
});

test('degrades to bucket_id null without throwing on an OpenAI HTTP error', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 429 })
  });
  assert.equal(result.bucket_id, null);
  assert.equal(result.reason, 'insufficient_quota');
});

test('degrades to bucket_id null without throwing on a request timeout', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  assert.equal(result.bucket_id, null);
  assert.equal(result.reason, 'OpenAI request timed out');
});

test('degrades to bucket_id null without throwing on malformed JSON content', async () => {
  const result = await classifyResumeBucket(job, buckets, {
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 })
  });
  assert.equal(result.bucket_id, null);
});

const resumeBucket = { id: '01', target_role: 'Backend Software Engineer', reference_text: 'Built production Node.js APIs. Operated Docker services in production.' };

test('selectVerifiedFacts returns the extracted facts and reason', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ facts: ['Built production Node.js APIs.', 'Operated Docker services in production.'], reason: 'Both directly match the job stack' })
  });
  assert.deepEqual(result, { facts: ['Built production Node.js APIs.', 'Operated Docker services in production.'], reason: 'Both directly match the job stack' });
});

test('selectVerifiedFacts caps facts at 5', async () => {
  const facts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ facts, reason: 'many facts' })
  });
  assert.equal(result.facts.length, 5);
});

test('selectVerifiedFacts filters out non-string entries', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: chatResponse({ facts: ['Real fact.', 42, null, ''], reason: 'mixed' })
  });
  assert.deepEqual(result.facts, ['Real fact.']);
});

test('selectVerifiedFacts degrades to empty facts without throwing when the API key is missing', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, { fetchImpl: async () => new Response('{}') });
  assert.deepEqual(result.facts, []);
  assert.match(result.reason, /API key is not configured/);
});

test('selectVerifiedFacts degrades to empty facts without throwing when no resumeBucket reference text is available', async () => {
  const result = await selectVerifiedFacts(job, { id: '01' }, { apiKey: 'sk-test', fetchImpl: async () => new Response('{}') });
  assert.deepEqual(result.facts, []);
  assert.match(result.reason, /No resume reference text available/);
});

test('selectVerifiedFacts degrades to empty facts without throwing on an OpenAI HTTP error', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 429 })
  });
  assert.deepEqual(result.facts, []);
  assert.equal(result.reason, 'insufficient_quota');
});

test('selectVerifiedFacts degrades to empty facts without throwing on a request timeout', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  assert.deepEqual(result.facts, []);
  assert.equal(result.reason, 'OpenAI request timed out');
});

test('selectVerifiedFacts degrades to empty facts without throwing on malformed JSON content', async () => {
  const result = await selectVerifiedFacts(job, resumeBucket, {
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 })
  });
  assert.deepEqual(result.facts, []);
});
