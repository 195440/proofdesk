// SYNTHETIC SoSoValue-shaped data for tests and the offline demo.
//
// Every number here is generated from a seeded PRNG. It follows the response
// shapes documented at https://sosovalue-1.gitbook.io/sosovalue-api-doc but it
// is NOT market data. Anything built from it must be labelled as a fixture.

const DAY = 86_400_000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Daily closes with a drift and noise; newest candle is the last CLOSED day. */
function indexKlines(rand, nowMs, days, driftPerDay, noise, start) {
  const last = dayStart(nowMs) - DAY;
  const out = [];
  let px = start;
  for (let i = days - 1; i >= 0; i -= 1) {
    const open = px;
    px = px * (1 + driftPerDay + (rand() - 0.5) * 2 * noise);
    const high = Math.max(open, px) * (1 + rand() * noise * 0.4);
    const low = Math.min(open, px) * (1 - rand() * noise * 0.4);
    out.push({ timestamp: last - i * DAY, open: +open.toFixed(4), high: +high.toFixed(4), low: +low.toFixed(4), close: +px.toFixed(4) });
  }
  return out;
}

/** ETF summary rows, newest first, like the real endpoint. */
function etfRows(rand, nowMs, days, baseM, lastFiveBoost) {
  const rows = [];
  let cum = 1.2e10;
  const last = dayStart(nowMs) - DAY;
  for (let i = 0; i < days; i += 1) {
    const base = (rand() - 0.5) * 2 * baseM;
    const v = Math.round(i < 5 ? base + lastFiveBoost : base);
    rows.push({
      date: iso(last - i * DAY),
      total_net_inflow: v,
      total_value_traded: Math.round(2e9 + rand() * 1e9),
      total_net_assets: Math.round(5.6e10 + rand() * 1e9),
      cum_net_inflow: Math.round(cum),
    });
    cum -= v;
  }
  return rows;
}

/**
 * @param {number} nowMs
 * @param {{ bullish?: boolean, seed?: number }} [o]
 */
export function syntheticSosovalue(nowMs, { bullish = true, seed = 20261120 } = {}) {
  const rand = mulberry32(seed);
  const boost = bullish ? 220e6 : -220e6;
  const tomorrow = iso(dayStart(nowMs) + DAY);
  const meeting = iso(dayStart(nowMs) + 18 * DAY);
  const meeting2 = iso(dayStart(nowMs) + 60 * DAY);
  const titles = bullish
    ? [
        'Spot BTC ETFs record fresh inflows as risk appetite returns',
        'Ethereum ETF inflows extend winning streak',
        'Major exchange launches new SSI index product',
        'Solana ETF approval odds climb',
        'Crypto market cap gains for third straight day',
        'Fed speaker signals patience on rates',
        'Stablecoin supply reaches new high',
        'Layer-1 token slips after unlock',
      ]
    : [
        'Spot BTC ETFs see heavy outflows',
        'Exchange hack drains hot wallet, withdrawals paused',
        'Liquidations top $1B as BTC plunges',
        'Regulator opens investigation into token issuer',
        'Altcoins slump as risk appetite fades',
        'Ethereum ETF outflows extend',
        'Fed speaker warns inflation not yet tamed',
        'Stablecoin supply flat',
      ];
  const list = titles.map((t, i) => ({
    id: 900000 + i,
    source_link: `https://example.invalid/sample/${900000 + i}`,
    release_time: nowMs - (i + 1) * 3 * 3_600_000,
    title: `[SAMPLE] ${t}`,
    content: '<p>synthetic fixture content</p>',
  }));

  return {
    indices: ['ssimag7', 'ssidefi', 'ssimeme', 'ssilayer1'],
    indexData: {
      ssimag7: {
        klines: indexKlines(rand, nowMs, 90, bullish ? 0.004 : -0.004, 0.012, 20),
        constituents: [
          { currency_id: '1', symbol: 'btc', weight: 0.31 },
          { currency_id: '2', symbol: 'eth', weight: 0.2 },
          { currency_id: '3', symbol: 'sol', weight: 0.1 },
        ],
        snapshot: { price: 20.93, change_pct_24h: 0.004, roi_7d: 0.03, roi_1m: 0.11, roi_3m: 0.2 },
      },
      ssidefi: {
        klines: indexKlines(rand, nowMs, 90, bullish ? 0.003 : -0.005, 0.016, 8),
        constituents: [
          { currency_id: '10', symbol: 'uni', weight: 0.25 },
          { currency_id: '11', symbol: 'aave', weight: 0.25 },
        ],
        snapshot: { price: 8.4, change_pct_24h: 0.002, roi_7d: 0.02, roi_1m: 0.08, roi_3m: 0.15 },
      },
      ssimeme: {
        klines: indexKlines(rand, nowMs, 90, -0.004, 0.03, 3),
        constituents: [
          { currency_id: '20', symbol: 'doge', weight: 0.4 },
          { currency_id: '21', symbol: 'shib', weight: 0.2 },
        ],
        snapshot: { price: 2.1, change_pct_24h: -0.01, roi_7d: -0.05, roi_1m: -0.18, roi_3m: -0.3 },
      },
    },
    etf: {
      BTC: { US: etfRows(rand, nowMs, 30, 150e6, boost) },
      ETH: { US: etfRows(rand, nowMs, 30, 60e6, boost / 3) },
      SOL: { US: etfRows(rand, nowMs, 30, 8e6, boost / 20) },
    },
    newsHot: { page: 1, page_size: 50, total: list.length, list },
    macroEvents: [{ date: tomorrow, events: ['CPI'] }],
    fomc: {
      rate_ranges: ['300-325', '325-350', '350-375', '375-400', '400-425'],
      meetings: [
        { meeting_date: meeting, probabilities: ['0.0', '0.0', '41.1', '58.9', null] },
        { meeting_date: meeting2, probabilities: ['0.0', '30.2', '54.2', '15.7', '0.0'] },
      ],
      as_of: nowMs,
    },
    overview: {
      total_market_cap: '2280614829402.85',
      total_market_cap_change_pct: bullish ? '0.6' : '-6.2',
      total_volume_24h: '40122576829.22',
      as_of: nowMs,
    },
    errors: {},
  };
}
