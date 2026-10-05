// Turns the runs into figures and a side-by-side text report. Pure.

const sum = (list) => list.reduce((a, b) => a + b, 0);

/** Nearest-rank percentile of a list of numbers (0 for an empty list). */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const formatInt = (n) => Math.round(n).toLocaleString('en-GB');

/** One figure block per model. `labels` fixes the order of the columns. */
export function summarizeResults(results, labels) {
  return labels.map((label) => {
    const runs = results.filter((r) => r.model === label);
    const latencies = runs.map((r) => r.latencyMs);
    const failedChecks = {};
    const errors = {};
    for (const run of runs) {
      for (const c of run.checks) if (!c.pass) failedChecks[c.name] = (failedChecks[c.name] ?? 0) + 1;
      if (run.error) errors[run.error.code] = (errors[run.error.code] ?? 0) + 1;
    }
    const inputTokens = sum(runs.map((r) => r.tokens.inputTokens));
    const outputTokens = sum(runs.map((r) => r.tokens.outputTokens));
    return {
      label,
      runs: runs.length,
      passes: runs.filter((r) => r.pass).length,
      passRate: runs.length === 0 ? 0 : runs.filter((r) => r.pass).length / runs.length,
      answered: runs.filter((r) => !r.error).length,
      repaired: runs.filter((r) => r.repaired).length,
      latency: { mean: latencies.length === 0 ? 0 : sum(latencies) / latencies.length, median: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length === 0 ? 0 : Math.max(...latencies) },
      tokens: { input: inputTokens, output: outputTokens, perRun: runs.length === 0 ? 0 : (inputTokens + outputTokens) / runs.length },
      failedChecks,
      errors,
      answeredBy: [...new Set(runs.map((r) => r.answeredBy).filter(Boolean))].sort(),
    };
  });
}

/** For each case, how each model did: `pass`, `FAIL`, or `2/3` when it was run several times. */
export function caseMatrix(results, cases, labels) {
  return cases.map((c) => ({
    caseId: c.id,
    cells: Object.fromEntries(
      labels.map((label) => {
        const runs = results.filter((r) => r.caseId === c.id && r.model === label);
        const passes = runs.filter((r) => r.pass).length;
        const cell = runs.length === 0 ? '–' : runs.length === 1 ? (passes === 1 ? 'pass' : 'FAIL') : `${passes}/${runs.length}`;
        return [label, cell];
      }),
    ),
  }));
}

const pad = (text, width) => String(text).padEnd(width);
const padLeft = (text, width) => String(text).padStart(width);

function table(rows, widths) {
  return rows.map((row) => row.map((cell, i) => (i === 0 ? pad(cell, widths[0]) : padLeft(cell, widths[i]))).join('  ')).join('\n');
}

const topFailures = (failedChecks) =>
  Object.entries(failedChecks)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, n]) => `${name} (${n})`)
    .join('; ') || 'none';

/**
 * @param input.results all runs
 * @param input.cases   the golden cases that were used
 * @param input.labels  model labels, in column order
 * @param input.resolved label -> the model id it stands for (for the header)
 * @param input.meta    { mode, repeat, aborted }
 */
export function formatReport({ results, cases, labels, resolved = {}, meta }) {
  const summaries = summarizeResults(results, labels);
  const lines = [];
  lines.push(`Evaluation: ${cases.length} cases × ${labels.length} model${labels.length === 1 ? '' : 's'} × ${meta.repeat} run${meta.repeat === 1 ? '' : 's'} (${results.length} done) — ${meta.mode} model${meta.aborted ? ' — STOPPED EARLY' : ''}`);
  for (const label of labels) if (resolved[label] && resolved[label] !== label) lines.push(`  ${label} = ${resolved[label]}`);
  lines.push('');

  const widths = [Math.max(24, ...labels.map(() => 0)), ...labels.map((l) => Math.max(l.length, 18))];
  const rows = [
    ['', ...labels],
    ['Pass rate', ...summaries.map((s) => `${Math.round(s.passRate * 100)}% (${s.passes}/${s.runs})`)],
    ['Answered', ...summaries.map((s) => `${s.answered}/${s.runs}`)],
    ['Needed a repair', ...summaries.map((s) => String(s.repaired))],
    ['Latency median / p95', ...summaries.map((s) => `${formatMs(s.latency.median)} / ${formatMs(s.latency.p95)}`)],
    ['Latency slowest', ...summaries.map((s) => formatMs(s.latency.max))],
    ['Tokens in / out', ...summaries.map((s) => `${formatInt(s.tokens.input)} / ${formatInt(s.tokens.output)}`)],
    ['Tokens per run', ...summaries.map((s) => formatInt(s.tokens.perRun))],
  ];
  lines.push(table(rows, widths));
  lines.push('');
  lines.push('Most common failed checks:');
  for (const s of summaries) lines.push(`  ${s.label}: ${topFailures(s.failedChecks)}`);
  const errored = summaries.filter((s) => Object.keys(s.errors).length > 0);
  if (errored.length > 0) {
    lines.push('Errors:');
    for (const s of errored) lines.push(`  ${s.label}: ${Object.entries(s.errors).map(([code, n]) => `${code} × ${n}`).join(', ')}`);
  }
  lines.push('');

  const matrix = caseMatrix(results, cases, labels);
  const caseWidth = Math.max(4, ...matrix.map((m) => m.caseId.length));
  lines.push(table([['Case', ...labels], ...matrix.map((m) => [m.caseId, ...labels.map((l) => m.cells[l])])], [caseWidth, ...labels.map((l) => Math.max(l.length, 6))]));

  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push('', `Failures (${failures.length}):`);
    for (const f of failures.slice(0, 20)) {
      const failed = f.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
      lines.push(`  ${f.model} · ${f.caseId}${f.run > 1 ? ` #${f.run}` : ''}: ${failed.join(' | ')}`);
    }
    if (failures.length > 20) lines.push(`  … and ${failures.length - 20} more (see the saved results)`);
  }
  return lines.join('\n');
}
