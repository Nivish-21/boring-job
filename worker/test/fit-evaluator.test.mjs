import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyResumeBucket } from '../src/fit-evaluator.mjs';

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
