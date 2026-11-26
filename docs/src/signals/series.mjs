// Price-series helpers. Candles from both venues are normalised to
// { t (ms), c (close), idx (position in the raw snapshot array) } so that
// every number used by a signal can be traced back to the snapshot.

export const DAY_MS = 86_400_000;

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** SoSoValue index klines: [{ timestamp, open, high, low, close }] */
export function seriesFromSoso(klines) {
  return (klines ?? [])
    .map((k, idx) => ({ t: Number(k.timestamp), c: Number(k.close), idx }))
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c) && k.c > 0)
    .sort((a, b) => a.t - b.t);
}

/** SoDEX klines: [{ t, o, h, l, c, v, q, n }] with decimal strings. */
export function seriesFromSodex(klines) {
  return (klines ?? [])
    .map((k, idx) => ({ t: Number(k.t), c: Number(k.c), idx }))
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c) && k.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Keep closed daily candles only. A candle that opened at `t` is closed once
 * `t + 1 day <= nowMs`; the in-progress candle would leak a partial day into
 * the signal and make a replay depend on when the snapshot was taken.
 */
export function closedOnly(series, nowMs) {
  return series.filter((k) => k.t + DAY_MS <= nowMs);
}
