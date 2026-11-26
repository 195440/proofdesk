// Plain-text brief for the terminal.

import { round } from '../signals/stats.mjs';

const pct = (x, dp = 1) => `${round(x * 100, dp)}%`;

export function renderText(plan, bt) {
  const L = [];
  const p = plan;
  L.push(`PROOFDESK  mode=${p.inputs.mode}  snapshot=${new Date(p.inputs.snapshotCreatedAt).toISOString()}`);
  L.push(`snapshotHash ${p.inputs.snapshotHash}`);
  L.push(`planHash     ${p.planHash}`);
  L.push('');
  L.push(`Regime        ${p.regime.regime}${p.regime.status === 'ok' ? `  (flow z ${round(p.regime.z, 2)}, voters ${p.regime.voters.join('+')})` : `  (${p.regime.reason})`}`);
  L.push(`Risk budget   base ${pct(p.riskBudget.base, 0)} -> final ${pct(p.riskBudget.final, 0)}   ${p.riskBudget.steps.map((s) => s.step).join(' > ')}`);
  for (const g of p.gates) L.push(`  gate ${g.fired ? 'FIRED ' : 'quiet '} ${g.id}: ${g.detail}`);
  L.push('');
  L.push('Asset            score  cur    tgt    action');
  for (const a of p.assets) {
    L.push(
      `${a.id.padEnd(16)} ${String(a.score ?? 'n/a').padStart(6)} ${pct(a.currentWeight).padStart(6)} ${pct(a.targetWeight).padStart(6)}  ${a.action}${a.note ? `  [${a.note}]` : ''}`,
    );
  }
  L.push(`cash target ${pct(p.target.cashWeight)}`);
  L.push('');
  if (p.legs.length === 0) L.push('No trades.');
  for (const l of p.legs) {
    L.push(
      l.status === 'dropped'
        ? `  ${l.side.padEnd(4)} ${l.asset}: DROPPED (${l.reason})`
        : `  ${l.side.padEnd(4)} ${l.asset}: qty ${l.quantity} ~${l.notionalUsd} USD vwap ${l.expectedVwap} slip ${l.slippageBps}bps fee ${l.feeUsd} [${l.status}${l.reason ? `: ${l.reason}` : ''}] preflight ${Array.isArray(l.preflight) ? l.preflight.join('; ') : l.preflight}`,
    );
  }
  L.push(`expected cost ${p.summary.expectedCostUsd} USD (fees ${p.summary.expectedFeeUsd} + slippage ${p.summary.expectedSlippageUsd})`);
  if (p.dataGaps.length) {
    L.push('');
    L.push('Data gaps:');
    for (const g of p.dataGaps) L.push(`  - ${g}`);
  }
  if (bt) {
    L.push('');
    if (bt.status === 'ok') {
      L.push(`Backtest ${bt.startDate}..${bt.endDate} (${bt.days}d, ${bt.rebalances} rebalances, turnover ${bt.turnoverTotal})`);
      L.push(`  strategy ${pct(bt.strategy.totalReturn)} maxDD ${pct(bt.strategy.maxDrawdown)} | equal-weight ${pct(bt.equalWeight.totalReturn)} maxDD ${pct(bt.equalWeight.maxDrawdown)}${bt.btc ? ` | BTC ${pct(bt.btc.totalReturn)} maxDD ${pct(bt.btc.maxDrawdown)}` : ''}`);
      for (const c of bt.caveats) L.push(`  note: ${c}`);
    } else {
      L.push(`Backtest skipped: ${bt.reason}`);
    }
  }
  return L.join('\n');
}
