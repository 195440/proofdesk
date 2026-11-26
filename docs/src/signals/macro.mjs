// Macro signals from SoSoValue:
//   GET /openapi/v1/macro/events            -> [{ date: 'YYYY-MM-DD', events: ['CPI', ...] }]
//   GET /openapi/v1/macro/fomc-probabilities -> { rate_ranges, meetings[{meeting_date, probabilities}], as_of }
// `probabilities` are percentage STRINGS aligned by index with `rate_ranges`; null means "no data", not zero.

import { DAY_MS, dayKey } from './series.mjs';

/** High-impact events inside the look-ahead window (calendar days, UTC). */
export function eventSignal(events, { nowMs, lookaheadHours, highImpact, basePath }) {
  if (!Array.isArray(events)) {
    return { status: 'missing', reason: 'no macro events in snapshot', hits: [], evidence: [] };
  }
  const from = dayKey(nowMs);
  const to = dayKey(nowMs + lookaheadHours * 3_600_000);
  const needles = highImpact.map((s) => s.toLowerCase());
  const hits = [];
  const evidence = [];
  events.forEach((day, i) => {
    if (!day || typeof day.date !== 'string' || day.date < from || day.date > to) return;
    (day.events ?? []).forEach((name, j) => {
      const low = String(name).toLowerCase();
      if (needles.some((n) => low.includes(n))) {
        hits.push({ date: day.date, event: String(name) });
        evidence.push({ path: `${basePath}[${i}].events[${j}]`, value: String(name) });
      }
    });
  });
  return { status: 'ok', window: { from, to }, hits, evidence };
}

function parseRangeMidPct(label) {
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(label));
  if (!m) return null;
  return (Number(m[1]) + Number(m[2])) / 2 / 100; // "350-375" bps -> 3.625 %
}

/**
 * Summarise the FedWatch-style matrix.
 * - nextMeeting: first meeting on or after today (UTC)
 * - entropyBits: how unsettled the next decision is (0 = certain)
 * - impliedPathBps: expected-rate difference between a meeting ~3 meetings later and the next one
 *   (negative = market prices cuts, positive = hikes)
 */
export function fomcSignal(fomc, { nowMs, basePath }) {
  if (!fomc || !Array.isArray(fomc.rate_ranges) || !Array.isArray(fomc.meetings)) {
    return { status: 'missing', reason: 'no FOMC matrix in snapshot', evidence: [] };
  }
  const mids = fomc.rate_ranges.map(parseRangeMidPct);
  const today = dayKey(nowMs);

  const rows = [];
  fomc.meetings.forEach((m, idx) => {
    const probs = (m.probabilities ?? []).map((p) => (p === null || p === undefined ? null : Number(p) / 100));
    let total = 0;
    probs.forEach((p, i) => {
      if (p !== null && Number.isFinite(p) && p > 0 && mids[i] !== null) total += p;
    });
    if (total <= 0) return;
    let expected = 0;
    let entropy = 0;
    probs.forEach((p, i) => {
      if (p === null || !Number.isFinite(p) || p <= 0 || mids[i] === null) return;
      const q = p / total;
      expected += q * mids[i];
      entropy -= q * Math.log2(q);
    });
    rows.push({ idx, date: String(m.meeting_date), expected, entropy });
  });

  const upcoming = rows.filter((r) => r.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (upcoming.length === 0) {
    return { status: 'missing', reason: 'no upcoming FOMC meeting with data', evidence: [] };
  }
  const next = upcoming[0];
  const far = upcoming[Math.min(3, upcoming.length - 1)];
  const daysToNext = Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

  return {
    status: 'ok',
    nextMeeting: next.date,
    daysToNext,
    entropyBits: next.entropy,
    expectedMidPct: next.expected,
    farMeeting: far.date,
    impliedPathBps: (far.expected - next.expected) * 100,
    asOf: fomc.as_of ?? null,
    evidence: [
      { path: `${basePath}.meetings[${next.idx}].meeting_date`, value: next.date },
      { path: `${basePath}.meetings[${next.idx}].probabilities`, value: fomc.meetings[next.idx].probabilities },
    ],
  };
}
