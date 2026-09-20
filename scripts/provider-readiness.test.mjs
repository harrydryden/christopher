import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerReadiness } from './provider-readiness.mjs';
const prices = { 'claude-haiku-4-5': { input: 1, output: 5 } };

test('a missing credential is blocked, not a successful skipped evaluation', async () => {
  for (const apiKey of [undefined, '', '   ']) {
    const result = await providerReadiness({ apiKey, models: Object.keys(prices), prices, fetcher: () => { throw new Error('must not fetch'); } });
    assert.equal(result.status, 'blocked');
  }
});

test('checks access to the chosen model and accepts its dated provider identity', async () => {
  const result = await providerReadiness({ apiKey: 'test-only', models: Object.keys(prices), prices,
    fetcher: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.anthropic.com');
      assert.equal(options.headers['x-api-key'], 'test-only');
      return Response.json({ id: 'claude-haiku-4-5-20251001' });
    } });
  assert.equal(result.status, 'passed');
  assert.equal(JSON.stringify(result).includes('test-only'), false);
});

test('denied access, wrong model, unknown pricing and an empty selection cannot pass', async () => {
  for (const response of [new Response(null, { status: 403 }), Response.json({id:'other'})]) {
    assert.equal((await providerReadiness({apiKey:'test',models:Object.keys(prices),prices,fetcher:async()=>response})).status, 'failed');
  }
  assert.equal((await providerReadiness({apiKey:'test',models:['unknown'],prices})).status,'failed');
  assert.equal((await providerReadiness({apiKey:'test',models:['bad-price'],prices:{'bad-price':{input:0,output:NaN}}})).status,'failed');
  assert.equal((await providerReadiness({apiKey:'test',models:[],prices})).status,'failed');
});
