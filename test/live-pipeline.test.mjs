// The whole live path (collect -> plan -> verify -> report) against stand-in servers.
// SoDEX answers with the REAL capture in fixtures/; SoSoValue answers with the
// synthetic documented shapes. No network is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { main } from '../src/cli.mjs';
import { verifyPlan } from '../src/engine/plan.mjs';
import { syntheticSosovalue } from '../fixtures/synthetic.mjs';
import { fakeFetch, ROOT } from './helpers.mjs';

const KEY = 'sk_live_TEST_KEY_do_not_leak_9f3a';
const capture = JSON.parse(readFileSync(join(ROOT, 'fixtures/sodex-capture-2026-11-20.json'), 'utf8'));
const syn = syntheticSosovalue(capture.capturedAt, { bullish: true });
const env = (extra = {}) => ({ ...extra });

// opts.header: the header name the stand-in SoSoValue server accepts the key in.
// opts.forbid: SoSoValue paths (after /openapi/v1) that answer HTTP 403 like a key without access.
function servers({ header = 'x-soso-api-key', forbid = [] } = {}) {
  const sodex = capture.sodex;
  return fakeFetch((url, init) => {
    if (url.host === 'mainnet-gw.sodex.dev') {
      const p = url.pathname.replace('/api/v1/spot', '');
      if (p === '/markets/symbols') return { body: { code: 0, data: sodex.symbols } };
      if (p === '/markets/tickers') return { body: { code: 0, data: sodex.tickers } };
      let m = /^\/markets\/([^/]+)\/orderbook$/.exec(p);
      if (m) return { body: { code: 0, data: sodex.books[decodeURIComponent(m[1])] } };
      m = /^\/markets\/([^/]+)\/klines$/.exec(p);
      if (m) return { body: { code: 0, data: sodex.klines[decodeURIComponent(m[1])] } };
      return { status: 404, body: { code: -1, error: `no route ${p}` } };
    }
    if (url.host === 'openapi.sosovalue.com') {
      if (init.headers[header] !== KEY) return { status: 401, body: { code: 400101, message: 'Invalid API Key' } };
      const p = url.pathname.replace('/openapi/v1', '');
      if (forbid.includes(p)) return { status: 403, body: { code: 400301, message: 'Insufficient permissions' } };
      const ok = (data) => ({ body: { code: 0, message: 'success', data } });
      if (p === '/indices') return ok(syn.indices);
      let m = /^\/indices\/([^/]+)\/(klines|constituents|market-snapshot)$/.exec(p);
      if (m) {
        const d = syn.indexData[m[1].toLowerCase()];
        if (!d) return { status: 404, body: { code: 40401, message: 'unknown index' } };
        return ok(m[2] === 'klines' ? d.klines : m[2] === 'constituents' ? d.constituents : d.snapshot);
      }
      if (p === '/etfs/summary-history') return ok(syn.etf[url.searchParams.get('symbol')].US);
      if (p === '/news/hot') return ok(syn.newsHot);
      if (p === '/macro/events') return ok(syn.macroEvents);
      if (p === '/macro/fomc-probabilities') return ok(syn.fomc);
      if (p === '/market/overview') return ok(syn.overview);
    }
    return { status: 404, body: { code: -1, error: `no route ${url}` } };
  });
}

async function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

async function allFileText(dir) {
  let out = '';
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += await readFile(join(e.parentPath ?? e.path, e.name), 'utf8');
  }
  return out;
}

test('run: live pipeline with a key writes snapshot, plan and site, and the plan replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-run-'));
  const f = servers();
  const snapshotPath = join(dir, 'snap.json');
  const planPath = join(dir, 'plan.json');
  const site = join(dir, 'site');
  const code = await quiet(() =>
    main(['run', '--snapshot', snapshotPath, '--plan', planPath, '--site', site], { fetchImpl: f, env: env({ SOSOVALUE_API_KEY: KEY }), now: () => capture.capturedAt }),
  );
  assert.equal(code, 0);

  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(snapshot.schema, 'proofdesk.snapshot/1', 'the plan must not overwrite the snapshot');
  assert.equal(plan.schema, 'proofdesk.plan/1');
  assert.equal(snapshot.mode, 'live');
  assert.equal(snapshot.provenance.sosovalue, 'live openapi.sosovalue.com');
  assert.deepEqual(snapshot.sosovalue.errors, {}, JSON.stringify(snapshot.sosovalue.errors));
  assert.deepEqual(snapshot.sodex.errors, {});
  assert.equal(verifyPlan(plan, snapshot).ok, true);
  assert.equal(plan.regime.regime, 'RISK_ON');

  const html = await readFile(join(site, 'index.html'), 'utf8');
  assert.match(html, /class="banner live"/);
  assert.doesNotMatch(html, /FIXTURE DEMO/);

  // Request hygiene
  const soso = f.calls.filter((c) => new URL(c.url).host === 'openapi.sosovalue.com');
  assert.ok(soso.length >= 15 && soso.length <= 18, `SoSoValue calls: ${soso.length}`);
  assert.ok(f.calls.every((c) => c.init.method === 'GET'));
  assert.ok(soso.every((c) => c.init.headers['x-soso-api-key'] === KEY));
  assert.ok(f.calls.filter((c) => new URL(c.url).host !== 'openapi.sosovalue.com').every((c) => !c.init.headers['x-soso-api-key']), 'the key is never sent to SoDEX');
});

test('run: the API key never ends up in any written file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-leak-'));
  await quiet(() =>
    main(['run', '--snapshot', join(dir, 's.json'), '--plan', join(dir, 'p.json'), '--site', join(dir, 'site')], { fetchImpl: servers(), env: env({ SOSOVALUE_API_KEY: KEY }), now: () => capture.capturedAt }),
  );
  const text = await allFileText(dir);
  assert.ok(text.length > 100_000, 'sanity: we really scanned the outputs');
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes('x-soso-api-key'));
});

test('run: a rejected key (HTTP 401) aborts after one request and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-badkey-'));
  const f = servers();
  await assert.rejects(
    quiet(() =>
      main(['run', '--snapshot', join(dir, 's.json'), '--plan', join(dir, 'p.json'), '--site', join(dir, 'site')], { fetchImpl: f, env: env({ SOSOVALUE_API_KEY: 'wrong' }), now: () => capture.capturedAt }),
    ),
    (e) => /authentication failed/.test(e.message) && /x-soso-api-key/.test(e.message) && /SOSOVALUE_KEY_HEADER=X-API-KEY/.test(e.message) && !e.message.includes('wrong'),
  );
  const soso = f.calls.filter((c) => new URL(c.url).host === 'openapi.sosovalue.com');
  assert.equal(soso.length, 1, 'it must not burn the rate limit on 16 more doomed requests');
  assert.deepEqual(await readdir(dir), [], 'no snapshot, plan or site may be written, so a good earlier site is never overwritten');
});

test('run: a 403 on one endpoint is a data gap, the rest of the run continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-403-'));
  const code = await quiet(() =>
    main(['run', '--snapshot', join(dir, 's.json'), '--plan', join(dir, 'p.json'), '--site', join(dir, 'site')], { fetchImpl: servers({ forbid: ['/news/hot'] }), env: env({ SOSOVALUE_API_KEY: KEY }), now: () => capture.capturedAt }),
  );
  assert.equal(code, 0);
  const plan = JSON.parse(await readFile(join(dir, 'p.json'), 'utf8'));
  assert.ok(plan.dataGaps.some((g) => g.startsWith('SoSoValue news/hot') && /authentication failed/.test(g)));
  assert.equal(plan.signals.news.status, 'missing');
  assert.notEqual(plan.signals.flows.BTC.status, 'missing', 'other endpoints still feed the plan');
});

test('SOSOVALUE_KEY_HEADER moves the key to the other header and only that header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-hdr-'));
  const f = servers({ header: 'X-API-KEY' });
  const code = await quiet(() =>
    main(['run', '--snapshot', join(dir, 's.json'), '--plan', join(dir, 'p.json'), '--site', join(dir, 'site')], { fetchImpl: f, env: env({ SOSOVALUE_API_KEY: KEY, SOSOVALUE_KEY_HEADER: 'X-API-KEY' }), now: () => capture.capturedAt }),
  );
  assert.equal(code, 0);
  const soso = f.calls.filter((c) => new URL(c.url).host === 'openapi.sosovalue.com');
  assert.ok(soso.length >= 15);
  assert.ok(soso.every((c) => c.init.headers['X-API-KEY'] === KEY && c.init.headers['x-soso-api-key'] === undefined));
});

test('collect without a key skips SoSoValue entirely (no request leaves for that host)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-nokey-'));
  const f = servers();
  await quiet(() => main(['collect', '--out', join(dir, 's.json')], { fetchImpl: f, env: env(), now: () => capture.capturedAt }));
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((c) => new URL(c.url).host === 'mainnet-gw.sodex.dev'));
  const snap = JSON.parse(await readFile(join(dir, 's.json'), 'utf8'));
  assert.equal(snap.sosovalue, null);
  assert.match(snap.provenance.sosovalue, /absent/);
});
