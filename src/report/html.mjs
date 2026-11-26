// Static, dependency-free HTML dashboard. The page also ships the engine
// (./src/...) so the "Replay" button re-runs the exact same code in the
// browser against ./data/snapshot.json and ./data/plan.json.

import { round } from '../signals/stats.mjs';

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const pct = (x, dp = 1) => `${round(x * 100, dp)}%`;
const usd = (x) => `$${round(x, 2).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function chart(bt) {
  const c = bt.curves;
  const W = 720;
  const H = 220;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const series = [
    ['Proofdesk rules', c.strategy, '#0f766e'],
    ['Equal-weight hold', c.equalWeight, '#9a6700'],
    ...(c.btc ? [['BTC hold', c.btc, '#6b7280']] : []),
  ];
  const all = series.flatMap(([, v]) => v);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const x = (i) => pad.l + (i / (c.dates.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const lines = series
    .map(([, v, col]) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${v.map((p, i) => `${round(x(i), 1)},${round(y(p), 1)}`).join(' ')}"/>`)
    .join('');
  const ticks = [lo, (lo + hi) / 2, hi]
    .map((v) => `<g><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7280">${round(v, 2)}</text></g>`)
    .join('');
  const legend = series
    .map(([n, , col], i) => `<g transform="translate(${pad.l + i * 170},${H - 6})"><rect width="12" height="3" y="-8" fill="${col}"/><text x="18" y="-4" font-size="11" fill="#374151">${esc(n)}</text></g>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Backtest equity curves" style="width:100%;height:auto">${ticks}${lines}${legend}</svg>`;
}

function backtestSection(bt, fixture) {
  if (bt.status !== 'ok') return `<p class="muted">Backtest skipped: ${esc(bt.reason)}</p>`;
  const row = (n, m) => (m ? `<tr><td>${esc(n)}</td><td>${pct(m.totalReturn)}</td><td>${pct(m.maxDrawdown)}</td></tr>` : '');
  return `
    ${fixture ? '<p class="warn">Fixture mode: the series mix synthetic SoSoValue indices with real SoDEX prices, so these numbers only demonstrate the mechanics.</p>' : ''}
    ${chart(bt)}
    <table><thead><tr><th>${esc(bt.startDate)} to ${esc(bt.endDate)} (${bt.days} days)</th><th>Return</th><th>Max drawdown</th></tr></thead><tbody>
      ${row('Proofdesk rules', bt.strategy)}${row('Equal-weight hold', bt.equalWeight)}${row('BTC hold', bt.btc)}
    </tbody></table>
    <p class="muted">${bt.rebalances} rebalances, total turnover ${bt.turnoverTotal}x NAV, costs ${pct(bt.costTotal, 2)} of NAV.</p>
    <ul class="muted">${bt.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
    <ul class="warn-list">${bt.caveats.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
}

export function renderHtml(plan, bt, snapshot) {
  const fixture = plan.inputs.mode === 'fixture';
  const when = new Date(plan.inputs.snapshotCreatedAt).toISOString().replace('.000Z', 'Z');
  const prov = snapshot?.provenance ?? {};
  const banner = fixture
    ? `<div class="banner fixture"><b>FIXTURE DEMO &mdash; not live market data.</b><br>SoDEX: ${esc(prov.sodex)}<br>SoSoValue: ${esc(prov.sosovalue)}</div>`
    : `<div class="banner live"><b>LIVE</b> snapshot taken ${esc(when)}<br>SoDEX: ${esc(prov.sodex)} &middot; SoSoValue: ${esc(prov.sosovalue)}</div>`;

  const gates = plan.gates
    .map((g) => `<li class="${g.fired ? 'fired' : ''}"><b>${esc(g.id)}</b> ${g.fired ? 'FIRED' : 'quiet'} &mdash; ${esc(g.detail)}<br><span class="muted">${esc(g.effect)}</span></li>`)
    .join('');

  const assets = plan.assets
    .map(
      (a) => `<tr>
      <td><b>${esc(a.id)}</b><br><span class="muted">${esc(a.symbol)}</span></td>
      <td>${a.score ?? 'n/a'}</td>
      <td><div class="bar"><i class="cur" style="width:${a.currentWeight * 100 * 2}%"></i></div><div class="bar"><i class="tgt" style="width:${a.targetWeight * 100 * 2}%"></i></div></td>
      <td>${pct(a.currentWeight)} &rarr; <b>${pct(a.targetWeight)}</b></td>
      <td>${esc(a.action)}${a.note ? `<br><span class="muted">${esc(a.note)}</span>` : ''}</td></tr>`,
    )
    .join('');

  const legs = plan.legs.length
    ? plan.legs
        .map((l) =>
          l.status === 'dropped'
            ? `<tr class="dropped"><td>${esc(l.side)} ${esc(l.asset)}</td><td colspan="5">dropped: ${esc(l.reason)}</td></tr>`
            : `<tr><td>${esc(l.side)} <b>${esc(l.asset)}</b></td><td>${esc(l.quantity)}</td><td>${usd(l.notionalUsd)}</td><td>${l.slippageBps} bps</td><td>${usd(l.feeUsd)}</td><td>${esc(l.status)}${l.reason ? `<br><span class="muted">${esc(l.reason)}</span>` : ''}<br><span class="${l.preflight === 'pass' ? 'ok' : 'bad'}">preflight ${esc(Array.isArray(l.preflight) ? l.preflight.join('; ') : l.preflight)}</span></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">No trades: holdings are already inside the no-trade band of the target.</td></tr>';

  const claims = plan.claims
    .map(
      (c) => `<details><summary>${esc(c.text)}</summary><table class="rc">${(c.evidence ?? [])
        .map((e) => `<tr><td><code>${esc(e.path)}</code></td><td>${esc(typeof e.value === 'object' ? JSON.stringify(e.value) : e.value)}</td></tr>`)
        .join('')}</table></details>`,
    )
    .join('');

  const gaps = plan.dataGaps.length ? `<ul>${plan.dataGaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '<p class="muted">None: every input was available.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proofdesk &mdash; a rebalancing desk where every trade carries receipts</title>
<style>
:root{--ink:#111827;--mut:#6b7280;--line:#e5e7eb;--acc:#0f766e;--bg:#fafaf9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px;font-size:28px}h2{margin:32px 0 8px;font-size:18px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--mut);margin:0 0 16px}.muted{color:var(--mut);font-size:13px}
.banner{padding:10px 14px;border-radius:8px;margin:12px 0;font-size:13px}.banner.fixture{background:#fef2f2;border:1px solid #fca5a5;color:#7f1d1d}.banner.live{background:#ecfdf5;border:1px solid #6ee7b7;color:#064e3b}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b.big{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f3f4f6;font-weight:600;font-size:13px}
.bar{height:6px;background:#f3f4f6;border-radius:3px;margin:3px 0;min-width:120px}.bar i{display:block;height:6px;border-radius:3px}.bar .cur{background:#9ca3af}.bar .tgt{background:var(--acc)}
ul.gates{list-style:none;padding:0;margin:0}ul.gates li{background:#fff;border:1px solid var(--line);border-left:4px solid #d1d5db;border-radius:6px;padding:8px 12px;margin:6px 0}ul.gates li.fired{border-left-color:#b45309;background:#fffbeb}
tr.dropped td{color:#991b1b;background:#fef2f2}.ok{color:#047857}.bad{color:#b91c1c}.warn{background:#fffbeb;border:1px solid #fcd34d;padding:8px 12px;border-radius:6px;font-size:13px}.warn-list{color:#92400e;font-size:13px}
details{background:#fff;border:1px solid var(--line);border-radius:6px;margin:6px 0;padding:6px 10px}summary{cursor:pointer}table.rc{margin-top:8px;font-size:12px}code{font-size:12px;word-break:break-all}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;margin-right:8px}button.alt{background:#7f1d1d}
pre{background:#0b1020;color:#d1fae5;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}
.hash{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
</style></head><body><main>
<h1>Proofdesk</h1>
<p class="sub">A rebalancing desk where every trade carries receipts. SoSoValue signals &rarr; risk gates &rarr; SoDEX depth-checked orders, replayable byte for byte.</p>
${banner}

<h2>1. The call</h2>
<div class="cards">
  <div class="card"><span class="muted">Market regime (spot-ETF flows)</span><b class="big">${esc(plan.regime.regime)}</b><span class="muted">${plan.regime.status === 'ok' ? `flow z ${round(plan.regime.z, 2)} &middot; voters ${esc(plan.regime.voters.join('+'))}` : esc(plan.regime.reason)}</span></div>
  <div class="card"><span class="muted">Risk budget</span><b class="big">${pct(plan.riskBudget.base, 0)} &rarr; ${pct(plan.riskBudget.final, 0)}</b><span class="muted">${esc(plan.riskBudget.steps.map((s) => s.step).join(' > '))}</span></div>
  <div class="card"><span class="muted">Target cash</span><b class="big">${pct(plan.target.cashWeight)}</b><span class="muted">NAV ${usd(plan.summary.navUsd)}</span></div>
  <div class="card"><span class="muted">Expected cost of this rebalance</span><b class="big">${usd(plan.summary.expectedCostUsd)}</b><span class="muted">fees ${usd(plan.summary.expectedFeeUsd)} + slippage ${usd(plan.summary.expectedSlippageUsd)}</span></div>
</div>
<h2>2. Risk gates</h2>
<ul class="gates">${gates}</ul>

<h2>3. Target allocation</h2>
<table><thead><tr><th>Asset</th><th>Score</th><th>Current / target</th><th>Weight</th><th>Action</th></tr></thead><tbody>${assets}</tbody></table>
<p class="muted">Score = risk-adjusted 30d/7d momentum (SSI assets from SoSoValue index klines, majors from SoDEX klines) + ETF-flow tilt. Long-only, max weight ${pct(plan.inputs.config.allocation.maxWeight, 0)}, no-trade band ${pct(plan.inputs.config.allocation.noTradeBand, 0)}, turnover cap ${pct(plan.inputs.config.allocation.maxTurnover, 0)}.</p>

<h2>4. Orders, checked against the live SoDEX book</h2>
<table><thead><tr><th>Leg</th><th>Quantity</th><th>Notional</th><th>Slippage vs mid</th><th>Taker fee</th><th>Status</th></tr></thead><tbody>${legs}</tbody></table>
<p class="muted">Each leg walks the order book, is shrunk to fit ${plan.inputs.config.execution.maxSlippageBps} bps slippage and ${pct(plan.inputs.config.execution.maxShareOfDailyVolume, 0)} of 24h volume, and must pass SoDEX's own price / lot / notional filters. The unsigned <code>BatchNewOrderRequest</code> is in <a href="data/plan.json">plan.json</a> under <code>orders</code>. Proofdesk never signs or sends orders.</p>

<h2>5. Receipts</h2>
<p class="muted">Every claim below lists the snapshot field and value it rests on. Open one to see it.</p>
${claims}

<h2>6. Replay it yourself</h2>
<p>Snapshot <span class="hash">${esc(plan.inputs.snapshotHash)}</span><br>Plan <span class="hash">${esc(plan.planHash)}</span></p>
<p><button id="replay">Replay in this browser</button><button id="tamper" class="alt">Change one number, then replay</button></p>
<pre id="replay-out">Click a button. The engine in ./src runs here, on ./data/snapshot.json, and checks the hashes and every receipt above.</pre>
<p class="muted">Or from a terminal: <code>node src/cli.mjs verify --snapshot data/snapshot.json --plan data/plan.json</code></p>

<h2>7. Backtest (price-only part of the rules)</h2>
${backtestSection(bt, fixture)}

<h2>8. Data gaps</h2>
${gaps}

<script type="module">
const out = document.getElementById('replay-out');
const fmt = (r, ms, note) => r.checks.map((c) => (c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  ' + c.detail : '')).join('\\n')
  + '\\n\\n' + (r.ok ? 'VERIFIED' : 'NOT VERIFIED') + ' (' + ms + ' ms, computed in your browser' + (note ? '; ' + note : '') + ')';
async function load() {
  const [{ verifyPlan }, snap, plan] = await Promise.all([
    import('./src/engine/plan.mjs'),
    fetch('./data/snapshot.json').then((r) => r.json()),
    fetch('./data/plan.json').then((r) => r.json()),
  ]);
  return { verifyPlan, snap, plan };
}
function setPath(root, path, value) {
  const steps = [];
  for (const part of path.split('.')) { const re = /([^[\\]]+)|\\[(\\d+)\\]/g; let m; while ((m = re.exec(part))) steps.push(m[1] !== undefined ? m[1] : Number(m[2])); }
  let cur = root; for (const s of steps.slice(0, -1)) cur = cur[s]; cur[steps[steps.length - 1]] = value;
}
async function run(tamper) {
  out.textContent = 'running...';
  try {
    const { verifyPlan, snap, plan } = await load();
    let note = '';
    if (tamper) {
      const ev = plan.claims.flatMap((c) => c.evidence || []).find((e) => typeof e.value === 'number');
      if (ev) { setPath(snap, ev.path, ev.value + 1); note = 'changed ' + ev.path + ' from ' + ev.value + ' to ' + (ev.value + 1) + ' in memory only'; }
    }
    const t0 = performance.now();
    const r = verifyPlan(plan, snap);
    out.textContent = fmt(r, Math.round(performance.now() - t0), note);
  } catch (e) {
    out.textContent = 'Could not replay: ' + e.message + '\\nIf you opened this file directly from disk, serve the folder over http (python3 -m http.server) or use the hosted page.';
  }
}
document.getElementById('replay').addEventListener('click', () => run(false));
document.getElementById('tamper').addEventListener('click', () => run(true));
</script>
</main></body></html>
`;
}
