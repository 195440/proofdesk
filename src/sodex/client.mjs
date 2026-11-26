// SoDEX public market-data client (unsigned reads, no API key needed).
//   mainnet  https://mainnet-gw.sodex.dev/api/v1/spot
//   testnet  https://testnet-gw.sodex.dev/api/v1/spot
// Proofdesk only reads market data here. It never signs or sends orders.

export const SODEX_ENDPOINTS = Object.freeze({
  mainnet: 'https://mainnet-gw.sodex.dev/api/v1/spot',
  testnet: 'https://testnet-gw.sodex.dev/api/v1/spot',
});

export class SodexError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.name = 'SodexError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

export class SodexClient {
  constructor({ network = 'mainnet', baseUrl, fetchImpl = globalThis.fetch } = {}) {
    this.network = network;
    this.baseUrl = (baseUrl ?? SODEX_ENDPOINTS[network]).replace(/\/+$/, '');
    if (!this.baseUrl) throw new SodexError(`unknown SoDEX network: ${network}`);
    this.fetchImpl = fetchImpl;
  }

  async get(path, query = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (e) {
      throw new SodexError(`network error on ${path}: ${e.message}`, { path });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body || body.code !== 0) {
      throw new SodexError(`${path}: ${body?.error ?? body?.message ?? `HTTP ${res.status}`}`, {
        status: res.status,
        code: body?.code,
        path,
      });
    }
    return body.data;
  }

  symbols() {
    return this.get('/markets/symbols');
  }
  tickers() {
    return this.get('/markets/tickers');
  }
  orderbook(symbol, limit = 50) {
    return this.get(`/markets/${encodeURIComponent(symbol)}/orderbook`, { limit });
  }
  klines(symbol, interval = '1d', limit = 100) {
    return this.get(`/markets/${encodeURIComponent(symbol)}/klines`, { interval, limit });
  }
}
