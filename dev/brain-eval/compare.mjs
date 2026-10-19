// Comparing two saved runs (R-013 D15): pure. `a` is the earlier run, `b` the later; every change is "from a to b".
import { replacementCounts } from './report.mjs';
import { aggregate } from './score.mjs';

const pct = (x) => `${Math.round(x * 100)}%`;
const pp = (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)} pp`;
const unique = (list) => [...new Set(list)];
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => `  ${r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()}`).join('\n');
};

/** What differs between the scenarios and questions two runs used, as sentences. Empty means the same. */
export function scenarioDifferences(a, b) {
  const out = [];
  const A = new Map((a.scenarios ?? []).map((s) => [s.id, s]));
  const B = new Map((b.scenarios ?? []).map((s) => [s.id, s]));
  for (const id of A.keys()) if (!B.has(id)) out.push(`scenario ${id} is only in the first run`);
  for (const id of B.keys()) if (!A.has(id)) out.push(`scenario ${id} is only in the second run`);
  for (const [id, sa] of A) {
    const sb = B.get(id);
    if (sb === undefined) continue;
    const qa = sa.questions.map((q) => `${q.id}:${q.kind}`);
    const qb = sb.questions.map((q) => `${q.id}:${q.kind}`);
    if (JSON.stringify(qa) !== JSON.stringify(qb)) out.push(`the questions of ${id} differ`);
    else if (sa.hash !== sb.hash) out.push(`the notes or questions of ${id} were edited between the runs`);
  }
  return out;
}

const describeRun = (label, r) => [
  `${label}: ${r.startedAt ?? 'unknown time'} · ${r.mode ?? '?'} · controls ${r.controls ?? 'the shipped controls/ folder'}`,
  `   arms ${(r.arms ?? []).join(', ')} · filed with ${r.fileWith ?? 'n/a'} · answered by ${(r.answerWith ?? []).join(', ')} · repeats ${r.repeat ?? '?'} · filler ${(r.pads ?? [0]).join(', ')} (seed ${r.seed ?? 1})${r.aborted ? ' · STOPPED EARLY' : ''}`,
];

const cellsOf = (run) => {
  const cells = new Map();
  for (const rec of run.results ?? []) {
    const key = `${rec.pad ?? 0}|${rec.arm}|${rec.model}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(rec);
  }
  return cells;
};

const answerText = (rec) => (rec.error !== null ? `error ${rec.error.code ?? rec.error.source}` : rec.overWindow ? 'not sent: over the window' : rec.answer === null ? 'no answer' : JSON.stringify([rec.answer.headline, ...rec.answer.points]).slice(0, 240));

/**
 * @returns `{ ok: true, text }` or `{ ok: false, message }`.
 * Refuses runs of different scenarios or questions unless `force`, naming the difference.
 */
export function compareRuns(a, b, { force = false } = {}) {
  for (const [name, run] of [['first', a], ['second', b]]) {
    if (run === null || typeof run !== 'object' || run.kind !== 'brain-eval' || !Array.isArray(run.results)) return { ok: false, message: `the ${name} file is not a saved brain-eval result` };
  }
  const differences = scenarioDifferences(a, b);
  if (differences.length > 0 && !force) {
    return { ok: false, message: `These runs did not use the same scenarios and questions, so the numbers are not comparable:\n${differences.map((d) => `  - ${d}`).join('\n')}\nUse --force to compare what they share anyway.` };
  }
  const out = ['Comparing two brain-eval runs (changes are from the first to the second)', ...describeRun('first ', a), ...describeRun('second', b)];
  if (differences.length > 0) out.push('', 'WARNING (--force): the runs differ, so only what they share is compared:', ...differences.map((d) => `  - ${d}`));

  const ca = cellsOf(a);
  const cb = cellsOf(b);
  const keys = unique([...ca.keys(), ...cb.keys()]).sort((x, y) => {
    const [px, ...rx] = x.split('|');
    const [py, ...ry] = y.split('|');
    return Number(px) - Number(py) || rx.join('|').localeCompare(ry.join('|'));
  });
  const multiPad = unique(keys.map((k) => k.split('|')[0])).length > 1;
  const label = (key) => { const [pad, arm, model] = key.split('|'); return multiPad ? [`${pad}`, arm, model] : [arm, model]; };

  out.push('', 'Pass rate and old-fact-as-current rate, by arm and answering model');
  out.push(table([[...(multiPad ? ['filler'] : []), 'arm', 'model', 'pass', 'change', 'old fact as current', 'change'], ...keys.map((key) => {
    const ra = ca.get(key);
    const rb = cb.get(key);
    if (ra === undefined) return [...label(key), 'only in the second run', '', '', ''];
    if (rb === undefined) return [...label(key), 'only in the first run', '', '', ''];
    const x = aggregate(ra.map((r) => r.score));
    const y = aggregate(rb.map((r) => r.score));
    return [...label(key), `${pct(x.passRate)} → ${pct(y.passRate)}`, pp(y.passRate - x.passRate), `${pct(x.staleSurfacedRate)} → ${pct(y.staleSurfacedRate)}`, pp(y.staleSurfacedRate - x.staleSurfacedRate)];
  })]));

  const shared = keys.filter((k) => ca.has(k) && cb.has(k));
  const regressed = [];
  const improved = [];
  let changed = 0;
  for (const key of shared) {
    const byQuestion = (recs) => { const m = new Map(); for (const r of recs) { const k = `${r.scenario}/${r.question}`; (m.get(k) ?? m.set(k, []).get(k)).push(r); } return m; };
    const qa = byQuestion(ca.get(key));
    const qb = byQuestion(cb.get(key));
    for (const [q, ra] of qa) {
      const rb = qb.get(q);
      if (rb === undefined) continue;
      const pa = ra.filter((r) => r.pass).length;
      const pb = rb.filter((r) => r.pass).length;
      const rateA = pa / ra.length;
      const rateB = pb / rb.length;
      if (rateA !== rateB) changed++;
      const wasPass = rateA >= 0.5;
      const isPass = rateB >= 0.5;
      const item = { key, q, from: `${pa}/${ra.length}`, to: `${pb}/${rb.length}`, before: ra.find((r) => !r.pass) ?? ra[0], after: rb.find((r) => !r.pass) ?? rb[0] };
      if (wasPass && !isPass) regressed.push(item);
      else if (!wasPass && isPass) improved.push(item);
    }
  }
  const show = (title, items) => {
    out.push('', `${title} (${items.length})`);
    if (items.length === 0) out.push('  none');
    for (const it of items) {
      const [pad, arm, model] = it.key.split('|');
      out.push(`  ${multiPad ? `filler ${pad} · ` : ''}${arm} ${model} · ${it.q}: ${it.from} → ${it.to}`, `      first:  ${answerText(it.before)}`, `      second: ${answerText(it.after)}`);
    }
  };
  const ra = replacementCounts(a.filing ?? [], a.results);
  const rb = replacementCounts(b.filing ?? [], b.results);
  if (ra !== null || rb !== null) {
    const line = (c) => (c === null ? 'not recorded' : `${c.notes} notes replaced ${c.removed} older notes, ${c.tidied} empty categories left to tidy, ${c.wrong} failed answers lost a fact to a deletion`);
    out.push('', 'Replacing', `  first:  ${line(ra)}${a.replace === false ? ' (replacing was off)' : ''}`, `  second: ${line(rb)}${b.replace === false ? ' (replacing was off)' : ''}`);
  }
  show('Questions that went from passing to failing', regressed);
  show('Questions that went from failing to passing', improved);
  out.push('', `${changed} question${changed === 1 ? '' : 's'} changed their pass rate in all (${regressed.length + improved.length} crossed from pass to fail or back; a question counts as passing when at least half of its answers do).`);
  return { ok: true, text: out.join('\n') };
}
