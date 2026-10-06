/** Nearest-rank percentile of an ascending array (p in 0..100). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** { n, min, p50, p95, max } in the same unit as the input. */
export function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? Number.NaN };
}
