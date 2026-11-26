import test from 'node:test';
import assert from 'node:assert/strict';
import { weightsAt, runBacktest, budgetFromBreadth, alignCloses } from '../src/engine/backtest.mjs';
import { mulberry32 } from '../fixtures/synthetic.mjs';
import { cfg, demoSnapshot } from './helpers.mjs';

function walk(seed, n, drift, noise, start = 100) {
  const r = mulberry32(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i += 1) {
    p *= 1 + drift + (r() - 0.5) * 2 * noise;
    out.push(p);
  }
  return out;
}

test('budgetFromBreadth: share of positive-momentum assets picks the regime proxy', () => {
  const c = cfg();
  assert.equal(budgetFromBreadth({ a: 1, b: 1, c: 1 }, c), c.budget.RISK_ON);
  assert.equal(budgetFromBreadth({ a: 1, b: -1, c: -1 }, c), c.budget.NEUTRAL);
  assert.equal(budgetFromBreadth({ a: -1, b: -1, c: -1 }, c), c.budget.RISK_OFF);
  assert.equal(budgetFromBreadth({}, c), c.budget.RISK_OFF);
});

test('weightsAt never looks past index t: changing the future cannot change the weights', () => {
  const c = cfg();
  const closes = { A: walk(1, 80, 0.004, 0.01), B: walk(2, 80, 0.002, 0.012), C: walk(3, 80, -0.003, 0.015) };
  const t = 50;
  const before = weightsAt(closes, t, c);
  const mutated = {};
  for (const [k, v] of Object.entries(closes)) mutated[k] = v.map((x, i) => (i > t ? x * (1 + (i % 7) * 0.5) : x));
  assert.deepEqual(weightsAt(mutated, t, c), before);
  const later = weightsAt(closes, t + 10, c);
  assert.notDeepEqual(later, before, 'sanity: the function does react to data up to t');
});

test('weightsAt respects the cap and the risk budget', () => {
  const c = cfg();
  const closes = { A: walk(1, 80, 0.006, 0.008), B: walk(2, 80, 0.005, 0.008), C: walk(3, 80, 0.004, 0.008) };
  const w = weightsAt(closes, 60, c);
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(sum <= c.budget.RISK_ON + 1e-9);
  for (const x of Object.values(w)) assert.ok(x <= c.allocation.maxWeight + 1e-9);
});

function mkSnapshot(assets, n = 90) {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const lastClosed = Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000;
  const klines = (closes) => closes.map((c, i) => ({ t: String(lastClosed - (closes.length - 1 - i) * 86_400_000), o: String(c), h: String(c), l: String(c), c: String(c), v: '1', q: '1', n: 1 }));
  const sodexKlines = {};
  for (const [sym, closes] of Object.entries(assets)) sodexKlines[sym] = klines(closes);
  return { schema: 'x', createdAt: now, mode: 'fixture', sosovalue: null, sodex: { symbols: [], tickers: [], books: {}, klines: sodexKlines } };
}
const twoAssetCfg = () => {
  const c = cfg();
  c.universe = [
    { id: 'BTC', sodex: 'vBTC_vUSDC', momentum: { source: 'sodex' } },
    { id: 'ETH', sodex: 'vETH_vUSDC', momentum: { source: 'sodex' } },
  ];
  return c;
};

test('runBacktest on a steady uptrend: positive return, costs charged, no look-ahead artefacts', () => {
  const snap = mkSnapshot({ vBTC_vUSDC: walk(11, 90, 0.005, 0.006), vETH_vUSDC: walk(12, 90, 0.004, 0.007) });
  const bt = runBacktest(snap, twoAssetCfg());
  assert.equal(bt.status, 'ok');
  assert.ok(bt.strategy.totalReturn > 0);
  assert.ok(bt.rebalances > 0);
  assert.ok(bt.costTotal > 0, 'trading is not free');
  assert.equal(bt.curves.strategy.length, bt.curves.dates.length);
  assert.equal(bt.curves.strategy[0], 1);
  // never more invested than the best budget, so it cannot beat 100% buy-and-hold in a clean uptrend
  assert.ok(bt.strategy.totalReturn <= bt.equalWeight.totalReturn + 1e-9);
});

test('runBacktest on flat prices stays in cash: zero return, zero trades', () => {
  const flat = Array(90).fill(100);
  const bt = runBacktest(mkSnapshot({ vBTC_vUSDC: flat, vETH_vUSDC: flat }), twoAssetCfg());
  assert.equal(bt.status, 'ok');
  assert.equal(bt.strategy.totalReturn, 0);
  assert.equal(bt.rebalances, 0);
});

test('runBacktest on a falling market limits drawdown versus buy-and-hold, and says the window is a drawdown', () => {
  const snap = mkSnapshot({ vBTC_vUSDC: walk(21, 90, -0.006, 0.008), vETH_vUSDC: walk(22, 90, -0.005, 0.009) });
  const bt = runBacktest(snap, twoAssetCfg());
  assert.ok(bt.strategy.maxDrawdown >= bt.equalWeight.maxDrawdown);
  assert.ok(bt.caveats.some((c) => /drawdown/.test(c)));
});

test('runBacktest refuses to run on too little history and says why', () => {
  const snap = mkSnapshot({ vBTC_vUSDC: walk(1, 30, 0.001, 0.01), vETH_vUSDC: walk(2, 30, 0.001, 0.01) });
  const bt = runBacktest(snap, twoAssetCfg());
  assert.equal(bt.status, 'insufficient');
  assert.match(bt.reason, /common closed daily candles/);
});

test('alignCloses uses only dates present for every asset', () => {
  const a = walk(1, 90, 0.001, 0.01);
  const b = walk(2, 80, 0.001, 0.01); // shorter history ends the same day
  const { dates, closes } = alignCloses(mkSnapshot({ vBTC_vUSDC: a, vETH_vUSDC: b }), twoAssetCfg());
  assert.equal(dates.length, 80);
  assert.equal(closes.BTC.length, 80);
  assert.equal(closes.BTC[79], a[89]);
});

test('runBacktest works on the demo fixture and is deterministic', () => {
  const c = cfg();
  const a = runBacktest(demoSnapshot(), c);
  const b = runBacktest(demoSnapshot(), c);
  assert.equal(a.status, 'ok');
  assert.deepEqual(a, b);
});
