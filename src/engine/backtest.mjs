// Price-only backtest of the allocation rules.
//
// What it covers: momentum scoring, risk budget from price breadth, caps,
// no-trade band, turnover cap, fees and slippage.
// What it cannot cover: ETF flows (API serves ~1 month), news (7 days),
// FOMC odds (current matrix only). Those inputs have no history here, so the
// backtest uses a price-breadth proxy for the regime. It checks that the rules
// behave sanely; it is NOT evidence of alpha, and on ~3 months of data it
// cannot be.

import { assetSeries } from '../assetSeries.mjs';
import { closedOnly, dayKey } from '../signals/series.mjs';
import { momentumSignal } from '../signals/momentum.mjs';
import { round } from '../signals/stats.mjs';
import { capWeights } from './plan.mjs';

/** Breadth proxy: share of assets with positive momentum picks the risk budget. */
export function budgetFromBreadth(scores, cfg) {
  const vals = Object.values(scores);
  if (vals.length === 0) return cfg.budget.RISK_OFF;
  const breadth = vals.filter((s) => s > 0).length / vals.length;
  if (breadth >= 2 / 3) return cfg.budget.RISK_ON;
  if (breadth >= 1 / 3) return cfg.budget.NEUTRAL;
  return cfg.budget.RISK_OFF;
}

/**
 * Target weights using closes up to and including index `t` only.
 * @param {Record<string, number[]>} closes aligned daily closes per asset
 */
export function weightsAt(closes, t, cfg) {
  const scores = {};
  for (const [id, arr] of Object.entries(closes)) {
    const series = arr.slice(0, t + 1).map((c, i) => ({ t: i, c, idx: i }));
    const m = momentumSignal(series, {
      days: cfg.allocation.momentumDays,
      shortDays: cfg.allocation.shortDays,
      clip: cfg.allocation.momentumClip,
      basePath: id,
      field: 'c',
    });
    scores[id] = m.status === 'ok' ? m.score : null;
  }
  const valid = Object.fromEntries(Object.entries(scores).filter(([, s]) => s !== null));
  const budget = budgetFromBreadth(valid, cfg);
  const pos = Object.entries(valid).filter(([, s]) => s > 0);
  const sum = pos.reduce((a, [, s]) => a + s, 0);
  const raw = {};
  if (sum > 0) for (const [id, s] of pos) raw[id] = (budget * s) / sum;
  const capped = capWeights(raw, cfg.allocation.maxWeight);
  const out = {};
  for (const id of Object.keys(closes)) out[id] = capped[id] ?? 0;
  return out;
}

/** Common daily dates across all assets that have enough history. */
export function alignCloses(snapshot, cfg) {
  const nowMs = snapshot.createdAt;
  const byAsset = {};
  const skipped = [];
  for (const a of cfg.universe) {
    const s = assetSeries(snapshot, a);
    if (s.error) {
      skipped.push(`${a.id}: ${s.error}`);
      continue;
    }
    const closed = closedOnly(s.series, nowMs);
    if (closed.length < cfg.backtest.minDays) {
      skipped.push(`${a.id}: only ${closed.length} closed daily candles`);
      continue;
    }
    byAsset[a.id] = new Map(closed.map((k) => [dayKey(k.t), k.c]));
  }
  const ids = Object.keys(byAsset);
  if (ids.length === 0) return { ids, dates: [], closes: {}, skipped };
  let dates = [...byAsset[ids[0]].keys()];
  for (const id of ids.slice(1)) dates = dates.filter((d) => byAsset[id].has(d));
  dates.sort();
  const closes = {};
  for (const id of ids) closes[id] = dates.map((d) => byAsset[id].get(d));
  return { ids, dates, closes, skipped };
}

function maxDrawdown(curve) {
  let peak = -Infinity;
  let dd = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

export function runBacktest(snapshot, cfg) {
  const { ids, dates, closes, skipped } = alignCloses(snapshot, cfg);
  const need = cfg.backtest.minDays;
  if (ids.length < 2 || dates.length < need) {
    return {
      status: 'insufficient',
      reason: `need >= 2 assets with >= ${need} common closed daily candles; have ${ids.length} asset(s), ${dates.length} common day(s)`,
      skipped,
    };
  }

  const start = cfg.allocation.momentumDays; // first index with a full lookback
  const costBps = cfg.backtest.takerFeeBps + cfg.backtest.extraSlippageBps;
  let value = 1;
  let w = Object.fromEntries(ids.map((id) => [id, 0])); // start in cash
  const equity = [1];
  const outDates = [dates[start]];
  let turnoverTotal = 0;
  let rebalances = 0;
  let costTotal = 0;

  // Benchmarks start on the same day.
  const ew = ids.map((id) => 1 / ids.length);
  let ewVal = 1;
  let btcVal = 1;
  const ewCurve = [1];
  const btcCurve = [1];
  const hasBtc = ids.includes('BTC');

  for (let t = start; t < dates.length - 1; t += 1) {
    if ((t - start) % cfg.backtest.rebalanceEveryDays === 0) {
      const target = weightsAt(closes, t, cfg);
      let deltas = ids.map((id) => ({ id, d: target[id] - w[id] })).filter((x) => Math.abs(x.d) >= cfg.allocation.noTradeBand);
      const tv = deltas.reduce((a, x) => a + Math.abs(x.d), 0);
      const scale = tv > cfg.allocation.maxTurnover ? cfg.allocation.maxTurnover / tv : 1;
      deltas = deltas.map((x) => ({ ...x, d: x.d * scale }));
      const traded = deltas.reduce((a, x) => a + Math.abs(x.d), 0);
      if (traded > 0) {
        for (const x of deltas) w[x.id] += x.d;
        const cost = (traded * costBps) / 1e4;
        value *= 1 - cost;
        costTotal += cost;
        turnoverTotal += traded;
        rebalances += 1;
      }
    }
    // Day t -> t+1 return.
    let port = 0;
    const rets = {};
    for (const id of ids) {
      rets[id] = closes[id][t + 1] / closes[id][t] - 1;
      port += w[id] * rets[id];
    }
    value *= 1 + port;
    for (const id of ids) w[id] = (w[id] * (1 + rets[id])) / (1 + port);

    ewVal *= 1 + ew.reduce((a, x, i) => a + x * rets[ids[i]], 0);
    if (hasBtc) btcVal *= 1 + rets.BTC;
    equity.push(value);
    ewCurve.push(ewVal);
    btcCurve.push(btcVal);
    outDates.push(dates[t + 1]);
  }

  const metrics = (curve) => ({
    totalReturn: round(curve[curve.length - 1] - 1, 4),
    maxDrawdown: round(maxDrawdown(curve), 4),
  });

  return {
    status: 'ok',
    assets: ids,
    startDate: outDates[0],
    endDate: outDates[outDates.length - 1],
    days: outDates.length - 1,
    rebalances,
    turnoverTotal: round(turnoverTotal, 4),
    costTotal: round(costTotal, 4),
    strategy: metrics(equity),
    equalWeight: metrics(ewCurve),
    btc: hasBtc ? metrics(btcCurve) : null,
    curves: {
      dates: outDates,
      strategy: equity.map((v) => round(v, 6)),
      equalWeight: ewCurve.map((v) => round(v, 6)),
      btc: hasBtc ? btcCurve.map((v) => round(v, 6)) : null,
    },
    skipped,
    assumptions: [
      `weekly rebalance (every ${cfg.backtest.rebalanceEveryDays} days), long-only, cash earns 0`,
      `costs ${cfg.backtest.takerFeeBps} bps taker fee + ${cfg.backtest.extraSlippageBps} bps slippage on traded notional`,
      'regime proxy: share of assets with positive momentum (ETF flows, news and FOMC have no usable history)',
      'SSI assets use the SoSoValue index series, not the SoDEX token price',
    ],
    caveats: [
      `only ${outDates.length - 1} trading days: this checks that the rules behave sanely, it is not evidence of alpha`,
      ...(ewCurve[ewCurve.length - 1] - 1 <= -0.1
        ? ['the window is a market drawdown: any rule that sits in cash looks good here, so do not read the margin over the benchmarks as skill']
        : []),
      ...(ewCurve[ewCurve.length - 1] - 1 >= 0.1
        ? ['the window is a rally: a rule that holds some cash will trail buy-and-hold here by construction']
        : []),
    ],
  };
}
