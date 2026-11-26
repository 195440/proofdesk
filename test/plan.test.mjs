import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, verifyPlan, capWeights } from '../src/engine/plan.mjs';
import { hashOf, clone } from '../src/canonical.mjs';
import { cfg, demoSnapshot, bearishSnapshot } from './helpers.mjs';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const roundtrip = (x) => JSON.parse(JSON.stringify(x));

test('capWeights: excess above the cap flows to the others by raw score, the rest stays cash', () => {
  const w = capWeights({ a: 0.6, b: 0.2, c: 0.1 }, 0.4);
  approx(w.a, 0.4);
  approx(w.b, 0.2 + 0.2 * (2 / 3), 1e-12);
  approx(w.c, 0.1 + 0.2 * (1 / 3), 1e-12);
  approx(w.a + w.b + w.c, 0.9, 1e-12);
  const lone = capWeights({ a: 0.9 }, 0.4);
  approx(lone.a, 0.4);
  const cascade = capWeights({ a: 0.7, b: 0.25, c: 0.05 }, 0.4);
  assert.ok(Object.values(cascade).every((x) => x <= 0.4 + 1e-12));
});

test('plan is deterministic and survives a JSON round trip', () => {
  const s = demoSnapshot();
  const a = buildPlan(s, cfg());
  const b = buildPlan(roundtrip(s), cfg());
  assert.equal(a.planHash, b.planHash);
  assert.equal(hashOf(roundtrip(a)), hashOf(a), 'serialising the plan does not change its hash');
  assert.equal(a.inputs.snapshotHash, hashOf(s));
});

test('verifyPlan accepts an untouched plan and replays it exactly', () => {
  const s = demoSnapshot();
  const plan = roundtrip(buildPlan(s, cfg()));
  const r = verifyPlan(plan, roundtrip(s));
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(r.checks.some((c) => /receipts resolve/.test(c.name)));
});

test('verifyPlan catches a changed snapshot value (even by one unit)', () => {
  const s = demoSnapshot();
  const plan = roundtrip(buildPlan(s, cfg()));
  const bad = roundtrip(s);
  bad.sosovalue.etf.BTC.US[0].total_net_inflow += 1;
  const r = verifyPlan(plan, bad);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && /snapshot hash/.test(c.name)));
  assert.ok(r.checks.some((c) => !c.ok && /receipt/.test(c.name)));
});

test('verifyPlan catches an edited plan (weights, legs or hash)', () => {
  const s = demoSnapshot();
  const good = roundtrip(buildPlan(s, cfg()));

  const w = clone(good);
  w.target.weights['MAG7.ssi'] = 0.99;
  assert.equal(verifyPlan(w, s).ok, false);

  const l = clone(good);
  l.legs[0].quantity = '999999';
  assert.equal(verifyPlan(l, s).ok, false);

  const h = clone(good);
  h.planHash = '0'.repeat(64);
  assert.equal(verifyPlan(h, s).ok, false);

  const conf = clone(good);
  conf.inputs.config.allocation.maxWeight = 0.9;
  assert.equal(verifyPlan(conf, s).ok, false, 'a changed config cannot pass for the original');
});

test('verifyPlan catches a forged receipt value even if everything is re-hashed consistently', () => {
  const s = demoSnapshot();
  const forged = roundtrip(buildPlan(s, cfg()));
  const ev = forged.claims.flatMap((c) => c.evidence).find((e) => typeof e.value === 'number');
  ev.value += 1000;
  const { planHash: _drop, ...rest } = forged;
  forged.planHash = hashOf(rest); // attacker fixes the plan hash
  const r = verifyPlan(forged, s);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && /receipt/.test(c.name)));
});

test('verifyPlan catches a forged DECISION whose hash was recomputed to look consistent', () => {
  // Only the replay can expose this: snapshot hash, config hash, own-content hash and every receipt all pass.
  const s = demoSnapshot();
  const forged = roundtrip(buildPlan(s, cfg()));
  forged.target.weights['MEME.ssi'] = 0.4; // the engine would never allocate to a negative-momentum asset
  forged.legs.push({ asset: 'MEME.ssi', side: 'BUY', status: 'ok', quantity: '1', notionalUsd: 400, evidence: [] });
  const { planHash: _old, ...rest } = forged;
  forged.planHash = hashOf(rest);
  const r = verifyPlan(forged, s);
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['replayed planHash equals stored planHash'], 'every other check passes, only the replay objects');
});

test('bullish fixture: RISK_ON, trades only eligible positive-score assets, respects every cap', () => {
  const c = cfg();
  const p = buildPlan(demoSnapshot(), c);
  assert.equal(p.regime.regime, 'RISK_ON');
  for (const [id, w] of Object.entries(p.target.weights)) {
    assert.ok(w <= c.allocation.maxWeight + 1e-9, `${id} above max weight`);
    const a = p.assets.find((x) => x.id === id);
    if (w > 0) assert.ok(a.score > 0 && a.eligible, `${id} has weight but no positive score`);
  }
  assert.ok(p.target.riskWeight <= p.riskBudget.final + 1e-3);
  approx(p.target.riskWeight + p.target.cashWeight, 1, 1e-3);
  assert.ok(p.summary.turnover <= c.allocation.maxTurnover + 1e-6);
  for (const l of p.legs) {
    if (l.status !== 'dropped') {
      assert.ok(l.slippageBps <= c.execution.maxSlippageBps + 1e-9);
      assert.equal(l.preflight, 'pass');
    }
  }
});

test('event gate: a high-impact event inside 48h cuts the budget by the configured multiplier', () => {
  const c = cfg();
  const p = buildPlan(demoSnapshot(), c);
  const g = p.gates.find((x) => x.id === 'event_risk');
  assert.equal(g.fired, true);
  approx(p.riskBudget.final, Math.round(c.budget.RISK_ON * c.budget.eventMultiplier * 1e4) / 1e4, 1e-9);

  const s = demoSnapshot();
  s.sosovalue.macroEvents = [];
  const q = buildPlan(s, c);
  assert.equal(q.gates.find((x) => x.id === 'event_risk').fired, false);
  assert.equal(q.riskBudget.final, c.budget.RISK_ON);
});

test('bearish fixture: RISK_OFF, news gate and circuit breaker fire, budget collapses to the breaker level', () => {
  const c = cfg();
  const p = buildPlan(bearishSnapshot(), c);
  assert.equal(p.regime.regime, 'RISK_OFF');
  assert.equal(p.gates.find((g) => g.id === 'news_negative').fired, true);
  assert.equal(p.gates.find((g) => g.id === 'circuit_breaker').fired, true);
  assert.ok(p.riskBudget.final <= c.budget.circuitBreakerBudget + 1e-9);
  assert.ok(p.target.riskWeight <= c.budget.circuitBreakerBudget + 1e-3);
});

test('without SoSoValue data the plan degrades safely instead of failing', () => {
  const s = demoSnapshot();
  s.sosovalue = null;
  const p = buildPlan(s, cfg());
  assert.equal(p.regime.regime, 'NEUTRAL');
  assert.equal(p.regime.status, 'missing');
  assert.ok(p.dataGaps.length >= 5);
  for (const id of ['MAG7.ssi', 'DEFI.ssi', 'MEME.ssi']) {
    const a = p.assets.find((x) => x.id === id);
    assert.equal(a.eligible, false);
    assert.equal(a.targetWeight, 0);
  }
  assert.equal(verifyPlan(roundtrip(p), s).ok, true);
});

test('an endpoint error recorded in the snapshot shows up as a data gap', () => {
  const s = demoSnapshot();
  s.sosovalue.errors = { 'news/hot': 'HTTP 503' };
  delete s.sosovalue.newsHot;
  const p = buildPlan(s, cfg());
  assert.ok(p.dataGaps.some((g) => g.includes('news/hot') && g.includes('503')));
  assert.ok(p.dataGaps.some((g) => g.startsWith('news:')));
});

test('no trades when holdings already sit on the target (no-trade band)', () => {
  const c = cfg();
  const s = demoSnapshot();
  const first = buildPlan(s, c);
  const nav = 1000;
  const positionsUsd = {};
  let invested = 0;
  for (const [id, w] of Object.entries(first.target.weights)) {
    if (w > 0) {
      positionsUsd[id] = w * nav;
      invested += w * nav;
    }
  }
  const second = buildPlan(s, c, { cashUsd: nav - invested, positionsUsd });
  assert.equal(second.legs.length, 0);
  assert.ok(second.assets.every((a) => /HOLD/.test(a.action)));
});

test('turnover cap scales every leg down and says so', () => {
  const c = cfg();
  c.allocation.maxTurnover = 0.2;
  const p = buildPlan(demoSnapshot(), c);
  assert.ok(p.summary.turnoverScale < 1);
  assert.ok(p.legs.filter((l) => l.status !== 'dropped').every((l) => l.status === 'reduced' && /turnover cap/.test(l.reason)));
  assert.ok(p.summary.turnover <= 0.2 + 0.01);
});

test('holdings outside the universe are never traded and are flagged', () => {
  const p = buildPlan(demoSnapshot(), cfg(), { cashUsd: 500, positionsUsd: { DOGE: 500 } });
  assert.ok(p.dataGaps.some((g) => g.includes('DOGE')));
  assert.ok(!p.legs.some((l) => l.asset === 'DOGE'));
});

test('selling what we hold uses the bid side of the real SoDEX book and respects holdings', () => {
  const s = demoSnapshot();
  const p = buildPlan(s, cfg(), { cashUsd: 200, positionsUsd: { BTC: 800 } });
  const sell = p.legs.find((l) => l.asset === 'BTC');
  assert.ok(sell, 'BTC has negative momentum in the capture, so it must be sold');
  assert.equal(sell.side, 'SELL');
  assert.ok(sell.notionalUsd <= 800 + 1, 'cannot sell more than we hold');
  const bestBid = Number(s.sodex.books.vBTC_vUSDC.bids[0][0]);
  assert.ok(sell.expectedVwap <= bestBid + 1e-6, 'a sell fills at or below the best bid');
});

test('in-progress candle cannot move the signal (no look-ahead into the open day)', () => {
  const s = demoSnapshot();
  const a = buildPlan(s, cfg());
  const t = clone(s);
  const k = t.sodex.klines.vBTC_vUSDC;
  const open = k.reduce((m, x) => (Number(x.t) > Number(m.t) ? x : m));
  assert.ok(Number(open.t) + 86_400_000 > t.createdAt, 'fixture invariant: newest candle is still open');
  open.c = String(Number(open.c) * 3);
  const b = buildPlan(t, cfg());
  assert.equal(a.signals.momentum.BTC.score, b.signals.momentum.BTC.score);
});

test('every receipt in a fresh plan resolves against its snapshot', () => {
  const s = demoSnapshot();
  const p = buildPlan(s, cfg());
  const r = verifyPlan(roundtrip(p), s);
  const line = r.checks.find((c) => /receipts resolve/.test(c.name));
  assert.ok(line.ok);
  const total = p.claims.reduce((a, c) => a + c.evidence.length, 0);
  assert.ok(total >= 20, `expected a meaningful number of receipts, got ${total}`);
});
