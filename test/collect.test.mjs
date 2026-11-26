import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSosovalue, collectSodex } from '../src/snapshot.mjs';
import { SodexClient } from '../src/sodex/client.mjs';
import { fakeFetch, cfg } from './helpers.mjs';
import { syntheticSosovalue } from '../fixtures/synthetic.mjs';

function fakeSoso(handler) {
  const calls = [];
  return {
    calls,
    requestCount: 0,
    async get(path, query) {
      calls.push({ path, query });
      this.requestCount += 1;
      return handler(path, query);
    },
  };
}

test('collectSosovalue calls the documented endpoints and stays inside one rate-limit window', async () => {
  const syn = syntheticSosovalue(Date.parse('2026-11-20T10:00:00Z'));
  const client = fakeSoso((path, q) => {
    if (path === '/openapi/v1/indices') return syn.indices;
    if (path.endsWith('/klines')) return syn.indexData.ssimag7.klines;
    if (path.endsWith('/constituents')) return [];
    if (path.endsWith('/market-snapshot')) return {};
    if (path === '/openapi/v1/etfs/summary-history') return syn.etf[q.symbol].US;
    if (path === '/openapi/v1/news/hot') return syn.newsHot;
    if (path === '/openapi/v1/macro/events') return syn.macroEvents;
    if (path === '/openapi/v1/macro/fomc-probabilities') return syn.fomc;
    if (path === '/openapi/v1/market/overview') return syn.overview;
    throw new Error(`unexpected ${path}`);
  });
  const out = await collectSosovalue(client, cfg());
  const paths = client.calls.map((c) => c.path);
  for (const p of ['/openapi/v1/indices', '/openapi/v1/news/hot', '/openapi/v1/macro/events', '/openapi/v1/macro/fomc-probabilities', '/openapi/v1/market/overview']) {
    assert.ok(paths.includes(p), `missing call ${p}`);
  }
  const etf = client.calls.filter((c) => c.path === '/openapi/v1/etfs/summary-history');
  assert.deepEqual(etf.map((c) => c.query.symbol).sort(), ['BTC', 'ETH', 'SOL']);
  assert.ok(etf.every((c) => c.query.country_code === 'US' && c.query.limit <= 300));
  const kl = client.calls.filter((c) => c.path.endsWith('/klines'));
  assert.ok(kl.every((c) => c.query.interval === '1d' && c.query.limit <= 500), 'only 1d klines exist and limit max is 500');
  assert.ok(client.calls.length <= 20, `${client.calls.length} calls would not fit in 20 requests/minute`);
  assert.deepEqual(Object.keys(out.errors), ['index:ssidefi', 'index:ssimeme'].filter((k) => out.errors[k]), 'only unknown tickers are reported');
  assert.ok(out.indexData.ssimag7);
});

test('collectSosovalue: one failing endpoint is recorded, the rest still arrive', async () => {
  const client = fakeSoso((path) => {
    if (path === '/openapi/v1/news/hot') throw new Error('HTTP 503');
    if (path === '/openapi/v1/indices') return [];
    if (path === '/openapi/v1/macro/events') return [];
    return null;
  });
  const out = await collectSosovalue(client, cfg());
  assert.match(out.errors['news/hot'], /503/);
  assert.deepEqual(out.macroEvents, []);
  assert.equal(out.newsHot, undefined);
});

test('collectSosovalue: tickers are matched case-insensitively against /indices', async () => {
  const client = fakeSoso((path) => {
    if (path === '/openapi/v1/indices') return ['ssiMAG7'];
    if (path.endsWith('/klines')) return [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1 }];
    return [];
  });
  const out = await collectSosovalue(client, cfg());
  assert.ok(out.indexData.ssimag7, 'stored under the lower-case key');
  assert.ok(client.calls.some((c) => c.path === '/openapi/v1/indices/ssiMAG7/klines'), 'requested with the casing the API returned');
});

test('collectSodex gathers symbols, tickers, books and klines (for sodex-sourced assets only)', async () => {
  const f = fakeFetch((url) => {
    const p = url.pathname;
    if (p.endsWith('/markets/symbols')) return { body: { code: 0, data: [{ name: 'vBTC_vUSDC' }] } };
    if (p.endsWith('/markets/tickers')) return { body: { code: 0, data: [{ symbol: 'vBTC_vUSDC' }] } };
    if (p.endsWith('/orderbook')) return { body: { code: 0, data: { bids: [['1', '1']], asks: [['2', '1']] } } };
    if (p.endsWith('/klines')) return { body: { code: 0, data: [{ t: 1, c: '1' }] } };
    return { status: 404, body: { code: -1, error: 'nope' } };
  });
  const out = await collectSodex(new SodexClient({ fetchImpl: f }), cfg());
  assert.equal(out.symbols.length, 1);
  assert.equal(Object.keys(out.books).length, 6);
  assert.deepEqual(Object.keys(out.klines).sort(), ['vBTC_vUSDC', 'vETH_vUSDC', 'vSOL_vUSDC']);
  assert.ok(f.calls.every((c) => c.init.method === 'GET'), 'read-only: only GET requests');
  assert.ok(f.calls.every((c) => !c.init.headers['x-soso-api-key']));
  assert.ok(f.calls.every((c) => c.url.startsWith('https://mainnet-gw.sodex.dev/api/v1/spot/')));
  assert.deepEqual(out.errors, {});
});

test('collectSodex: failures are recorded per endpoint', async () => {
  const f = fakeFetch((url) => (url.pathname.endsWith('/tickers') ? { status: 500, body: { code: -1, error: 'boom' } } : { body: { code: 0, data: [] } }));
  const out = await collectSodex(new SodexClient({ fetchImpl: f }), cfg());
  assert.match(out.errors.tickers, /boom/);
  assert.deepEqual(out.tickers, []);
});
