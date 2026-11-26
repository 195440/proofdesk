#!/usr/bin/env node
// proofdesk CLI
//   collect   [--out data/snapshot.json] [--network mainnet|testnet] [--sodex-only]
//   plan      [--snapshot data/snapshot.json] [--holdings file] [--nav USD] [--out data/plan.json]
//   verify    [--snapshot data/snapshot.json] [--plan data/plan.json]
//   backtest  [--snapshot data/snapshot.json]
//   report    [--snapshot ...] [--plan ...] [--out docs]
//   run       [--snapshot data/snapshot.json] [--plan data/plan.json] [--site docs]   collect + plan + report (live)
//   demo      same pipeline on the bundled fixture snapshot (no key, no network)

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from './config.mjs';
import { clone } from './canonical.mjs';
import { SosoClient } from './soso/client.mjs';
import { SodexClient } from './sodex/client.mjs';
import { assembleSnapshot, collectSodex, collectSosovalue, readJson, writeJson } from './snapshot.mjs';
import { buildPlan, verifyPlan } from './engine/plan.mjs';
import { runBacktest } from './engine/backtest.mjs';
import { renderText } from './report/text.mjs';
import { renderHtml } from './report/html.mjs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function loadEnv() {
  const p = resolve(process.cwd(), '.env');
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore malformed .env */
    }
  }
}

async function getConfig(args) {
  const cfg = args.config ? await readJson(resolve(args.config)) : clone(DEFAULT_CONFIG);
  if (args.nav) cfg.navUsd = Number(args.nav);
  return cfg;
}

// deps lets tests inject fetch / env / clock; production uses the defaults.
async function doCollect(args, outPath, deps = {}) {
  if (!deps.env) loadEnv();
  const env = deps.env ?? process.env;
  const cfg = await getConfig(args);
  const network = args.network ?? 'mainnet';
  const nowMs = (deps.now ?? Date.now)();
  const sodex = await collectSodex(new SodexClient({ network, fetchImpl: deps.fetchImpl }), cfg);
  let sosovalue = null;
  let provenance = { sodex: `live ${network} public REST`, sosovalue: 'absent (no SOSOVALUE_API_KEY, or --sodex-only)' };
  const key = env.SOSOVALUE_API_KEY;
  if (key && !args['sodex-only']) {
    const client = new SosoClient({ apiKey: key, keyHeader: env.SOSOVALUE_KEY_HEADER || undefined, fetchImpl: deps.fetchImpl });
    sosovalue = await collectSosovalue(client, cfg);
    provenance = { sodex: `live ${network} public REST`, sosovalue: 'live openapi.sosovalue.com' };
  } else {
    console.error('[collect] SoSoValue part skipped (set SOSOVALUE_API_KEY to enable it).');
  }
  const snapshot = assembleSnapshot({ createdAt: nowMs, mode: 'live', provenance, sosovalue, sodex });
  const out = resolve(outPath);
  await writeJson(out, snapshot);
  const gaps = [...Object.entries(sodex.errors), ...Object.entries(sosovalue?.errors ?? {})];
  console.error(`[collect] wrote ${out}${gaps.length ? ` with ${gaps.length} endpoint error(s)` : ''}`);
  for (const [k, e] of gaps) console.error(`  - ${k}: ${e}`);
  return snapshot;
}

async function doPlan(args, snapshotIn) {
  const cfg = await getConfig(args);
  const snapshot = snapshotIn ?? (await readJson(resolve(args.snapshot ?? 'data/snapshot.json')));
  const holdings = args.holdings ? await readJson(resolve(args.holdings)) : null;
  const plan = buildPlan(snapshot, cfg, holdings);
  if (args.out !== false) await writeJson(resolve(args.out ?? 'data/plan.json'), plan);
  return { plan, snapshot, cfg };
}

// Files the browser needs to replay a plan locally (no Node APIs, no network).
const BROWSER_ENGINE = [
  'canonical.mjs',
  'sha256.mjs',
  'assetSeries.mjs',
  'signals/flows.mjs',
  'signals/macro.mjs',
  'signals/momentum.mjs',
  'signals/news.mjs',
  'signals/series.mjs',
  'signals/stats.mjs',
  'engine/execution.mjs',
  'engine/plan.mjs',
];

async function doReport(plan, snapshot, cfg, outDir) {
  const bt = runBacktest(snapshot, cfg);
  const dir = resolve(outDir);
  await mkdir(resolve(dir, 'data'), { recursive: true });
  await writeJson(resolve(dir, 'data/snapshot.json'), snapshot);
  await writeJson(resolve(dir, 'data/plan.json'), plan);
  for (const f of BROWSER_ENGINE) {
    await mkdir(dirname(resolve(dir, 'src', f)), { recursive: true });
    await copyFile(resolve(ROOT, 'src', f), resolve(dir, 'src', f));
  }
  await writeFile(resolve(dir, 'index.html'), renderHtml(plan, bt, snapshot), 'utf8');
  console.error(`[report] wrote ${dir}/index.html (+ data/ and src/ for in-browser replay)`);
  return bt;
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case 'collect':
      await doCollect(args, args.out ?? 'data/snapshot.json', deps);
      return 0;
    case 'plan': {
      const { plan, snapshot, cfg } = await doPlan(args);
      console.log(renderText(plan, runBacktest(snapshot, cfg)));
      return 0;
    }
    case 'verify': {
      const snapshot = await readJson(resolve(args.snapshot ?? 'data/snapshot.json'));
      const plan = await readJson(resolve(args.plan ?? 'data/plan.json'));
      const r = verifyPlan(plan, snapshot);
      for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
      console.log(r.ok ? '\nVERIFIED: the plan is exactly what this snapshot produces.' : '\nNOT VERIFIED.');
      return r.ok ? 0 : 1;
    }
    case 'backtest': {
      const cfg = await getConfig(args);
      const snapshot = await readJson(resolve(args.snapshot ?? 'data/snapshot.json'));
      console.log(JSON.stringify(runBacktest(snapshot, cfg), null, 2));
      return 0;
    }
    case 'report': {
      const { plan, snapshot, cfg } = await doPlan({ ...args, out: false });
      const bt = await doReport(plan, snapshot, cfg, args.out ?? 'docs');
      console.log(renderText(plan, bt));
      return 0;
    }
    case 'run': {
      // run: --snapshot / --plan are where the intermediate files go, --site is the published folder.
      const snapshot = await doCollect(args, args.snapshot ?? 'data/snapshot.json', deps);
      const { plan, cfg } = await doPlan({ ...args, out: args.plan ?? 'data/plan.json' }, snapshot);
      const bt = await doReport(plan, snapshot, cfg, args.site ?? 'docs');
      console.log(renderText(plan, bt));
      return 0;
    }
    case 'demo': {
      const fixture = resolve(ROOT, 'fixtures/demo-snapshot.json');
      if (!existsSync(fixture)) {
        console.error('fixtures/demo-snapshot.json not found; run `node scripts/make-fixture.mjs` first.');
        return 1;
      }
      const snapshot = await readJson(fixture);
      const cfg = await getConfig(args);
      const { plan } = await doPlan({ ...args, out: false }, snapshot);
      const bt = await doReport(plan, snapshot, cfg, args.out ?? 'docs-demo');
      console.log(renderText(plan, bt));
      return 0;
    }
    default:
      console.error('usage: proofdesk <collect|plan|verify|backtest|report|run|demo> [options]  (see header of src/cli.mjs)');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    },
  );
}
