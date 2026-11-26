// Builds fixtures/demo-snapshot.json:
//   sodex      = REAL public capture (fixtures/sodex-capture-*.json)
//   sosovalue  = SYNTHETIC, shaped like the documented API (fixtures/synthetic.mjs)
// The snapshot is marked mode "fixture" and says so in `provenance`.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSosovalue } from '../fixtures/synthetic.mjs';
import { assembleSnapshot } from '../src/snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capture = JSON.parse(readFileSync(resolve(root, 'fixtures/sodex-capture-2026-11-20.json'), 'utf8'));

const snapshot = assembleSnapshot({
  createdAt: capture.capturedAt,
  mode: 'fixture',
  provenance: {
    sodex: `REAL: public SoDEX mainnet capture taken ${capture.capturedAtIso}`,
    sosovalue: 'SYNTHETIC: generated from a seeded PRNG in the documented response shapes. Not market data.',
  },
  sosovalue: syntheticSosovalue(capture.capturedAt, { bullish: true }),
  sodex: capture.sodex,
});

writeFileSync(resolve(root, 'fixtures/demo-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log('wrote fixtures/demo-snapshot.json');
