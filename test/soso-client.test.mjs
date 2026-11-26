import test from 'node:test';
import assert from 'node:assert/strict';
import { SosoClient, SosoError } from '../src/soso/client.mjs';
import { fakeFetch } from './helpers.mjs';

const KEY = 'sk_test_SECRET_123';
const ok = (data) => ({ body: { code: 0, message: 'success', data } });

function client(fetchImpl, extra = {}) {
  let t = 1_000_000;
  const slept = [];
  const c = new SosoClient({
    apiKey: KEY,
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    ...extra,
  });
  c.slept = slept;
  c.clock = () => t;
  return c;
}

test('requires an API key', () => {
  assert.throws(() => new SosoClient({ apiKey: '' }), (e) => e instanceof SosoError && e.kind === 'auth');
});

test('sends x-soso-api-key, builds the URL with query, unwraps data', async () => {
  const f = fakeFetch(() => ok([{ date: '2026-11-19' }]));
  const c = client(f);
  const data = await c.get('/openapi/v1/etfs/summary-history', { symbol: 'BTC', country_code: 'US', limit: 60, skip: undefined });
  assert.deepEqual(data, [{ date: '2026-11-19' }]);
  const call = f.calls[0];
  assert.equal(call.init.headers['x-soso-api-key'], KEY);
  assert.equal(call.url, 'https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=60');
});

test('non-zero code throws a typed error and never leaks the key', async () => {
  const f = fakeFetch(() => ({ status: 400, body: { code: 400003, message: `Invalid parameter: symbol (key ${KEY})` } }));
  const c = client(f);
  await assert.rejects(c.get('/openapi/v1/etfs/summary-history'), (e) => {
    assert.equal(e.kind, 'bad_request');
    assert.equal(e.code, 400003);
    assert.ok(!e.message.includes(KEY), 'key must be scrubbed from the message');
    return true;
  });
});

test('401 is an auth error and is not retried', async () => {
  const f = fakeFetch(() => ({ status: 401, body: { code: 40101, message: 'bad key' } }));
  const c = client(f);
  await assert.rejects(c.get('/x'), (e) => e.kind === 'auth');
  assert.equal(f.calls.length, 1);
});

test('429 waits retry_after (+1s margin) then succeeds', async () => {
  const f = fakeFetch((_u, _i, n) =>
    n === 1 ? { status: 429, body: { code: 42901, message: 'Rate limit exceeded', details: { limit: 20, window: '60s', retry_after: 45 } } } : ok({ fine: true }),
  );
  const c = client(f);
  assert.deepEqual(await c.get('/x'), { fine: true });
  assert.equal(f.calls.length, 2);
  assert.ok(c.slept.includes(46_000), `expected a 46000ms wait, got ${c.slept}`);
});

test('429 forever gives up with kind rate_limit after maxRetries', async () => {
  const f = fakeFetch(() => ({ status: 429, body: { code: 42901, details: { retry_after: 1 } } }));
  const c = client(f, { maxRetries: 2 });
  await assert.rejects(c.get('/x'), (e) => e.kind === 'rate_limit');
  assert.equal(f.calls.length, 3);
});

test('local throttle never exceeds maxPerMinute inside any 60s window', async () => {
  const f = fakeFetch(() => ok(1));
  const stamps = [];
  const c = client(f, { maxPerMinute: 3 });
  for (let i = 0; i < 7; i += 1) {
    await c.get('/x');
    stamps.push(c.clock());
  }
  assert.equal(f.calls.length, 7);
  for (let i = 3; i < stamps.length; i += 1) {
    assert.ok(stamps[i] - stamps[i - 3] >= 60_000, `requests ${i - 3}..${i} fit in under 60s`);
  }
});

test('network errors are retried, then reported without the key', async () => {
  let n = 0;
  const f = fakeFetch(() => (++n < 3 ? new Error(`connect failed ${KEY}`) : ok('done')));
  const c = client(f);
  assert.equal(await c.get('/x'), 'done');

  const g = fakeFetch(() => new Error(`down ${KEY}`));
  const d = client(g, { maxRetries: 1 });
  await assert.rejects(d.get('/x'), (e) => e.kind === 'network' && !e.message.includes(KEY));
});

test('a body that is not the documented envelope is rejected', async () => {
  const f = fakeFetch(() => ({ body: { hello: 'world' } }));
  await assert.rejects(client(f).get('/x'), (e) => e.kind === 'envelope');
  const g = fakeFetch(() => ({ raw: 'html' }));
  await assert.rejects(client(g).get('/x'), (e) => e.kind === 'envelope');
});

test('5xx is retried', async () => {
  const f = fakeFetch((_u, _i, n) => (n < 3 ? { status: 503, body: null } : ok([1])));
  const c = client(f);
  assert.deepEqual(await c.get('/x'), [1]);
  assert.equal(f.calls.length, 3);
});
