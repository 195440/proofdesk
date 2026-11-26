// Snapshots: everything the engine is allowed to look at, frozen into one JSON
// document. The plan stores sha256(canonical(snapshot)), so a plan can only be
// replayed against the exact data it was made from.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SNAPSHOT_SCHEMA = 'proofdesk.snapshot/1';

const V1 = '/openapi/v1';

// One endpoint failing is a data gap, not a reason to stop. HTTP 401 is different: the key itself is
// rejected (invalid, expired, or applied for but not approved yet), so every remaining request would
// fail the same way and the result would be a "live" snapshot with the whole SoSoValue half missing.
// Abort instead, before anything is written. (403 means "this key may not call this endpoint" and
// stays a per-endpoint gap.)
async function safe(errors, key, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.kind === 'auth' && e.status === 401) throw e;
    errors[key] = String(e.message ?? e).slice(0, 300);
    return undefined;
  }
}

/** SoDEX public market data for the traded universe (no key needed). */
export async function collectSodex(client, cfg) {
  const errors = {};
  const out = { network: client.network, symbols: [], tickers: [], books: {}, klines: {}, errors };
  out.symbols = (await safe(errors, 'symbols', () => client.symbols())) ?? [];
  out.tickers = (await safe(errors, 'tickers', () => client.tickers())) ?? [];
  for (const a of cfg.universe) {
    const book = await safe(errors, `orderbook:${a.sodex}`, () => client.orderbook(a.sodex, 50));
    if (book) out.books[a.sodex] = book;
    if (a.momentum.source === 'sodex') {
      const k = await safe(errors, `klines:${a.sodex}`, () => client.klines(a.sodex, '1d', 100));
      if (k) out.klines[a.sodex] = k;
    }
  }
  return out;
}

/** SoSoValue Open API data. Needs a SosoClient (API key). Stays under 20 requests/min via the client. */
export async function collectSosovalue(client, cfg) {
  const errors = {};
  const out = { indices: [], indexData: {}, etf: {}, errors };

  out.indices = (await safe(errors, 'indices', () => client.get(`${V1}/indices`))) ?? [];
  const known = new Map(out.indices.map((t) => [String(t).toLowerCase(), t]));

  for (const a of cfg.universe) {
    if (a.momentum.source !== 'sosovalue') continue;
    const key = a.momentum.index.toLowerCase();
    const ticker = known.get(key);
    if (!ticker) {
      errors[`index:${key}`] = `ticker not returned by /indices`;
      continue;
    }
    if (out.indexData[key]) continue;
    const klines = await safe(errors, `klines:${key}`, () =>
      client.get(`${V1}/indices/${encodeURIComponent(ticker)}/klines`, { interval: '1d', limit: 100 }),
    );
    const constituents = await safe(errors, `constituents:${key}`, () =>
      client.get(`${V1}/indices/${encodeURIComponent(ticker)}/constituents`),
    );
    const snap = await safe(errors, `market-snapshot:${key}`, () =>
      client.get(`${V1}/indices/${encodeURIComponent(ticker)}/market-snapshot`),
    );
    if (klines) out.indexData[key] = { klines, constituents: constituents ?? [], snapshot: snap ?? null };
  }

  const etfSymbols = [...new Set([...cfg.regime.voters, ...cfg.universe.map((a) => a.etf).filter(Boolean)])].sort();
  for (const sym of etfSymbols) {
    const rows = await safe(errors, `etf:${sym}`, () =>
      client.get(`${V1}/etfs/summary-history`, { symbol: sym, country_code: cfg.regime.country, limit: 60 }),
    );
    if (rows) (out.etf[sym] ??= {})[cfg.regime.country] = rows;
  }

  out.newsHot = await safe(errors, 'news/hot', () => client.get(`${V1}/news/hot`, { page: 1, page_size: 50 }));
  out.macroEvents = await safe(errors, 'macro/events', () => client.get(`${V1}/macro/events`));
  out.fomc = await safe(errors, 'macro/fomc-probabilities', () => client.get(`${V1}/macro/fomc-probabilities`));
  out.overview = await safe(errors, 'market/overview', () => client.get(`${V1}/market/overview`));
  out.requestCount = client.requestCount;
  return out;
}

export function assembleSnapshot({ createdAt, mode, provenance, sosovalue, sodex }) {
  return {
    schema: SNAPSHOT_SCHEMA,
    createdAt,
    mode, // 'live' | 'fixture'
    provenance,
    sosovalue: sosovalue ?? null,
    sodex: sodex ?? null,
  };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
