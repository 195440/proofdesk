// One place that decides where an asset's price history comes from, shared by
// the plan engine and the backtest.

import { seriesFromSoso, seriesFromSodex } from './signals/series.mjs';

/**
 * @returns {{series:Array, basePath:string, field:string}|{error:string}}
 */
export function assetSeries(snapshot, asset) {
  const soso = snapshot.sosovalue ?? null;
  const sodex = snapshot.sodex ?? {};
  if (asset.momentum.source === 'sosovalue') {
    const key = asset.momentum.index.toLowerCase();
    if (!soso) return { error: 'no SoSoValue data in snapshot' };
    const known = new Set((soso.indices ?? []).map((s) => String(s).toLowerCase()));
    if (!known.has(key) || !soso.indexData?.[key]?.klines) {
      return { error: `SoSoValue index ${asset.momentum.index} not available` };
    }
    return {
      series: seriesFromSoso(soso.indexData[key].klines),
      basePath: `sosovalue.indexData.${key}.klines`,
      field: 'close',
    };
  }
  const k = sodex.klines?.[asset.sodex];
  if (!Array.isArray(k)) return { error: `no SoDEX klines for ${asset.sodex}` };
  return { series: seriesFromSodex(k), basePath: `sodex.klines.${asset.sodex}`, field: 'c' };
}
