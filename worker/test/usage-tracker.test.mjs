import assert from 'node:assert/strict';
import test from 'node:test';
import { getFirecrawlUsage, getApifyUsage } from '../src/usage-tracker.mjs';

test('getFirecrawlUsage returns null without an apiKey configured', async () => {
  const result = await getFirecrawlUsage({});
  assert.deepEqual(result, { error: 'Firecrawl API key is not configured' });
});

test('getFirecrawlUsage requests the team credit-usage endpoint and normalizes the response', async () => {
  const result = await getFirecrawlUsage({
    apiKey: 'fc-test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.firecrawl.dev/v2/team/credit-usage');
      assert.equal(init.headers.authorization, 'Bearer fc-test');
      return new Response(JSON.stringify({
        success: true,
        data: { remainingCredits: 1377, planCredits: 2000, billingPeriodStart: '2026-08-04T00:00:00.000Z', billingPeriodEnd: '2026-09-04T00:00:00.000Z' }
      }), { status: 200 });
    }
  });

  assert.deepEqual(result, {
    remaining_credits: 1377,
    plan_credits: 2000,
    billing_period_start: '2026-08-04T00:00:00.000Z',
    billing_period_end: '2026-09-04T00:00:00.000Z'
  });
});

test('getFirecrawlUsage degrades to an error object on a non-OK response', async () => {
  const result = await getFirecrawlUsage({
    apiKey: 'fc-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 })
  });
  assert.deepEqual(result, { error: 'Invalid token' });
});

test('getFirecrawlUsage degrades to an error object on a timeout instead of throwing', async () => {
  const result = await getFirecrawlUsage({
    apiKey: 'fc-test',
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  assert.deepEqual(result, { error: 'Firecrawl usage request timed out' });
});

test('getApifyUsage returns an error without an apiToken configured', async () => {
  const result = await getApifyUsage({});
  assert.deepEqual(result, { error: 'Apify API token is not configured' });
});

test('getApifyUsage requests the limits endpoint and normalizes the response', async () => {
  const result = await getApifyUsage({
    apiToken: 'apify-test',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.apify.com/v2/users/me/limits?token=apify-test');
      return new Response(JSON.stringify({
        data: {
          current: { monthlyUsageUsd: 0.18 },
          limits: { maxMonthlyUsageUsd: 5 },
          monthlyUsageCycle: { startAt: '2026-08-04T00:00:00.000Z', endAt: '2026-09-03T23:59:59.999Z' }
        }
      }), { status: 200 });
    }
  });

  assert.deepEqual(result, {
    monthly_usage_usd: 0.18,
    max_monthly_usage_usd: 5,
    cycle_start: '2026-08-04T00:00:00.000Z',
    cycle_end: '2026-09-03T23:59:59.999Z'
  });
});

test('getApifyUsage degrades to an error object on a non-OK response', async () => {
  const result = await getApifyUsage({
    apiToken: 'apify-test',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 })
  });
  assert.deepEqual(result, { error: 'Invalid token' });
});
