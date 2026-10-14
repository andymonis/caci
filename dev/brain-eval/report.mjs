// The report: pure, from the records of a run. Numbers are plain counts and rates, no prices.
import { aggregate } from './score.mjs';

const pct = (x) => `${Math.round(x * 100)}%`;
const pp = (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)} pp`;
const pad = (text, n) => String(text).padEnd(n);
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => `  ${r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd()}`).join('\n');
};
const unique = (list) => [...new Set(list)];

const stats = (records) => {
  const a = aggregate(records.map((r) => r.score));
  const tokens = records.reduce((t, r) => ({ inputTokens: t.inputTokens + r.tokens.inputTokens, outputTokens: t.outputTokens + r.tokens.outputTokens }), { inputTokens: 0, outputTokens: 0 });
  return { ...a, tokens, errors: records.filter((r) => r.error !== null).length, overWindow: records.filter((r) => r.overWindow === true).length };
};

/** Structured numbers behind the report, kept in the saved file and used to compare two runs. */
export function summarise(results) {
  const arms = unique(results.map((r) => r.arm));
  const models = unique(results.map((r) => r.model));
  const kinds = unique(results.map((r) => r.kind));
  const cells = {};
  for (const arm of arms) {
    for (const model of models) {
      const mine = results.filter((r) => r.arm === arm && r.model === model);
      if (mine.length === 0) continue;
      cells[`${arm}|${model}`] = { ...stats(mine), byKind: Object.fromEntries(kinds.filter((k) => mine.some((r) => r.kind === k)).map((k) => [k, stats(mine.filter((r) => r.kind === k))])) };
    }
  }
  return { arms, models, kinds, cells };
}

const lostCounts = (records) => {
  const c = { filing: 0, context: 0, answer: 0, stale: 0, other: 0 };
  for (const r of records) {
    if (r.pass) continue;
    const lost = r.diagnostic?.lostAt ?? null;
    if (lost !== null) c[lost]++;
    else if (r.score.stale.some((s) => s.status === 'surfaced')) c.stale++;
    else c.other++;
  }
  return c;
};

export function formatReport({ results, filing = [], meta }) {
  const out = [];
  const s = summarise(results);
  out.push('Brain against replay');
  out.push(`  mode ${meta.mode} · arms ${s.arms.join(', ')} · filed with ${meta.fileWith ?? 'n/a'} · repeats ${meta.repeat} · controls ${meta.controls}${meta.aborted ? ' · STOPPED EARLY' : ''}`);
  if (meta.pad !== undefined && meta.pad > 0) out.push(`  padded with ${meta.pad} filler notes (seed ${meta.seed})`);
  out.push(`  ${results.length} answers over ${unique(results.map((r) => r.scenario)).length} scenarios`);
  if (results.length === 0) return out.join('\n');

  out.push('', 'Pass rate and stale facts, by arm and answering model');
  out.push(table([['arm', 'model', 'answers', 'pass', 'old fact as current', 'old fact mentioned as old', 'errors', 'tokens in/out'], ...Object.entries(s.cells).map(([key, c]) => {
    const [arm, model] = key.split('|');
    return [arm, model, c.n, pct(c.passRate), pct(c.staleSurfacedRate), pct(c.supersededRate), c.errors + (c.overWindow ? ` (${c.overWindow} over window)` : ''), `${c.tokens.inputTokens}/${c.tokens.outputTokens}`];
  })]));

  out.push('', 'By kind of question (pass rate)');
  out.push(table([['arm', 'model', ...s.kinds], ...Object.entries(s.cells).map(([key, c]) => {
    const [arm, model] = key.split('|');
    return [arm, model, ...s.kinds.map((k) => (c.byKind[k] === undefined ? '-' : `${pct(c.byKind[k].passRate)} (${c.byKind[k].n})`))];
  })]));

  if (s.arms.includes('brain') && s.arms.includes('replay')) {
    out.push('', 'Brain minus replay (positive means the brain did better)');
    out.push(table([['model', 'pass', 'old fact as current', ...s.kinds], ...s.models.filter((m) => s.cells[`brain|${m}`] && s.cells[`replay|${m}`]).map((m) => {
      const b = s.cells[`brain|${m}`];
      const r = s.cells[`replay|${m}`];
      return [m, pp(b.passRate - r.passRate), pp(b.staleSurfacedRate - r.staleSurfacedRate), ...s.kinds.map((k) => (b.byKind[k] && r.byKind[k] ? pp(b.byKind[k].passRate - r.byKind[k].passRate) : '-'))];
    })]));
  }

  out.push('', 'Where failed answers lost the fact (a fact lost at filing never reached the brain; at context, never reached the model; at answer, the model had it and did not say it; stale, the old fact was given as current)');
  out.push(table([['arm', 'model', 'filing', 'context', 'answer', 'stale', 'other'], ...Object.keys(s.cells).map((key) => {
    const [arm, model] = key.split('|');
    const c = lostCounts(results.filter((r) => r.arm === arm && r.model === model));
    return [arm, model, c.filing, c.context, c.answer, c.stale, c.other];
  })]));

  const brain = results.filter((r) => r.arm === 'brain');
  const leftOut = brain.filter((r) => (r.entriesLeftOut ?? 0) > 0);
  if (leftOut.length > 0) out.push('', `The brain left notes out of the context in ${leftOut.length} of ${brain.length} answers (most in one: ${Math.max(...leftOut.map((r) => r.entriesLeftOut))}).`);

  if (filing.length > 0) {
    const failed = filing.filter((f) => !f.ok);
    out.push('', `Filing: ${filing.length - failed.length} of ${filing.length} notes filed${failed.length ? `; ${failed.length} not (${unique(failed.map((f) => f.error.code ?? f.error.message ?? 'error')).join(', ')})` : ''}.`);
  }

  out.push('', 'By question (passes of answers)');
  const labels = Object.keys(s.cells);
  const qkeys = unique(results.map((r) => `${r.scenario}/${r.question}`));
  out.push(table([['question', 'kind', ...labels.map((l) => l.replace('|', ' '))], ...qkeys.map((qk) => {
    const mine = results.filter((r) => `${r.scenario}/${r.question}` === qk);
    return [qk, mine[0].kind, ...labels.map((l) => {
      const [arm, model] = l.split('|');
      const cell = mine.filter((r) => r.arm === arm && r.model === model);
      return cell.length === 0 ? '-' : `${cell.filter((r) => r.pass).length}/${cell.length}`;
    })];
  })]));

  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    out.push('', `Failures (${failures.length}${failures.length > 20 ? ', first 20' : ''})`);
    for (const f of failures.slice(0, 20)) {
      const said = f.error !== null ? `error ${f.error.code ?? f.error.source}` : f.overWindow ? 'not sent: over the window' : f.answer === null ? 'no answer' : JSON.stringify([f.answer.headline, ...f.answer.points]).slice(0, 300);
      out.push(`  ${f.arm} ${f.model} ${f.scenario}/${f.question}${f.run > 1 ? ` #${f.run}` : ''}: ${f.score.reasons.join('; ') || 'failed'}`, `      ${said}`);
    }
  }
  return out.join('\n');
}
