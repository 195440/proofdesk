# Proofdesk

**A rebalancing desk where every trade carries receipts.**

Proofdesk turns [SoSoValue](https://sosovalue.com) market data into a risk-gated rebalance plan, checks every order against the live [SoDEX](https://sodex.com) order book, and publishes the result in a form anyone can replay byte for byte, in their own browser, without trusting us.

> Status of this README: the SoDEX side runs against the live mainnet public API today. The SoSoValue side is built from the official OpenAPI spec and docs and is exercised end to end against stand-in servers; see [Verification status](#verification-status).

## The problem

Trading assistants hand you a call you cannot audit ("risk-on, buy X"), and on a young venue the call is often not even executable: SoDEX spot books are thin (on the day we captured them, BTC traded about $30k in 24 hours and several books had 50+ bps spreads). A plan that ignores depth is a paper plan.

## What Proofdesk does differently

1. **Every claim has a receipt.** Each signal lists the exact snapshot field and value it rests on (for example `sosovalue.etf.BTC.US[4].total_net_inflow = 287985135` in the demo fixture).
2. **The decision is a pure function.** `buildPlan(snapshot, config, holdings)` never reads the clock, the network or the environment. Same inputs, same bytes, same `planHash`.
3. **Replay it yourself.** The published page loads `data/snapshot.json` and `data/plan.json` and re-runs the same engine in your browser (16 ms), checking hashes and every receipt. A second button changes one number and shows the check fail.
4. **Execution-aware.** Each rebalance leg walks the real SoDEX book, is shrunk to fit a slippage limit and a share of 24h volume, and must pass SoDEX's own price, lot and notional filters before it is allowed into the plan.
5. **It never trades by itself.** The output is an *unsigned* `BatchNewOrderRequest` preview. There is no signing code and no order-sending code in this repository.

## How it works

```
SoSoValue Open API                              SoDEX public REST (no key)
  /etfs/summary-history  (BTC, ETH, SOL)          /markets/symbols    lot / tick / notional rules, status
  /indices, /klines, /constituents,               /markets/tickers    24h volume
  /market-snapshot       (SSI indices)            /markets/{s}/orderbook   depth
  /news/hot                                       /markets/{s}/klines      majors' price history
  /macro/events, /macro/fomc-probabilities
  /market/overview
          \                                          /
           +-------------> snapshot.json <----------+      sha256 of canonical JSON
                               |
                               v
   signals ---> regime (ETF-flow z-score, BTC+ETH voters)
           ---> momentum (30d/7d, volatility-adjusted, closed candles only)
           ---> gates: event risk (CPI/NFP/FOMC odds), negative news tone, market-cap circuit breaker
                               |
                               v
   risk budget -> long-only weights (cap, no-trade band, turnover cap)
                               |
                               v
   legs: order-book walk, slippage limit, volume cap, exchange filters ("preflight")
                               |
                               v
   plan.json  (inputs + config + holdings + signals + claims + legs + unsigned orders + planHash)
```

### What each SoSoValue endpoint drives

| Endpoint | Used for |
| --- | --- |
| `GET /openapi/v1/etfs/summary-history` | Market regime: latest 5-day net inflow vs earlier 5-day windows (z-score), BTC + ETH vote; per-asset flow tilt for BTC / ETH / SOL |
| `GET /openapi/v1/indices`, `/{t}/klines` | Momentum for SSI assets (MAG7.ssi, DEFI.ssi, MEME.ssi); ticker availability is checked against `/indices` at runtime |
| `GET /openapi/v1/indices/{t}/constituents`, `/market-snapshot` | Collected into the snapshot for context |
| `GET /openapi/v1/news/hot` | Headline tone gate (word-list heuristic, see limitations) |
| `GET /openapi/v1/macro/events` | High-impact events (CPI, NFP, PCE, PPI, FOMC...) inside the next 48 hours |
| `GET /openapi/v1/macro/fomc-probabilities` | How unsettled the next FOMC decision is (entropy of the target-rate distribution) and the implied rate path |
| `GET /openapi/v1/market/overview` | Circuit breaker on a sharp 24h market-cap drop |

One run is 17 SoSoValue requests, inside the documented 20 requests/minute; the client also throttles itself, honours `retry_after` on HTTP 429, and never writes the key anywhere.

### What SoDEX drives

Symbol rules and status, 24h volume, order-book depth, and daily klines for BTC / ETH / SOL. All requests are unsigned `GET`s.

## Quick start

Requires Node 22+. No dependencies.

```bash
npm test                 # unit + integration tests
npm run demo             # offline demo -> docs-demo/index.html (no key, no network)
```

Live run (needs a SoSoValue API key from <https://sosovalue.com/developer/dashboard>):

```bash
cp .env.example .env     # put SOSOVALUE_API_KEY in it; .env is git-ignored
node src/cli.mjs run --site docs      # collect -> plan -> report
node src/cli.mjs plan --nav 5000 --holdings holdings.json   # re-plan from data/snapshot.json
```

A rejected key (HTTP 401) stops the run after the first request and writes nothing, so a bad key can never publish a "live" page with the whole SoSoValue half missing. One endpoint answering 403 (a key without access to it) or failing otherwise is only a data gap, listed on the page.

`holdings.json`: `{ "cashUsd": 200, "positionsUsd": { "BTC": 500, "ETH": 300 } }`.
Without a key, `collect` still gathers SoDEX data and the plan lists every missing SoSoValue input as a data gap and falls back to a NEUTRAL regime.

## Verify a plan

```bash
node src/cli.mjs verify --snapshot docs/data/snapshot.json --plan docs/data/plan.json
```

It checks the snapshot hash, the config hash, the plan's own hash, then **rebuilds the plan from scratch** and compares it, then resolves every receipt path against the snapshot. Edit any number in the snapshot and the check fails (when the number backs a claim, the failure names the exact field and both values; otherwise the hash comparison catches it). Edit the plan, or even the plan together with a recomputed hash, and the from-scratch rebuild no longer matches, so the check still fails.

## Honest limitations

- **The backtest covers only the price part of the rules.** SoSoValue serves about 1 month of ETF flows, 7 days of news and 3 months of index klines, and the FOMC matrix only as of now. The backtest therefore uses a price-breadth proxy for the regime, trades weekly, and charges 6.5 bps fee + 10 bps slippage. On roughly 60-70 days of data it checks that the rules behave sanely; it is **not evidence of alpha**. When the window is a drawdown (or a rally) the report says so, because a rule that holds cash looks good in a falling market by construction.
- **News tone is a word list, not a model.** It is transparent and the matching headlines are shown as receipts, but it is crude.
- **SSI assets are scored from the SoSoValue index series, not from the SoDEX token price.** The token trades thinly and may deviate from the index.
- **Long-only, spot-only, USDC as cash.** No perps, no shorting, no yield on cash.
- **Fixtures are labelled.** `npm run demo` uses a *real* SoDEX capture (2026-11-20) plus *synthetic* SoSoValue-shaped data (`fixtures/synthetic.mjs`, seeded PRNG). The page and the snapshot say so in red; nothing from the fixture is market data on the SoSoValue side.

## Verification status

| Part | Status |
| --- | --- |
| SoDEX public REST (symbols, tickers, order book, klines) | Verified against live mainnet; prices cross-checked against an independent BTC quote |
| SoDEX order filters | Implemented from the documented "Place order" rules; unit-tested; **not** sent to an exchange |
| SoSoValue client and collectors | Written from the official OpenAPI spec and doc examples; unit-tested (auth header, envelope, 429 handling, throttling, 401 abort versus 403 gap) and exercised end to end against a stand-in server. A first live run with a real key is the one thing not yet done in this repository's history |
| Engine, replay, browser replay | Tested; the browser replay was exercised in a real browser and its hashes equal the Node ones |

### Test suite

`npm test` runs in about a second. Beyond the usual cases it includes: hand-computed z-scores and FOMC entropy, look-ahead guards for the open daily candle and for the backtest, "forged decision with a recomputed hash" (only the replay catches it), key-leak checks over every written file, and a full collect, plan, verify, render run against stand-in servers. The suite was mutation-checked: 12 injected defects (slippage limit ignored, throttle off by one, peeking at the open candle, wrong standard deviation, receipt check disabled, look-ahead in the backtest, unsorted canonical keys, undisclosed turnover cap, substring news matching, replay that skips the hash comparison, sells priced off the ask side, ignored `retry_after`) are all caught.

## Layout

```
src/canonical.mjs, sha256.mjs     canonical JSON + dependency-free SHA-256 (also runs in the browser)
src/soso/client.mjs               SoSoValue client: throttle, 429 retry, envelope checks, key scrubbing
src/sodex/client.mjs              SoDEX public client (GET only)
src/signals/                      flows, momentum, macro (events + FOMC), news
src/engine/plan.mjs               buildPlan / verifyPlan
src/engine/execution.mjs          order-book walk, legalisation, exchange filters, unsigned order preview
src/engine/backtest.mjs           price-only backtest
src/report/                       terminal + static HTML report
fixtures/                         real SoDEX capture + synthetic SoSoValue-shaped generator
```

## Security

The API key is read from `SOSOVALUE_API_KEY`, sent only in one header (`x-soso-api-key`, as the OpenAPI spec and curl examples say; `SOSOVALUE_KEY_HEADER=X-API-KEY` switches it, because one error example in the docs names that header instead) to `openapi.sosovalue.com`, scrubbed from error messages, and never written to snapshots, plans or the site (a test scans every output file for it). Do not commit `.env`.

## License

MIT
