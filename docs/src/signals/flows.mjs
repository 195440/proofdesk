// Spot-ETF flow signal (SoSoValue GET /openapi/v1/etfs/summary-history).
// Rows look like { date, total_net_inflow, total_value_traded, total_net_assets, cum_net_inflow }
// and the API serves them newest first, for the most recent month only.

import { mean, sampleStd } from './stats.mjs';

/**
 * z-score of the latest `window`-day net inflow against all earlier
 * `window`-day windows in the same series.
 *
 * @param {Array} rows raw rows from the snapshot
 * @param {{window:number, basePath:string}} o basePath is the snapshot path of `rows`
 */
export function flowSignal(rows, { window, basePath }) {
  const valid = (rows ?? [])
    .map((r, idx) => ({ idx, date: String(r?.date ?? ''), v: Number(r?.total_net_inflow) }))
    .filter((r) => r.date && Number.isFinite(r.v))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const need = window + 5;
  if (valid.length < need) {
    return { status: 'insufficient', reason: `need >= ${need} daily rows, have ${valid.length}`, evidence: [] };
  }

  const sums = [];
  for (let k = window - 1; k < valid.length; k += 1) {
    let s = 0;
    for (let j = k - window + 1; j <= k; j += 1) s += valid[j].v;
    sums.push(s);
  }
  const latest = sums[sums.length - 1];
  const prior = sums.slice(0, -1);
  const m = mean(prior);
  const sd = sampleStd(prior);
  const z = sd > 0 ? (latest - m) / sd : 0;

  const tail = valid.slice(-window);
  return {
    status: 'ok',
    asOfDate: valid[valid.length - 1].date,
    windowDays: window,
    sumUsd: latest,
    baselineMeanUsd: m,
    baselineStdUsd: sd,
    baselineWindows: prior.length,
    z,
    evidence: tail.map((r) => ({ path: `${basePath}[${r.idx}].total_net_inflow`, value: rows[r.idx].total_net_inflow })),
  };
}

/** Combine the voting ETF signals into a market regime. */
export function regimeFromFlows(signals, { zOn, zOff }) {
  const ok = Object.entries(signals).filter(([, s]) => s?.status === 'ok');
  if (ok.length === 0) {
    return { regime: 'NEUTRAL', status: 'missing', reason: 'no usable ETF flow series; defaulting to NEUTRAL', voters: [] };
  }
  const z = mean(ok.map(([, s]) => s.z));
  const sumUsd = ok.reduce((a, [, s]) => a + s.sumUsd, 0);
  let regime = 'NEUTRAL';
  if (z >= zOn && sumUsd > 0) regime = 'RISK_ON';
  else if (z <= zOff && sumUsd < 0) regime = 'RISK_OFF';
  return { regime, status: 'ok', z, sumUsd, voters: ok.map(([k]) => k) };
}
