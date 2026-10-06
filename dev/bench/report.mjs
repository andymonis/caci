const ms = (n) => (Number.isFinite(n) ? (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) : '-');

/** A text table per run, plus the verdict against the NFR-05 target. */
export function formatReport(runs, { nodeVersion = 'unknown' } = {}) {
  const lines = [];
  for (const run of runs) {
    lines.push(`${run.adapter}: ${run.items} items, ${run.categories} categories, ${run.edges} edges (seed ${run.seed}); built in ${(run.buildMs / 1000).toFixed(1)} s`);
    const rows = run.results.map((r) => ({
      name: r.name,
      n: String(r.stats.n),
      p50: ms(r.stats.p50),
      p95: ms(r.stats.p95),
      max: ms(r.stats.max),
      target: r.targetMs === undefined ? '' : `< ${r.targetMs}`,
      verdict: r.targetMs === undefined ? '' : r.stats.p95 < r.targetMs ? 'ok' : 'OVER TARGET',
    }));
    const head = { name: 'operation', n: 'n', p50: 'p50 ms', p95: 'p95 ms', max: 'max ms', target: 'target', verdict: '' };
    const all = [head, ...rows];
    const width = (key) => Math.max(...all.map((r) => r[key].length));
    for (const r of all) {
      lines.push(`  ${r.name.padEnd(width('name'))}  ${r.n.padStart(width('n'))}  ${r.p50.padStart(width('p50'))}  ${r.p95.padStart(width('p95'))}  ${r.max.padStart(width('max'))}  ${r.target.padStart(width('target'))}  ${r.verdict}`.trimEnd());
    }
    lines.push('');
  }
  lines.push(`Node ${nodeVersion}. NFR-05 target: single-category lookup under 20 ms (p95); the three-clause set query is measured after M4b. A baseline to measure, not a promise.`);
  return lines.join('\n');
}

/** The operations that missed their target, as plain sentences (the Backlog wants the number). */
export function overTarget(runs) {
  return runs.flatMap((run) => run.results.filter((r) => r.targetMs !== undefined && !(r.stats.p95 < r.targetMs)).map((r) => `${run.adapter}: ${r.name} p95 ${ms(r.stats.p95)} ms, target ${r.targetMs} ms`));
}
