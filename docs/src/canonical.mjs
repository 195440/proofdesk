// Canonical JSON + hashing + tiny path resolver.
// Everything Proofdesk signs, hashes or replays goes through here, so that the
// same data always produces the same bytes.

import { sha256Text } from './sha256.mjs';

/** Deterministic JSON: object keys sorted, no whitespace, finite numbers only. */
export function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: non-finite number (${value})`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(text) {
  return sha256Text(text);
}

/** sha256 of the canonical JSON of `value`. */
export function hashOf(value) {
  return sha256Hex(canonicalize(value));
}

/**
 * Resolve a receipt path such as `sosovalue.etf.BTC.US[0].total_net_inflow`
 * against `root`. Returns `undefined` when any step is missing.
 */
export function getPath(root, path) {
  const steps = [];
  for (const part of String(path).split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      steps.push(m[1] !== undefined ? m[1] : Number(m[2]));
    }
  }
  let cur = root;
  for (const s of steps) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** Deep clone through JSON; keeps plans/snapshots free of shared references. */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
