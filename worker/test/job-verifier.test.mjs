import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlToText, verifyJob } from '../src/job-verifier.mjs';

test('normalizes a live Greenhouse posting into a job record', async () => {
  const result = await verifyJob('https://boards.greenhouse.io/acme/jobs/123?utm_source=test', {
    fetchImpl: async (url) => {
      assert.equal(url.toString(), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123?content=true');
      return new Response(JSON.stringify({
        id: 123,
        title: 'Backend Engineer',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/123',
        location: { name: 'Remote — India' },
        updated_at: '2026-07-20T12:00:00Z',
        departments: [{ name: 'Engineering' }],
        offices: [{ name: 'Remote' }],
        content: '<p>Build APIs &amp; tools.</p><ul><li>Node.js</li></ul>'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.equal(result.liveness, 'live');
  assert.equal(result.job.stable_id, 'greenhouse:acme:123');
  assert.equal(result.job.description_text, 'Build APIs & tools.\nNode.js');
  assert.deepEqual(result.job.departments, ['Engineering']);
});

test('marks missing Greenhouse jobs closed and leaves unsupported sources unverified', async () => {
  const closed = await verifyJob('https://boards.greenhouse.io/acme/jobs/123', {
    fetchImpl: async () => new Response('', { status: 404 })
  });
  assert.equal(closed.liveness, 'closed');

  const manual = await verifyJob('https://careers.example.com/jobs/123');
  assert.equal(manual.verification_status, 'manual_review');
  assert.equal(manual.liveness, 'unverified');
});

test('normalizes live Lever and Ashby postings through their public APIs', async () => {
  const lever = await verifyJob('https://jobs.lever.co/acme/lever-1', {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.lever.co/v0/postings/acme/lever-1');
      return new Response(JSON.stringify({ text: 'Platform Engineer', hostedUrl: 'https://jobs.lever.co/acme/lever-1', categories: { location: 'Remote', team: 'Engineering' }, descriptionPlain: 'Build reliable APIs.' }), { status: 200 });
    }
  });
  assert.equal(lever.liveness, 'live');
  assert.equal(lever.job.stable_id, 'lever:acme:lever-1');

  const ashby = await verifyJob('https://jobs.ashbyhq.com/acme/ashby-1', {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.ashbyhq.com/posting-api/job-board/acme');
      return new Response(JSON.stringify({ jobs: [{ id: 'ashby-1', title: 'Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/ashby-1', applyUrl: 'https://jobs.ashbyhq.com/acme/ashby-1/application', location: 'Remote — India', department: 'Engineering', descriptionPlain: 'Build APIs.' }] }), { status: 200 });
    }
  });
  assert.equal(ashby.liveness, 'live');
  assert.equal(ashby.job.direct_application_url, 'https://jobs.ashbyhq.com/acme/ashby-1/application');
});

test('converts basic HTML into readable job text', () => {
  assert.equal(htmlToText('<h2>Role</h2><p>Use &lt;code&gt; safely.</p>'), 'Role\nUse <code> safely.');
});
