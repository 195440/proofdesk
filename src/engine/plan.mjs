// The decision engine. buildPlan() is a pure function of
//   (snapshot, config, holdings)
// It never reads the clock, the network or the environment: "now" is
// snapshot.createdAt. Same inputs, same bytes, same planHash.

import { hashOf, getPath, clone } from '../canonical.mjs';
import { flowSignal, regimeFromFlows } from '../signals/flows.mjs';
import { momentumSignal } from '../signals/momentum.mjs';
import { eventSignal, fomcSignal } from '../signals/macro.mjs';
import { newsSignal } from '../signals/news.mjs';
import { closedOnly } from '../signals/series.mjs';
import { assetSeries } from '../assetSeries.mjs';
import { clamp, round } from '../signals/stats.mjs';
import { planLeg, buildOrderPreview } from './execution.mjs';

export const PLAN_SCHEMA = 'proofdesk.plan/1';

/** Water-filling cap: no weight above `cap`; excess goes to uncapped assets by raw score, rest stays cash. */
export function capWeights(raw, cap) {
  const w = { ...raw };
  for (let iter = 0; iter < 20; iter += 1) {
    const over = Object.keys(w).filter((k) => w[k] > cap + 1e-12);
    if (over.length === 0) break;
    let excess = 0;
    for (const k of over) {
      excess += w[k] - cap;
      w[k] = cap;
    }
    const room = Object.keys(w).filter((k) => w[k] < cap - 1e-12 && raw[k] > 0);
    const base = room.reduce((a, k) => a + raw[k], 0);
    if (room.length === 0 || base <= 0) break;
    for (const k of room) w[k] += (excess * raw[k]) / base;
  }
  return w;
}

function sameNumberish(a, b) {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a !== '' && b !== '') return na === nb;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function defaultHoldings(cfg) {
  return { cashUsd: cfg.navUsd, positionsUsd: {} };
}

function computeSignals(snapshot, cfg) {
  const nowMs = snapshot.createdAt;
  const soso = snapshot.sosovalue ?? null;

  // --- ETF flows
  const etfSymbols = [...new Set([...cfg.regime.voters, ...cfg.universe.map((a) => a.etf).filter(Boolean)])].sort();
  const flows = {};
  for (const sym of etfSymbols) {
    const rows = soso?.etf?.[sym]?.[cfg.regime.country];
    flows[sym] = Array.isArray(rows)
      ? flowSignal(rows, { window: cfg.regime.flowWindowDays, basePath: `sosovalue.etf.${sym}.${cfg.regime.country}` })
      : { status: 'missing', reason: `no ETF series for ${sym}/${cfg.regime.country}`, evidence: [] };
  }
  const regime = regimeFromFlows(
    Object.fromEntries(cfg.regime.voters.map((v) => [v, flows[v]])),
    cfg.regime,
  );

  // --- Macro & news
  const events = eventSignal(soso?.macroEvents, {
    nowMs,
    lookaheadHours: cfg.macro.lookaheadHours,
    highImpact: cfg.macro.highImpact,
    basePath: 'sosovalue.macroEvents',
  });
  const fomc = fomcSignal(soso?.fomc, { nowMs, basePath: 'sosovalue.fomc' });
  const news = newsSignal(soso?.newsHot?.list, {
    nowMs,
    lookbackHours: cfg.news.lookbackHours,
    minHeadlines: cfg.news.minHeadlines,
    negativeTone: cfg.news.negativeTone,
    basePath: 'sosovalue.newsHot.list',
  });

  // --- Market overview (circuit breaker input)
  const ov = soso?.overview;
  const mcapChg = ov && ov.total_market_cap_change_pct !== undefined ? Number(ov.total_market_cap_change_pct) : null;
  const overview = Number.isFinite(mcapChg)
    ? {
        status: 'ok',
        mcapChange24hPct: mcapChg,
        evidence: [{ path: 'sosovalue.overview.total_market_cap_change_pct', value: ov.total_market_cap_change_pct }],
      }
    : { status: 'missing', reason: 'no market overview in snapshot', evidence: [] };

  // --- Momentum per asset
  const momentum = {};
  for (const a of cfg.universe) {
    const s = assetSeries(snapshot, a);
    if (s.error) {
      momentum[a.id] = { status: 'missing', reason: s.error, evidence: [] };
      continue;
    }
    momentum[a.id] = momentumSignal(closedOnly(s.series, nowMs), {
      days: cfg.allocation.momentumDays,
      shortDays: cfg.allocation.shortDays,
      clip: cfg.allocation.momentumClip,
      basePath: s.basePath,
      field: s.field,
    });
  }

  return { flows, regime, events, fomc, news, overview, momentum };
}

function applyGates(sig, cfg) {
  const gates = [];
  const base = cfg.budget[sig.regime.regime];
  const steps = [{ step: `regime ${sig.regime.regime}`, budget: base }];
  let budget = base;

  const fomcUnsettled =
    sig.fomc.status === 'ok' && sig.fomc.daysToNext <= cfg.macro.fomcNearDays && sig.fomc.entropyBits >= cfg.macro.fomcEntropyBits;
  const eventHits = sig.events.status === 'ok' ? sig.events.hits : [];
  const eventFired = eventHits.length > 0 || fomcUnsettled;
  gates.push({
    id: 'event_risk',
    fired: eventFired,
    effect: `budget x ${cfg.budget.eventMultiplier}`,
    detail: eventFired
      ? [
          ...eventHits.map((h) => `${h.event} on ${h.date}`),
          ...(fomcUnsettled ? [`FOMC ${sig.fomc.nextMeeting} unsettled (${round(sig.fomc.entropyBits, 2)} bits)`] : []),
        ].join('; ')
      : 'no high-impact event inside the look-ahead window',
    evidence: [...(sig.events.evidence ?? []), ...(fomcUnsettled ? sig.fomc.evidence : [])],
  });
  if (eventFired) {
    budget *= cfg.budget.eventMultiplier;
    steps.push({ step: 'event_risk', budget: round(budget, 4) });
  }

  gates.push({
    id: 'news_negative',
    fired: sig.news.negative === true,
    effect: `budget x ${cfg.budget.newsMultiplier}`,
    detail:
      sig.news.status === 'missing'
        ? 'no news data'
        : `tone ${round(sig.news.tone ?? 0, 3)} over ${sig.news.headlines} headlines (threshold ${cfg.news.negativeTone}, min ${cfg.news.minHeadlines})`,
    evidence: sig.news.negative ? sig.news.evidence : [],
  });
  if (sig.news.negative) {
    budget *= cfg.budget.newsMultiplier;
    steps.push({ step: 'news_negative', budget: round(budget, 4) });
  }

  const cb = sig.overview.status === 'ok' && sig.overview.mcapChange24hPct <= cfg.budget.circuitBreakerMcapDropPct;
  gates.push({
    id: 'circuit_breaker',
    fired: cb,
    effect: `budget capped at ${cfg.budget.circuitBreakerBudget}`,
    detail:
      sig.overview.status === 'ok'
        ? `24h total market cap change ${sig.overview.mcapChange24hPct}% (trigger <= ${cfg.budget.circuitBreakerMcapDropPct}%)`
        : 'no market overview',
    evidence: cb ? sig.overview.evidence : [],
  });
  if (cb) {
    budget = Math.min(budget, cfg.budget.circuitBreakerBudget);
    steps.push({ step: 'circuit_breaker', budget: round(budget, 4) });
  }

  return { gates, riskBudget: { base, final: round(clamp(budget, 0, 1), 4), steps } };
}

/**
 * @param {object} snapshot  see src/snapshot.mjs
 * @param {object} config    DEFAULT_CONFIG-shaped
 * @param {{cashUsd:number, positionsUsd:Record<string,number>}|null} holdings
 */
export function buildPlan(snapshot, config, holdings = null) {
  const cfg = clone(config);
  const hold = holdings ? clone(holdings) : defaultHoldings(cfg);
  const sodex = snapshot.sodex ?? {};
  const rulesBySymbol = Object.fromEntries((sodex.symbols ?? []).map((s) => [s.name, s]));
  const tickersBySymbol = Object.fromEntries((sodex.tickers ?? []).map((t) => [t.symbol, t]));

  const sig = computeSignals(snapshot, cfg);
  const { gates, riskBudget } = applyGates(sig, cfg);

  // --- Scores and eligibility
  const scored = cfg.universe.map((a) => {
    const m = sig.momentum[a.id];
    const f = a.etf ? sig.flows[a.etf] : null;
    const flowTilt = f?.status === 'ok' ? cfg.allocation.flowTiltWeight * clamp(f.z, -2, 2) : 0;
    const rule = rulesBySymbol[a.sodex];
    let eligible = true;
    let why = null;
    if (m.status !== 'ok') {
      eligible = false;
      why = m.reason;
    } else if (!rule) {
      eligible = false;
      why = `${a.sodex} not listed on SoDEX`;
    } else if (rule.status !== 'TRADING') {
      eligible = false;
      why = `${a.sodex} status ${rule.status}`;
    }
    const score = m.status === 'ok' ? m.score + flowTilt : null;
    return { asset: a, momentum: m, flowTilt, score, eligible, why };
  });

  // --- Target weights
  const positive = scored.filter((s) => s.eligible && s.score > 0);
  const scoreSum = positive.reduce((acc, s) => acc + s.score, 0);
  const raw = {};
  if (scoreSum > 0) for (const s of positive) raw[s.asset.id] = (riskBudget.final * s.score) / scoreSum;
  const capped = capWeights(raw, cfg.allocation.maxWeight);
  const target = {};
  for (const s of scored) target[s.asset.id] = round(capped[s.asset.id] ?? 0, 4);
  const targetRisk = Object.values(target).reduce((a, b) => a + b, 0);

  // --- Current weights
  const nav = hold.cashUsd + Object.values(hold.positionsUsd).reduce((a, b) => a + b, 0);
  const dataGaps = [];
  if (!(nav > 0)) dataGaps.push('holdings NAV is not positive; no trades planned');
  for (const k of Object.keys(hold.positionsUsd)) {
    if (!cfg.universe.some((a) => a.id === k)) dataGaps.push(`holding ${k} is outside the universe and is left untouched`);
  }
  for (const [k, s] of Object.entries(sig.flows)) if (s.status !== 'ok') dataGaps.push(`ETF flows ${k}: ${s.reason ?? s.status}`);
  if (sig.regime.status === 'missing') dataGaps.push(sig.regime.reason);
  if (sig.events.status !== 'ok') dataGaps.push(`macro events: ${sig.events.reason}`);
  if (sig.fomc.status !== 'ok') dataGaps.push(`FOMC: ${sig.fomc.reason}`);
  if (sig.news.status === 'missing') dataGaps.push(`news: ${sig.news.reason}`);
  if (sig.news.status === 'thin') dataGaps.push(`news: only ${sig.news.headlines} headlines in window (< ${cfg.news.minHeadlines}); tone gate disabled`);
  if (sig.overview.status !== 'ok') dataGaps.push(`market overview: ${sig.overview.reason}`);
  for (const [k, e] of Object.entries(snapshot.sosovalue?.errors ?? {})) dataGaps.push(`SoSoValue ${k}: ${e}`);
  for (const [k, e] of Object.entries(sodex.errors ?? {})) dataGaps.push(`SoDEX ${k}: ${e}`);

  // --- Deltas
  const rows = scored.map((s) => {
    const cur = nav > 0 ? (hold.positionsUsd[s.asset.id] ?? 0) / nav : 0;
    const tgt = target[s.asset.id];
    return { s, cur, tgt, delta: tgt - cur };
  });
  let traded = rows.filter((r) => Math.abs(r.delta) >= cfg.allocation.noTradeBand);
  const turnover = traded.reduce((a, r) => a + Math.abs(r.delta), 0);
  const scale = turnover > cfg.allocation.maxTurnover ? cfg.allocation.maxTurnover / turnover : 1;
  traded = traded.map((r) => ({ ...r, delta: r.delta * scale }));

  // --- Executable legs (sells first, then buys, stable by asset id)
  const legs = [];
  if (nav > 0) {
    const ordered = [...traded].sort((a, b) => {
      const sa = a.delta < 0 ? 0 : 1;
      const sb = b.delta < 0 ? 0 : 1;
      return sa - sb || (a.s.asset.id < b.s.asset.id ? -1 : 1);
    });
    for (const r of ordered) {
      const a = r.s.asset;
      const leg = planLeg(
        {
          asset: a.id,
          rule: rulesBySymbol[a.sodex],
          book: sodex.books?.[a.sodex],
          ticker: tickersBySymbol[a.sodex],
          side: r.delta < 0 ? 'SELL' : 'BUY',
          targetNotionalUsd: Math.abs(r.delta) * nav,
        },
        cfg,
      );
      if (scale < 1 && leg.status !== 'dropped') {
        const note = `scaled to ${round(scale * 100, 1)}% by turnover cap ${cfg.allocation.maxTurnover}`;
        leg.reason = leg.reason ? `${leg.reason}; ${note}` : note;
        leg.status = 'reduced';
      }
      leg.evidence = ['bids', 'asks'].map((side) => ({
        path: `sodex.books.${a.sodex}.${side}[0][0]`,
        value: getPath(snapshot, `sodex.books.${a.sodex}.${side}[0][0]`) ?? null,
      }));
      legs.push(leg);
    }
  }

  const executed = legs.filter((l) => l.status !== 'dropped');
  const feeUsd = executed.reduce((a, l) => a + l.feeUsd, 0);
  const slipUsd = executed.reduce((a, l) => a + (l.notionalUsd * l.slippageBps) / 1e4, 0);
  const execTurnover = nav > 0 ? executed.reduce((a, l) => a + l.notionalUsd, 0) / nav : 0;

  const assets = rows.map((r) => {
    const m = r.s.momentum;
    const leg = legs.find((l) => l.asset === r.s.asset.id);
    return {
      id: r.s.asset.id,
      symbol: r.s.asset.sodex,
      eligible: r.s.eligible,
      note: r.s.why,
      momentumScore: m.status === 'ok' ? round(m.score, 4) : null,
      flowTilt: round(r.s.flowTilt, 4),
      score: r.s.score === null ? null : round(r.s.score, 4),
      currentWeight: round(r.cur, 4),
      targetWeight: r.tgt,
      action: leg ? `${leg.side} (${leg.status})` : Math.abs(r.tgt - r.cur) < cfg.allocation.noTradeBand ? 'HOLD (inside band)' : 'HOLD (turnover cap)',
    };
  });

  const claims = [];
  claims.push({
    id: 'regime',
    text: `Regime ${sig.regime.regime}${sig.regime.status === 'ok' ? ` (flow z ${round(sig.regime.z, 2)}, 5d net ${round(sig.regime.sumUsd / 1e6, 1)}M USD, voters ${sig.regime.voters.join('+')})` : ` (${sig.regime.reason})`}`,
    evidence: cfg.regime.voters.flatMap((v) => sig.flows[v].evidence ?? []),
  });
  for (const a of cfg.universe) {
    const m = sig.momentum[a.id];
    if (m.status === 'ok') {
      claims.push({
        id: `momentum:${a.id}`,
        text: `${a.id}: 30d ${round(m.r30 * 100, 2)}%, 7d ${round(m.r7 * 100, 2)}%, daily vol ${round(m.dailyVol * 100, 2)}%, momentum score ${round(m.score, 2)}`,
        evidence: m.evidence,
      });
    }
  }
  for (const g of gates.filter((x) => x.fired)) claims.push({ id: `gate:${g.id}`, text: `${g.id}: ${g.detail}`, evidence: g.evidence });
  for (const l of legs) {
    claims.push({
      id: `leg:${l.asset}`,
      text: `${l.side} ${l.asset}: ${l.status}${l.status === 'dropped' ? ` (${l.reason})` : `, ~${l.notionalUsd} USD @ ${l.expectedVwap}, slippage ${l.slippageBps} bps`}`,
      evidence: l.evidence,
    });
  }

  const inputs = {
    snapshotHash: hashOf(snapshot),
    snapshotCreatedAt: snapshot.createdAt,
    mode: snapshot.mode,
    configHash: hashOf(cfg),
    config: cfg,
    holdings: hold,
  };

  const plan = {
    schema: PLAN_SCHEMA,
    inputs,
    regime: sig.regime,
    riskBudget,
    gates,
    signals: { flows: sig.flows, events: sig.events, fomc: sig.fomc, news: sig.news, overview: sig.overview, momentum: sig.momentum },
    assets,
    target: { weights: target, riskWeight: round(targetRisk, 4), cashWeight: round(1 - targetRisk, 4) },
    legs,
    orders: buildOrderPreview(legs, rulesBySymbol, inputs.snapshotHash.slice(0, 10)),
    summary: {
      navUsd: round(nav, 2),
      legsPlanned: legs.length,
      legsExecutable: executed.length,
      legsDropped: legs.length - executed.length,
      turnover: round(execTurnover, 4),
      expectedFeeUsd: round(feeUsd, 4),
      expectedSlippageUsd: round(slipUsd, 4),
      expectedCostUsd: round(feeUsd + slipUsd, 4),
      turnoverScale: round(scale, 4),
    },
    dataGaps,
    claims,
  };
  plan.planHash = hashOf(plan);
  return plan;
}

/**
 * Replay a stored plan against its snapshot and check every receipt.
 * Needs nothing but the two files: the plan carries the config and holdings it was built with.
 */
export function verifyPlan(plan, snapshot) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('plan schema', plan?.schema === PLAN_SCHEMA, String(plan?.schema));
  const snapHash = hashOf(snapshot);
  add('snapshot hash matches plan.inputs.snapshotHash', snapHash === plan?.inputs?.snapshotHash, snapHash.slice(0, 16));

  let replay = null;
  try {
    replay = buildPlan(snapshot, plan.inputs.config, plan.inputs.holdings);
  } catch (e) {
    add('replay runs', false, e.message);
  }
  if (replay) {
    add('config hash matches', hashOf(plan.inputs.config) === plan.inputs.configHash);
    const { planHash: _stored, ...rest } = plan;
    add('stored planHash matches its own content', hashOf(rest) === plan.planHash, String(plan.planHash).slice(0, 16));
    add('replayed planHash equals stored planHash', replay.planHash === plan.planHash, replay.planHash.slice(0, 16));
  }

  let bad = 0;
  let total = 0;
  for (const c of plan?.claims ?? []) {
    for (const e of c.evidence ?? []) {
      total += 1;
      const actual = getPath(snapshot, e.path);
      if (!sameNumberish(actual, e.value)) {
        bad += 1;
        add(`receipt ${c.id} ${e.path}`, false, `snapshot has ${JSON.stringify(actual)}, plan claims ${JSON.stringify(e.value)}`);
      }
    }
  }
  add(`receipts resolve against snapshot (${total} checked)`, bad === 0, bad ? `${bad} mismatched` : '');

  return { ok: checks.every((c) => c.ok), checks };
}
