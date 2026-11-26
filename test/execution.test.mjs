import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalsOf, floorToStep, roundToTick, isMultiple, walkBook, planLeg, preflight, buildOrderPreview } from '../src/engine/execution.mjs';
import { cfg } from './helpers.mjs';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

const RULE = {
  id: 7,
  name: 'vXYZ_vUSDC',
  status: 'TRADING',
  tickSize: '0.01',
  pricePrecision: 2,
  minPrice: '0.01',
  maxPrice: '0',
  stepSize: '0.001',
  quantityPrecision: 3,
  minQuantity: '0.001',
  maxQuantity: '0',
  marketMinQuantity: '0.001',
  marketMaxQuantity: '0',
  minNotional: '5',
  maxNotional: '0',
  takerFee: '0.00065',
};

// mid 100.00; asks climb 1 cent per 10 units, bids fall likewise
function book(levels = 30, qtyPerLevel = 10, spread = 0.02) {
  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i += 1) {
    bids.push([(100 - spread / 2 - i * 0.01).toFixed(2), String(qtyPerLevel)]);
    asks.push([(100 + spread / 2 + i * 0.01).toFixed(2), String(qtyPerLevel)]);
  }
  return { bids, asks };
}
const TICKER = { lastPx: '100', quoteVolume: '1000000' };

test('decimals, step flooring, tick rounding, multiples', () => {
  assert.equal(decimalsOf('0.001'), 3);
  assert.equal(decimalsOf('1'), 0);
  assert.equal(decimalsOf('0.50'), 1);
  assert.equal(floorToStep(0.123456, '0.001'), 0.123);
  assert.equal(floorToStep(1.0000000001, '0.001'), 1);
  assert.equal(floorToStep(0.0029999999, '0.001'), 0.002);
  assert.equal(roundToTick(61687.3, '1', 'down'), 61687);
  assert.equal(roundToTick(61687.3, '1', 'up'), 61688);
  assert.equal(roundToTick(1740.43, '0.1', 'up'), 1740.5);
  assert.ok(isMultiple(0.3, '0.1'));
  assert.ok(!isMultiple(0.35, '0.1'));
});

test('walkBook: volume-weighted price, partial fills, and bad levels are ignored', () => {
  const lv = [['100', '1'], ['101', '2']];
  let w = walkBook(lv, 2);
  assert.equal(w.complete, true);
  approx(w.vwap, 100.5);
  approx(w.cost, 201);
  w = walkBook(lv, 5);
  assert.equal(w.complete, false);
  approx(w.filled, 3);
  w = walkBook([['0', '5'], ['100', '0'], ['100', '1']], 1);
  assert.equal(w.complete, true);
  assert.equal(w.vwap, 100);
});

test('planLeg: a small BUY fills at the touch with tiny slippage and passes preflight', () => {
  const leg = planLeg({ asset: 'X', rule: RULE, book: book(), ticker: TICKER, side: 'BUY', targetNotionalUsd: 50 }, cfg());
  assert.equal(leg.status, 'ok');
  assert.equal(leg.preflight, 'pass');
  assert.ok(leg.slippageBps < 5);
  assert.ok(isMultiple(Number(leg.quantity), RULE.stepSize));
  approx(Number(leg.quantity), 0.5, 1e-9);
  approx(leg.feeUsd, leg.notionalUsd * 0.00065, 1e-3);
  // limit price protects against slippage: at or above mid * (1 + 30bps), on tick
  assert.ok(Number(leg.limitPrice) >= 100 * (1 + 0.003) - 0.01);
  assert.ok(isMultiple(Number(leg.limitPrice), RULE.tickSize));
});

test('planLeg: a BUY too big for the book is shrunk until slippage fits, never above the cap', () => {
  const c = cfg();
  const leg = planLeg({ asset: 'X', rule: RULE, book: book(30, 10), ticker: TICKER, side: 'BUY', targetNotionalUsd: 100_000 }, c);
  assert.equal(leg.status, 'reduced');
  assert.ok(leg.slippageBps <= c.execution.maxSlippageBps + 1e-9);
  assert.ok(leg.notionalUsd < 100_000);
  assert.ok(leg.notionalUsd > 0);
  // one more step must break the constraint (the search found the true maximum)
  const next = Number(leg.quantity) + Number(RULE.stepSize);
  const w = walkBook(book(30, 10).asks, next);
  const slip = w.complete ? ((w.vwap - 100) / 100) * 1e4 : Infinity;
  assert.ok(slip > c.execution.maxSlippageBps || !w.complete, 'a larger size would have violated the limit');
});

test('planLeg: SELL walks the bids', () => {
  const leg = planLeg({ asset: 'X', rule: RULE, book: book(), ticker: TICKER, side: 'SELL', targetNotionalUsd: 200 }, cfg());
  assert.equal(leg.side, 'SELL');
  assert.ok(leg.expectedVwap < 100);
  assert.ok(leg.slippageBps >= 0);
  assert.ok(Number(leg.limitPrice) <= 100 * (1 - 0.003) + 0.01);
});

test('planLeg: dropped for HALT, unlisted, empty book, below min notional, too-thin spread', () => {
  const c = cfg();
  const ask = (rule, b, target = 100, ticker = TICKER) => planLeg({ asset: 'X', rule, book: b, ticker, side: 'BUY', targetNotionalUsd: target }, c);
  assert.match(ask({ ...RULE, status: 'HALT' }, book()).reason, /HALT/);
  assert.match(ask(undefined, book()).reason, /not listed/);
  assert.match(ask(RULE, { bids: [], asks: [] }).reason, /no two-sided/);
  assert.match(ask(RULE, book(), 3).status, /dropped/);
  const wide = ask(RULE, book(30, 10, 1.2)); // 1.2 spread on mid 100 => 60 bps full spread, 30 bps half-spread already
  assert.equal(wide.status, 'dropped');
  assert.match(wide.reason, /spread or depth too thin/);
});

test('planLeg: capped at a share of 24h volume', () => {
  const leg = planLeg({ asset: 'X', rule: RULE, book: book(), ticker: { lastPx: '100', quoteVolume: '400' }, side: 'BUY', targetNotionalUsd: 1000 }, cfg());
  assert.equal(leg.status, 'reduced');
  assert.match(leg.reason, /24h volume/);
  assert.ok(leg.notionalUsd <= 400 * 0.25 + 1);
});

test('preflight follows the documented SoDEX filters', () => {
  assert.deepEqual(preflight({ quantity: '0.500', price: '100.00' }, RULE, 100), []);
  assert.ok(preflight({ quantity: '0.0005', price: '100.00' }, RULE, 100).some((v) => /stepSize|minQuantity/.test(v)));
  assert.ok(preflight({ quantity: '0.010', price: '100.005' }, RULE, 100).some((v) => /tickSize/.test(v)));
  assert.ok(preflight({ quantity: '0.010', price: '100.00' }, RULE, 100).some((v) => /minNotional/.test(v)), '0.01 x 100 = 1 < 5');
  assert.deepEqual(preflight({ quantity: '0.010', price: '100.00' }, { ...RULE, minNotional: '0' }, 100), []);
});

test('buildOrderPreview: unsigned, valid ids, enums as integers, dropped legs excluded', () => {
  const c = cfg();
  const buy = planLeg({ asset: 'X', rule: RULE, book: book(), ticker: TICKER, side: 'BUY', targetNotionalUsd: 50 }, c);
  const sell = planLeg({ asset: 'X', rule: RULE, book: book(), ticker: TICKER, side: 'SELL', targetNotionalUsd: 50 }, c);
  const bad = planLeg({ asset: 'X', rule: { ...RULE, status: 'HALT' }, book: book(), ticker: TICKER, side: 'BUY', targetNotionalUsd: 50 }, c);
  const p = buildOrderPreview([buy, bad, sell], { [RULE.name]: RULE }, 'abcdef0123');
  assert.equal(p.request.accountID, null, 'accountID is a placeholder; nothing is signed');
  assert.equal(p.request.orders.length, 2);
  const [o1, o2] = p.request.orders;
  assert.deepEqual([o1.side, o1.type, o1.timeInForce], [1, 2, 3]);
  assert.equal(o2.side, 2);
  assert.equal(o1.symbolID, 7);
  for (const o of p.request.orders) assert.match(o.clOrdID, /^[0-9a-zA-Z_-]{1,36}$/);
  assert.notEqual(o1.clOrdID, o2.clOrdID);
  assert.ok(!JSON.stringify(p).includes('signature'));
});
