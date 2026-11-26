export function mean(xs) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two points. */
export function sampleStd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Round to `dp` decimals; keeps plan JSON short and byte-stable. */
export function round(x, dp = 6) {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON) * f) / f;
}
