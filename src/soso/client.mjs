// SoSoValue Open API client.
//   server  https://openapi.sosovalue.com   (paths start with /openapi/v1 or /openapi/v3)
//   auth    header `x-soso-api-key` (override with the keyHeader option / SOSOVALUE_KEY_HEADER)
//   shape   { code, message, data }; code 0 = success
//   limits  20 requests / minute / key (HTTP 429, code 42901, details.retry_after seconds)
// The key is only ever placed in the request header. It is never logged and is
// scrubbed from every error message this module throws.

export class SosoError extends Error {
  constructor(message, { kind, status, code, path } = {}) {
    super(message);
    this.name = 'SosoError';
    this.kind = kind ?? 'api'; // auth | rate_limit | bad_request | not_found | api | network | envelope
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DEFAULT_KEY_HEADER = 'x-soso-api-key';

export class SosoClient {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {string} [o.baseUrl]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {(ms:number)=>Promise<void>} [o.sleep]
   * @param {()=>number} [o.now]
   * @param {number} [o.maxPerMinute]  stay under the documented 20/min
   * @param {number} [o.maxRetries]
   */
  constructor({
    apiKey,
    baseUrl = 'https://openapi.sosovalue.com',
    keyHeader = DEFAULT_KEY_HEADER,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    maxPerMinute = 18,
    maxRetries = 3,
  } = {}) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new SosoError('SOSOVALUE_API_KEY is required for live SoSoValue data', { kind: 'auth' });
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.keyHeader = keyHeader;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.maxPerMinute = maxPerMinute;
    this.maxRetries = maxRetries;
    this.sent = []; // timestamps (ms) of requests inside the sliding window
    this.requestCount = 0;
  }

  scrub(text) {
    return String(text).split(this.apiKey).join('***');
  }

  async #throttle() {
    for (;;) {
      const t = this.now();
      this.sent = this.sent.filter((s) => t - s < 60_000);
      if (this.sent.length < this.maxPerMinute) {
        this.sent.push(t);
        return;
      }
      const wait = 60_000 - (t - this.sent[0]) + 5;
      await this.sleep(wait);
    }
  }

  /** GET `path` (e.g. `/openapi/v1/indices`) and return the unwrapped `data`. */
  async get(path, query = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.#throttle();
      this.requestCount += 1;
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { [this.keyHeader]: this.apiKey, accept: 'application/json' },
        });
      } catch (e) {
        lastErr = new SosoError(this.scrub(`network error on ${path}: ${e.message}`), { kind: 'network', path });
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status === 429) {
        const retryAfter = Number(body?.details?.retry_after);
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000 + 1000;
        lastErr = new SosoError(`rate limited on ${path}`, { kind: 'rate_limit', status: 429, code: body?.code, path });
        // The server told us its window is exhausted; our local window is stale.
        this.sent = [];
        if (attempt < this.maxRetries) {
          await this.sleep(waitMs);
          continue;
        }
        throw lastErr;
      }
      if (res.status === 401 || res.status === 403) {
        // The key is only ever sent in `keyHeader`. The published docs are not consistent about its name
        // (OpenAPI and curl examples say x-soso-api-key; one error example says X-API-KEY), so say which
        // one was used and how to try the other. A key that was applied for but not yet approved also lands here.
        const alt = this.keyHeader.toLowerCase() === DEFAULT_KEY_HEADER ? 'X-API-KEY' : DEFAULT_KEY_HEADER;
        throw new SosoError(
          `authentication failed on ${path} (HTTP ${res.status}); sent header "${this.keyHeader}". ` +
            `Check that the key is approved on the SoSoValue developer dashboard, or try SOSOVALUE_KEY_HEADER=${alt}`,
          { kind: 'auth', status: res.status, code: body?.code, path },
        );
      }
      if (res.status >= 500) {
        lastErr = new SosoError(`server error on ${path} (HTTP ${res.status})`, { status: res.status, path });
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (!body || typeof body !== 'object' || typeof body.code !== 'number') {
        throw new SosoError(`unexpected response envelope on ${path} (HTTP ${res.status})`, {
          kind: 'envelope',
          status: res.status,
          path,
        });
      }
      if (body.code !== 0) {
        const kind = res.status === 404 ? 'not_found' : res.status === 400 ? 'bad_request' : 'api';
        throw new SosoError(this.scrub(`${path}: ${body.message ?? 'error'} (code ${body.code})`), {
          kind,
          status: res.status,
          code: body.code,
          path,
        });
      }
      return body.data;
    }
    throw lastErr ?? new SosoError(`request failed: ${path}`, { path });
  }
}
