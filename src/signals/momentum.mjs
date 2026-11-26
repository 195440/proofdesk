// Risk-adjusted momentum from closed daily candles.
//   score = clamp(0.7 * r30 / (vol * sqrt(30)) + 0.3 * r7 / (vol * sqrt(7)), -clip, clip)
// where vol is the sample std of the last `days` daily returns.

import { clamp, sampleStd } from './stats.mjs';

/**
 * @param {Array<{t:number,c:number,idx:number}>} series ascending, closed candles only
 * @param {{days:number, shortDays:number, clip:number, basePath:string, field:string}} o
 */
export function momentumSignal(series, { days, shortDays, clip, basePath, field }) {
  const n = series.length;
  if (n < days + 1) {
    return { status: 'insufficient', reason: `need >= ${days + 1} closed daily candles, have ${n}`, evidence: [] };
  }
  const last = series[n - 1];
  const back = (k) => series[n - 1 - k];

  const rets = [];
  for (let j = n - days; j < n; j += 1) rets.push(series[j].c / series[j - 1].c - 1);
  const vol = sampleStd(rets);

  const rLong = last.c / back(days).c - 1;
  const rShort = last.c / back(shortDays).c - 1;
  const raLong = vol > 0 ? rLong / (vol * Math.sqrt(days)) : 0;
  const raShort = vol > 0 ? rShort / (vol * Math.sqrt(shortDays)) : 0;
  const score = clamp(0.7 * raLong + 0.3 * raShort, -clip, clip);

  let peak = -Infinity;
  let maxDd = 0;
  for (let j = n - 1 - days; j < n; j += 1) {
    peak = Math.max(peak, series[j].c);
    maxDd = Math.min(maxDd, series[j].c / peak - 1);
  }

  const evidence = [back(days), back(shortDays), last].map((k) => ({
    path: `${basePath}[${k.idx}].${field}`,
    value: k.c,
  }));

  return {
    status: 'ok',
    asOf: new Date(last.t).toISOString().slice(0, 10),
    lastClose: last.c,
    r7: rShort,
    r30: rLong,
    dailyVol: vol,
    maxDrawdown: maxDd,
    score,
    evidence,
  };
}
