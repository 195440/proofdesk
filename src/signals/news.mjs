// Headline tone from SoSoValue hot news (GET /openapi/v1/news/hot).
// Items: { id, source_link, release_time (ms), title, content (HTML) }.
//
// This is a transparent word-list heuristic, not a model. Each headline scores
// -1, 0 or +1; tone is the mean over ALL headlines in the window. The matching
// headlines are kept as evidence so a reader can disagree with the call.

const POSITIVE = [
  'surge', 'surges', 'rally', 'rallies', 'soar', 'soars', 'breakout', 'record high', 'all-time high',
  'inflow', 'inflows', 'approval', 'approves', 'approved', 'adopt', 'adopts', 'adoption', 'upgrade',
  'partnership', 'launches', 'gains', 'bullish',
];
const NEGATIVE = [
  'crash', 'crashes', 'plunge', 'plunges', 'slump', 'selloff', 'sell-off', 'outflow', 'outflows',
  'hack', 'hacked', 'exploit', 'exploited', 'ban', 'bans', 'lawsuit', 'sues', 'fraud', 'collapse',
  'delist', 'delists', 'liquidation', 'liquidations', 'investigation', 'probe', 'bearish', 'drops',
];

function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(text)) n += 1;
  }
  return n;
}

export function newsSignal(list, { nowMs, lookbackHours, minHeadlines, negativeTone, basePath }) {
  if (!Array.isArray(list)) {
    return { status: 'missing', reason: 'no hot news in snapshot', evidence: [] };
  }
  const since = nowMs - lookbackHours * 3_600_000;
  let total = 0;
  let sum = 0;
  const evidence = [];
  list.forEach((item, i) => {
    const t = Number(item?.release_time);
    if (!Number.isFinite(t) || t < since || t > nowMs) return;
    total += 1;
    const title = String(item.title ?? '');
    const s = Math.max(-1, Math.min(1, countHits(title, POSITIVE) - countHits(title, NEGATIVE)));
    sum += s;
    if (s !== 0) evidence.push({ path: `${basePath}[${i}].title`, value: title, tone: s });
  });
  const tone = total > 0 ? sum / total : 0;
  return {
    status: total >= minHeadlines ? 'ok' : 'thin',
    headlines: total,
    tone,
    negative: total >= minHeadlines && tone <= negativeTone,
    evidence: evidence.slice(0, 8),
  };
}
