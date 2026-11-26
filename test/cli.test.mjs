import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const run = promisify(execFile);
const cli = (args, opts = {}) => run(process.execPath, [join(ROOT, 'src/cli.mjs'), ...args], { cwd: ROOT, ...opts });
const exists = (p) => access(p).then(() => true, () => false);

test('demo writes a site with data and the browser engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-demo-'));
  const { stdout } = await cli(['demo', '--out', dir]);
  assert.match(stdout, /Regime\s+RISK_ON/);
  assert.match(stdout, /mode=fixture/);
  for (const f of ['index.html', 'data/snapshot.json', 'data/plan.json', 'src/engine/plan.mjs', 'src/sha256.mjs']) {
    assert.ok(await exists(join(dir, f)), `missing ${f}`);
  }
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  assert.match(html, /FIXTURE DEMO/);
  assert.match(html, /not live market data/);
  const plan = JSON.parse(await readFile(join(dir, 'data/plan.json'), 'utf8'));
  assert.ok(html.includes(plan.planHash));
});

test('verify passes on a demo output and fails (exit 1) after tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pd-verify-'));
  await cli(['demo', '--out', dir]);
  const args = ['verify', '--snapshot', join(dir, 'data/snapshot.json'), '--plan', join(dir, 'data/plan.json')];
  const ok = await cli(args);
  assert.match(ok.stdout, /VERIFIED/);

  const snapPath = join(dir, 'data/snapshot.json');
  const snap = JSON.parse(await readFile(snapPath, 'utf8'));
  snap.sosovalue.overview.total_market_cap_change_pct = '-9.9';
  await writeFile(snapPath, JSON.stringify(snap));
  await assert.rejects(cli(args), (e) => {
    assert.equal(e.code, 1);
    assert.match(e.stdout, /NOT VERIFIED/);
    return true;
  });
});

test('unknown command prints usage and exits non-zero', async () => {
  await assert.rejects(cli(['nope']), (e) => {
    assert.equal(e.code, 2);
    assert.match(e.stderr, /usage: proofdesk/);
    return true;
  });
});
