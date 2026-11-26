import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clone } from '../src/canonical.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { syntheticSosovalue } from '../fixtures/synthetic.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const cfg = () => clone(DEFAULT_CONFIG);

export function demoSnapshot() {
  return JSON.parse(readFileSync(resolve(ROOT, 'fixtures/demo-snapshot.json'), 'utf8'));
}

/** Demo snapshot with the synthetic SoSoValue part swapped for the bearish variant. */
export function bearishSnapshot() {
  const s = demoSnapshot();
  s.sosovalue = syntheticSosovalue(s.createdAt, { bullish: false });
  return s;
}

/** A fetch stub: routes is a function (url: URL) => { status?, body, headers? } | Error. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = await routes(new URL(url), init, calls.length);
    if (r instanceof Error) throw r;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      json: async () => {
        if (r.raw !== undefined) throw new SyntaxError('not json');
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}
