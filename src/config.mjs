// Default desk configuration. The whole object is hashed into every plan, so a
// replay with a different config is detected instead of silently accepted.

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  // Portfolio value used when no holdings file is given (all cash).
  navUsd: 1000,
  // Tradable universe. `sodex` is the SoDEX spot symbol that actually gets
  // traded. `momentum.source` says where the price history comes from:
  //   sosovalue -> SoSoValue SSI index klines (matched against /indices at runtime)
  //   sodex     -> SoDEX public klines of the traded symbol itself
  // `etf` links an asset to its spot-ETF flow series on SoSoValue.
  universe: [
    { id: 'BTC', sodex: 'vBTC_vUSDC', momentum: { source: 'sodex' }, etf: 'BTC' },
    { id: 'ETH', sodex: 'vETH_vUSDC', momentum: { source: 'sodex' }, etf: 'ETH' },
    { id: 'SOL', sodex: 'vSOL_vUSDC', momentum: { source: 'sodex' }, etf: 'SOL' },
    { id: 'MAG7.ssi', sodex: 'vMAG7ssi_vUSDC', momentum: { source: 'sosovalue', index: 'ssimag7' } },
    { id: 'DEFI.ssi', sodex: 'vDEFIssi_vUSDC', momentum: { source: 'sosovalue', index: 'ssidefi' } },
    { id: 'MEME.ssi', sodex: 'vMEMEssi_vUSDC', momentum: { source: 'sosovalue', index: 'ssimeme' } },
  ],
  regime: {
    // Spot-ETF flow z-score thresholds (latest 5-day net inflow vs earlier 5-day windows).
    flowWindowDays: 5,
    zOn: 0.5,
    zOff: -0.5,
    // ETF symbols that vote on the market regime.
    voters: ['BTC', 'ETH'],
    country: 'US',
  },
  budget: {
    // Fraction of NAV allowed in risk assets per regime.
    RISK_ON: 0.9,
    NEUTRAL: 0.6,
    RISK_OFF: 0.25,
    eventMultiplier: 0.75,
    newsMultiplier: 0.85,
    circuitBreakerBudget: 0.1,
    // 24h change of total crypto market cap (percent) at or below which we de-risk hard.
    circuitBreakerMcapDropPct: -5,
  },
  allocation: {
    maxWeight: 0.4,
    // Skip trades whose weight change is smaller than this.
    noTradeBand: 0.02,
    // Max sum of |weight change| executed in one rebalance.
    maxTurnover: 0.5,
    // How strongly ETF-flow z-score tilts the momentum score of its asset.
    flowTiltWeight: 0.5,
    momentumClip: 3,
    momentumDays: 30,
    shortDays: 7,
  },
  macro: {
    // Event names containing any of these (case-insensitive) count as high impact.
    highImpact: ['CPI', 'Nonfarm Payrolls', 'FOMC', 'PCE', 'PPI', 'Interest Rate Decision'],
    lookaheadHours: 48,
    // FOMC distribution is "unsettled" when its entropy (bits) is at least this and the meeting is near.
    fomcEntropyBits: 0.8,
    fomcNearDays: 2,
  },
  news: {
    lookbackHours: 48,
    minHeadlines: 5,
    negativeTone: -0.4,
  },
  execution: {
    maxSlippageBps: 30,
    // Fraction of the 24h quote volume one rebalance leg may not exceed.
    maxShareOfDailyVolume: 0.25,
  },
  backtest: {
    minDays: 45,
    rebalanceEveryDays: 7,
    // SoDEX spot taker fee (0.065%) plus an extra slippage allowance, charged on traded notional.
    takerFeeBps: 6.5,
    extraSlippageBps: 10,
  },
});
