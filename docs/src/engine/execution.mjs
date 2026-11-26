// Execution-awareness on top of SoDEX public market data.
// For every rebalance leg we answer: can this actually be filled, at what
// average price, and does it pass the exchange's own order filters?
// Filter rules follow the SoDEX spot "Place order" documentation.

import { round } from '../signals/stats.mjs';

const EPS = 1e-9;

export function decimalsOf(step) {
  const s = String(step);
  const i = s.indexOf('.');
  if (i < 0) return 0;
  return s.slice(i + 1).replace(/0+$/, '').length;
}

export function isMultiple(x, step) {
  const s = Number(step);
  if (!(s > 0)) return true;
  const q = x / s;
  return Math.abs(q - Math.round(q)) < 1e-7;
}

export function floorToStep(x, step) {
  const s = Number(step);
  const n = Math.floor(x / s + EPS);
  return Number((n * s).toFixed(decimalsOf(step)));
}

export function roundToTick(x, tick, direction) {
  const s = Number(tick);
  const q = x / s;
  const n = direction === 'up' ? Math.ceil(q - EPS) : Math.floor(q + EPS);
  return Number((n * s).toFixed(decimalsOf(tick)));
}

/** Walk one side of the book. levels are [priceStr, qtyStr], best first. */
export function walkBook(levels, qty) {
  let left = qty;
  let cost = 0;
  let worst = null;
  for (const [pStr, qStr] of levels) {
    const p = Number(pStr);
    const q = Number(qStr);
    if (!(p > 0) || !(q > 0)) continue;
    const take = Math.min(left, q);
    cost += take * p;
    left -= take;
    worst = p;
    if (left <= EPS) break;
  }
  const filled = qty - Math.max(left, 0);
  return { filled, complete: left <= EPS, cost, vwap: filled > 0 ? cost / filled : null, worstPx: worst };
}

export function bookTop(book) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  if (!(bid > 0) || !(ask > 0)) return null;
  return { bid, ask, mid: (bid + ask) / 2 };
}

function slippageBps(side, vwap, mid) {
  return side === 'BUY' ? ((vwap - mid) / mid) * 1e4 : ((mid - vwap) / mid) * 1e4;
}

/**
 * Exchange-side order filters (spot). `lastPx` is the last trade price used by
 * the gateway to estimate the notional of a market order without `funds`.
 */
export function preflight({ quantity, price }, rule, lastPx) {
  const v = [];
  const q = Number(quantity);
  if (!isMultiple(q, rule.stepSize) || decimalsOf(quantity) > Number(rule.quantityPrecision)) {
    v.push(`quantity ${quantity} not a multiple of stepSize ${rule.stepSize}`);
  }
  if (Number(rule.minQuantity) !== 0 && q < Number(rule.minQuantity)) v.push(`quantity below minQuantity ${rule.minQuantity}`);
  if (Number(rule.maxQuantity) !== 0 && q > Number(rule.maxQuantity)) v.push(`quantity above maxQuantity ${rule.maxQuantity}`);
  if (Number(rule.marketMinQuantity) !== 0 && q < Number(rule.marketMinQuantity)) v.push(`quantity below marketMinQuantity ${rule.marketMinQuantity}`);
  if (Number(rule.marketMaxQuantity) !== 0 && q > Number(rule.marketMaxQuantity)) v.push(`quantity above marketMaxQuantity ${rule.marketMaxQuantity}`);
  if (price !== undefined) {
    const p = Number(price);
    if (!isMultiple(p, rule.tickSize) || decimalsOf(price) > Number(rule.pricePrecision)) {
      v.push(`price ${price} not a multiple of tickSize ${rule.tickSize}`);
    }
    if (Number(rule.minPrice) !== 0 && p < Number(rule.minPrice)) v.push(`price below minPrice ${rule.minPrice}`);
    if (Number(rule.maxPrice) !== 0 && p > Number(rule.maxPrice)) v.push(`price above maxPrice ${rule.maxPrice}`);
  }
  const notional = q * lastPx;
  if (Number(rule.minNotional) !== 0 && notional < Number(rule.minNotional)) v.push(`notional ${round(notional, 4)} below minNotional ${rule.minNotional}`);
  if (Number(rule.maxNotional) !== 0 && notional > Number(rule.maxNotional)) v.push(`notional ${round(notional, 4)} above maxNotional ${rule.maxNotional}`);
  return v;
}

function dropped(base, reason) {
  return { ...base, status: 'dropped', reason, quantity: '0', notionalUsd: 0, feeUsd: 0 };
}

/**
 * Turn "trade X dollars of this asset" into a concrete, checked order leg.
 * status: ok (as asked) | reduced (shrunk to fit depth / slippage / volume cap) | dropped
 */
export function planLeg({ asset, rule, book, ticker, side, targetNotionalUsd }, cfg) {
  const base = {
    asset,
    symbol: rule?.name ?? null,
    side,
    targetNotionalUsd: round(targetNotionalUsd, 2),
  };
  if (!rule) return dropped(base, 'symbol not listed on SoDEX');
  if (rule.status !== 'TRADING') return dropped(base, `symbol status ${rule.status}`);
  const top = bookTop(book);
  if (!top) return dropped(base, 'order book has no two-sided quote');

  const mid = top.mid;
  const lastPx = Number(ticker?.lastPx) > 0 ? Number(ticker.lastPx) : mid;
  const stepN0 = Math.floor(targetNotionalUsd / mid / Number(rule.stepSize) + EPS);
  let reason = null;

  // Cap by share of 24h quote volume.
  let maxSteps = stepN0;
  const dayVol = Number(ticker?.quoteVolume);
  if (Number.isFinite(dayVol) && dayVol > 0) {
    const capSteps = Math.floor((dayVol * cfg.execution.maxShareOfDailyVolume) / mid / Number(rule.stepSize) + EPS);
    if (capSteps < maxSteps) {
      maxSteps = capSteps;
      reason = `capped at ${cfg.execution.maxShareOfDailyVolume * 100}% of 24h volume`;
    }
  }
  const mq = Number(rule.marketMaxQuantity);
  if (mq > 0) {
    const capSteps = Math.floor(mq / Number(rule.stepSize) + EPS);
    if (capSteps < maxSteps) {
      maxSteps = capSteps;
      reason = 'capped at marketMaxQuantity';
    }
  }
  if (maxSteps <= 0) return dropped(base, reason ?? 'target below one lot step');

  // Best price first, regardless of the order the gateway happened to return.
  const levels = [...(side === 'BUY' ? book.asks : book.bids)].sort((a, b) =>
    side === 'BUY' ? Number(a[0]) - Number(b[0]) : Number(b[0]) - Number(a[0]),
  );
  const fits = (steps) => {
    const qty = steps * Number(rule.stepSize);
    const w = walkBook(levels, qty);
    if (!w.complete) return false;
    return slippageBps(side, w.vwap, mid) <= cfg.execution.maxSlippageBps;
  };

  let steps = maxSteps;
  if (!fits(steps)) {
    // Slippage is non-decreasing in size: binary search the largest size that fits.
    let lo = 0;
    let hi = steps;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (fits(m)) lo = m;
      else hi = m - 1;
    }
    steps = lo;
    reason = steps > 0 ? `reduced to fit ${cfg.execution.maxSlippageBps} bps slippage / book depth` : null;
    if (steps === 0) return dropped(base, `no size fits ${cfg.execution.maxSlippageBps} bps slippage (spread or depth too thin)`);
  }

  const qtyNum = Number((steps * Number(rule.stepSize)).toFixed(decimalsOf(rule.stepSize)));
  const quantity = qtyNum.toFixed(decimalsOf(rule.stepSize));
  const fill = walkBook(levels, qtyNum);
  const notional = qtyNum * fill.vwap;
  const slip = slippageBps(side, fill.vwap, mid);

  const minQ = Math.max(Number(rule.minQuantity), Number(rule.marketMinQuantity));
  if (qtyNum < minQ) return dropped(base, `quantity ${quantity} below minimum ${minQ}`);
  if (Number(rule.minNotional) > 0 && qtyNum * lastPx < Number(rule.minNotional)) {
    return dropped(base, `notional below minNotional ${rule.minNotional}`);
  }

  const bound = mid * (1 + (side === 'BUY' ? 1 : -1) * (cfg.execution.maxSlippageBps / 1e4));
  const limitPrice = roundToTick(bound, rule.tickSize, side === 'BUY' ? 'up' : 'down').toFixed(decimalsOf(rule.tickSize));
  const violations = preflight({ quantity, price: limitPrice }, rule, lastPx);

  const reduced = steps < stepN0 || reason !== null;
  return {
    ...base,
    status: reduced ? 'reduced' : 'ok',
    reason: reduced ? reason ?? 'rounded down to lot step' : null,
    quantity,
    notionalUsd: round(notional, 2),
    refMid: round(mid, 8),
    expectedVwap: round(fill.vwap, 8),
    slippageBps: round(slip, 2),
    feeBps: round(Number(rule.takerFee) * 1e4, 2),
    feeUsd: round(notional * Number(rule.takerFee), 4),
    limitPrice,
    preflight: violations.length === 0 ? 'pass' : violations,
  };
}

/**
 * Unsigned SoDEX `BatchNewOrderRequest` preview (spot). Market IOC orders with
 * `price` used as slippage protection. NOT signed, NOT sent: `accountID` is a
 * placeholder the owner fills in when (and if) they decide to execute.
 */
export function buildOrderPreview(legs, rulesBySymbol, tag) {
  const orders = [];
  legs.forEach((leg, i) => {
    if (leg.status === 'dropped') return;
    const rule = rulesBySymbol[leg.symbol];
    orders.push({
      symbolID: rule.id,
      clOrdID: `pd-${tag}-${i}`,
      side: leg.side === 'BUY' ? 1 : 2,
      type: 2,
      timeInForce: 3,
      price: leg.limitPrice,
      quantity: leg.quantity,
    });
  });
  return {
    note: 'Unsigned preview. Proofdesk never signs or sends orders. Fill accountID and sign with the SoDEX SDK only if you decide to execute.',
    endpoint: 'POST /api/v1/spot/trade/orders/batch',
    request: { accountID: null, orders },
  };
}
