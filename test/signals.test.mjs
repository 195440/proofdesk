import test from 'node:test';
import assert from 'node:assert/strict';
import { flowSignal, regimeFromFlows } from '../src/signals/flows.mjs';
import { momentumSignal } from '../src/signals/momentum.mjs';
import { eventSignal, fomcSignal } from '../src/signals/macro.mjs';
import { newsSignal } from '../src/signals/news.mjs';
import { closedOnly, DAY_MS } from '../src/signals/series.mjs';

const approx = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------- ETF flows

function rowsAsc(values, startDate = '2026-11-01') {
  return values.map((v, i) => ({
    date: new Date(Date.parse(`${startDate}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10),
    total_net_inflow: v,
  }));
}

test('flowSignal: z-score matches a hand computation', () => {
  // window 3 sums: [4,5,4,5,4,5,13,22] then latest 30. mean 7.75, sample std 6.4972 (hand-computed).
  const asc = rowsAsc([1, 2, 1, 2, 1, 2, 1, 2, 10, 10, 10]);
  const s = flowSignal(asc, { window: 3, basePath: 'x' });
  assert.equal(s.status, 'ok');
  assert.equal(s.sumUsd, 30);
  approx(s.baselineMeanUsd, 7.75);
  approx(s.baselineStdUsd, 6.4972, 1e-3);
  approx(s.z, 3.4246, 1e-3);
  assert.equal(s.baselineWindows, 8);
});

test('flowSignal: API order (newest first) gives the same answer and evidence points at the raw indexes', () => {
  const asc = rowsAsc([1, 2, 1, 2, 1, 2, 1, 2, 10, 10, 10]);
  const desc = [...asc].reverse();
  const a = flowSignal(asc, { window: 3, basePath: 'x' });
  const d = flowSignal(desc, { window: 3, basePath: 'x' });
  assert.equal(a.z, d.z);
  // newest row is index 0 in the descending array
  assert.deepEqual(d.evidence.map((e) => e.path).sort(), ['x[0].total_net_inflow', 'x[1].total_net_inflow', 'x[2].total_net_inflow']);
  for (const e of d.evidence) assert.equal(e.value, 10);
});

test('flowSignal: too little data is reported, not guessed', () => {
  const s = flowSignal(rowsAsc([1, 2, 3]), { window: 5, basePath: 'x' });
  assert.equal(s.status, 'insufficient');
  assert.equal(flowSignal(undefined, { window: 5, basePath: 'x' }).status, 'insufficient');
});

test('flowSignal: flat history has zero spread and therefore z = 0 (no division by zero)', () => {
  const s = flowSignal(rowsAsc(Array(15).fill(5)), { window: 5, basePath: 'x' });
  assert.equal(s.z, 0);
});

test('regimeFromFlows: thresholds need both z and the sign of the sum', () => {
  const sig = (z, sumUsd) => ({ status: 'ok', z, sumUsd });
  const th = { zOn: 0.5, zOff: -0.5 };
  assert.equal(regimeFromFlows({ BTC: sig(1.2, 100), ETH: sig(0.9, 50) }, th).regime, 'RISK_ON');
  assert.equal(regimeFromFlows({ BTC: sig(-1.2, -100), ETH: sig(-0.9, -50) }, th).regime, 'RISK_OFF');
  assert.equal(regimeFromFlows({ BTC: sig(1.2, -100), ETH: sig(0.9, -50) }, th).regime, 'NEUTRAL', 'high z but net outflow');
  assert.equal(regimeFromFlows({ BTC: sig(0.1, 5) }, th).regime, 'NEUTRAL');
  const none = regimeFromFlows({ BTC: { status: 'missing' } }, th);
  assert.equal(none.regime, 'NEUTRAL');
  assert.equal(none.status, 'missing');
});

// ---------- momentum

function closesToSeries(closes, t0 = Date.parse('2026-09-01T00:00:00Z')) {
  return closes.map((c, i) => ({ t: t0 + i * DAY_MS, c, idx: i }));
}
const OPT = { days: 30, shortDays: 7, clip: 3, basePath: 'k', field: 'c' };

test('momentum: a noisy uptrend scores positive, a noisy downtrend negative, flat is exactly 0', () => {
  const up = [];
  const down = [];
  let u = 100;
  let d = 100;
  for (let i = 0; i < 40; i += 1) {
    u *= 1 + 0.01 + (i % 2 ? 0.004 : -0.004);
    d *= 1 - 0.01 + (i % 2 ? 0.004 : -0.004);
    up.push(u);
    down.push(d);
  }
  assert.ok(momentumSignal(closesToSeries(up), OPT).score > 0);
  assert.ok(momentumSignal(closesToSeries(down), OPT).score < 0);
  assert.equal(momentumSignal(closesToSeries(Array(40).fill(100)), OPT).score, 0);
});

test('momentum: score is clipped and evidence carries the raw index and close', () => {
  const closes = [];
  let c = 100;
  for (let i = 0; i < 40; i += 1) {
    c *= i % 2 ? 1.1 : 1.099;
    closes.push(c);
  }
  const m = momentumSignal(closesToSeries(closes), OPT);
  assert.equal(m.score, 3);
  assert.equal(m.evidence.length, 3);
  assert.equal(m.evidence[2].path, 'k[39].c');
  assert.equal(m.evidence[2].value, closes[39]);
  assert.equal(m.evidence[0].path, 'k[9].c', '30 days before the last candle');
});

test('momentum: needs days+1 closes', () => {
  assert.equal(momentumSignal(closesToSeries(Array(30).fill(100)), OPT).status, 'insufficient');
  assert.equal(momentumSignal(closesToSeries(Array(31).fill(100)), OPT).status, 'ok');
});

test('momentum: max drawdown is measured peak to trough', () => {
  const closes = [...Array(20).fill(100), 120, 90, ...Array(10).fill(95)];
  const m = momentumSignal(closesToSeries(closes), OPT);
  approx(m.maxDrawdown, 90 / 120 - 1, 1e-9);
});

test('closedOnly drops the candle that is still open at snapshot time', () => {
  const day = Date.parse('2026-11-20T00:00:00Z');
  const series = [{ t: day - DAY_MS }, { t: day }];
  assert.equal(closedOnly(series, day + 3_600_000).length, 1, 'today is still open at 01:00');
  assert.equal(closedOnly(series, day + DAY_MS).length, 2, 'closed once the next day starts');
});

// ---------- macro

test('eventSignal: only high-impact events inside the window count', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const events = [
    { date: '2026-11-19', events: ['CPI'] }, // yesterday
    { date: '2026-11-21', events: ['Nonfarm Payrolls', 'Retail Sales'] },
    { date: '2026-11-22', events: ['PPI'] }, // inside 48h (ends 2026-11-22 10:00)
    { date: '2026-11-23', events: ['CPI'] }, // outside
  ];
  const s = eventSignal(events, { nowMs: now, lookaheadHours: 48, highImpact: ['CPI', 'Nonfarm Payrolls', 'PPI'], basePath: 'm' });
  assert.deepEqual(s.hits.map((h) => `${h.date} ${h.event}`), ['2026-11-21 Nonfarm Payrolls', '2026-11-22 PPI']);
  assert.deepEqual(s.evidence.map((e) => e.path), ['m[1].events[0]', 'm[2].events[0]']);
  assert.equal(eventSignal(undefined, { nowMs: now, lookaheadHours: 48, highImpact: [], basePath: 'm' }).status, 'missing');
});

const FOMC = {
  rate_ranges: ['300-325', '325-350', '350-375', '375-400', '400-425', '425-450', '450-475', '475-500', '500-525'],
  meetings: [
    { meeting_date: '2026-09-16', probabilities: ['0.0', '0.0', '41.1', '58.9', '0.0', '0.0', '0.0', '0.0', null] },
    { meeting_date: '2026-10-28', probabilities: ['0.0', '0.0', '30.2', '54.2', '15.7', '0.0', '0.0', '0.0', '0.0'] },
  ],
  as_of: 1785919029525,
};

test('fomcSignal: parses the documented matrix (percent strings, null = no data)', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const s = fomcSignal(FOMC, { nowMs: now, basePath: 'f' });
  assert.equal(s.status, 'ok');
  assert.equal(s.nextMeeting, '2026-09-16');
  assert.equal(s.daysToNext, 2);
  // 41.1% on 3.625 and 58.9% on 3.875
  approx(s.expectedMidPct, 0.411 * 3.625 + 0.589 * 3.875, 1e-9);
  approx(s.entropyBits, -(0.411 * Math.log2(0.411) + 0.589 * Math.log2(0.589)), 1e-9);
  // far meeting = last available (index 1): expected (30.2,54.2,15.7)/100.1 over mids 3.625/3.875/4.125
  const far = (30.2 * 3.625 + 54.2 * 3.875 + 15.7 * 4.125) / 100.1;
  approx(s.impliedPathBps, (far - s.expectedMidPct) * 100, 1e-6);
  assert.equal(s.evidence[0].path, 'f.meetings[0].meeting_date');
});

test('fomcSignal: skips past meetings and treats null as missing, not zero', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const s = fomcSignal(FOMC, { nowMs: now, basePath: 'f' });
  assert.equal(s.nextMeeting, '2026-10-28');
  assert.equal(fomcSignal({ rate_ranges: ['300-325'], meetings: [{ meeting_date: '2026-12-01', probabilities: [null] }], as_of: 0 }, { nowMs: now, basePath: 'f' }).status, 'missing');
  assert.equal(fomcSignal(null, { nowMs: now, basePath: 'f' }).status, 'missing');
});

// ---------- news

const NOW = Date.parse('2026-11-20T12:00:00Z');
const item = (title, hoursAgo) => ({ release_time: NOW - hoursAgo * 3_600_000, title });
const NEWS = { nowMs: NOW, lookbackHours: 48, minHeadlines: 5, negativeTone: -0.4, basePath: 'n' };

test('newsSignal: negative tone fires only with enough headlines', () => {
  const bad = ['BTC plunges as exchange hacked', 'Liquidations hit record', 'Regulator probe widens', 'ETF outflows continue', 'Token delists after fraud claims'].map((t, i) => item(t, i + 1));
  const s = newsSignal(bad, NEWS);
  assert.equal(s.status, 'ok');
  assert.ok(s.tone <= -0.4);
  assert.equal(s.negative, true);
  const thin = newsSignal(bad.slice(0, 3), NEWS);
  assert.equal(thin.status, 'thin');
  assert.equal(thin.negative, false, 'three headlines are not enough to gate on');
});

test('newsSignal: whole-word matching ("Bank" is not "ban"), window filter, evidence paths', () => {
  const list = [
    item('Bank of Japan holds rates', 1),
    item('Spot ETF inflows surge', 2),
    item('Old news: crash', 100), // outside lookback
    item('Future-dated: plunge', -5), // after "now"
  ];
  const s = newsSignal(list, { ...NEWS, minHeadlines: 1 });
  assert.equal(s.headlines, 2);
  approx(s.tone, 0.5, 1e-9);
  assert.deepEqual(s.evidence.map((e) => e.path), ['n[1].title']);
});

test('newsSignal: missing list is reported', () => {
  assert.equal(newsSignal(undefined, NEWS).status, 'missing');
});
