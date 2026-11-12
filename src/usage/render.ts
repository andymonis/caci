import { DELETED_ACCOUNT, type Report, type ReportGroup } from './report.js';

const money = (n: number): string => n.toFixed(4);
const whole = (n: number): string => n.toLocaleString('en-GB');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Pads a table of text cells into aligned columns (first column left, the rest right). */
function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number))).join('  ').trimEnd());
}

const groupRow = (g: ReportGroup): string[] => [g.key, whole(g.calls), whole(g.attempts), whole(g.inputTokens), whole(g.outputTokens), whole(g.cacheReadTokens), money(g.cost) + (g.unpricedAttempts > 0 ? '*' : '')];

/** The report as plain text for a terminal: one table, the averages, the rates, the spread, what is unpriced and, if given, the invoice. */
export function renderReport(report: Report, extra: { readonly period?: string; readonly invoice?: { readonly estimate: number; readonly invoice: number; readonly difference: number; readonly percent: number | null } } = {}): string {
  const out: string[] = [];
  out.push(`Usage report by ${report.by}${extra.period === undefined ? '' : `, ${extra.period}`}`);
  out.push(`Estimated cost in ${report.currency} (prices as of ${report.asOf}). It is an estimate: the provider's invoice is the truth.`);
  out.push('');
  out.push(...table([report.by, 'calls', 'attempts', 'input', 'output', 'cache read', `cost ${report.currency}`], [...report.groups.map(groupRow), groupRow({ key: 'total', ...report.totals })]));
  if (report.totals.unpricedAttempts > 0) out.push('* includes attempts on a model with no price (their tokens are counted, their cost is not)');
  out.push('');
  out.push('Average cost of one call (repairs included):');
  if (report.perCall.length === 0) out.push('  no calls in this period');
  for (const c of report.perCall) out.push(`  ${c.capability}: ${c.averageCost === null ? 'unpriced' : money(c.averageCost)} over ${whole(c.pricedCalls)} priced of ${whole(c.calls)} calls`);
  out.push('');
  out.push(`Repairs: ${report.repairRate.toFixed(2)} extra attempts per call; ${pct(report.rejectedRate)} of attempts refused by the checks; ${pct(report.failedRate)} of attempts failed with no answer.`);
  out.push('');
  const d = report.distribution;
  out.push(`Spread over ${whole(d.people)} ${d.people === 1 ? 'person' : 'people'}: mean ${money(d.mean)}, median ${money(d.median)}, 90th percentile ${money(d.p90)}, highest ${money(d.max)}; the top tenth spent ${pct(d.topTenthShare)} of it.`);
  if (report.topSpenders.length > 0) {
    out.push('Top spenders:');
    for (const s of report.topSpenders) out.push(`  ${s.label}: ${money(s.cost)} (${pct(s.share)})`);
  }
  if (report.deletedCost > 0) out.push(`${DELETED_ACCOUNT}s: ${money(report.deletedCost)} (not counted above)`);
  if (report.unpriced.length > 0) {
    out.push('');
    out.push('Models with no price (add them to usage-prices.json):');
    for (const u of report.unpriced) out.push(`  ${u.model}: ${whole(u.attempts)} attempts, ${whole(u.inputTokens)} input and ${whole(u.outputTokens)} output tokens`);
  }
  if (extra.invoice !== undefined) {
    const i = extra.invoice;
    out.push('');
    out.push(`Invoice: you gave ${money(i.invoice)} ${report.currency}; the estimate is ${money(i.estimate)}; the difference is ${i.difference >= 0 ? '+' : '-'}${money(Math.abs(i.difference))}${i.percent === null ? '' : ` (${i.percent >= 0 ? '+' : '-'}${Math.abs(i.percent).toFixed(1)}%)`}.`);
  }
  return `${out.join('\n')}\n`;
}

/** One CSV cell: quoted when needed, and a leading equals sign, plus, minus, at sign or tab is made harmless so a spreadsheet does not read it as a formula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The report's groups as CSV (one header line, one line per group, a total line), with a final newline. */
export function reportCsv(report: Report): string {
  const header = [report.by, 'calls', 'attempts', 'rejected', 'failed', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'latencyMs', `cost${report.currency}`, 'unpricedAttempts'];
  const line = (g: ReportGroup): string => [g.key, g.calls, g.attempts, g.rejected, g.failed, g.inputTokens, g.outputTokens, g.cacheReadTokens, g.cacheCreationTokens, g.latencyMs, g.cost.toFixed(6), g.unpricedAttempts].map(csvCell).join(',');
  return `${[header.map(csvCell).join(','), ...report.groups.map(line), line({ key: 'total', ...report.totals })].join('\n')}\n`;
}
