// Re-scoring a saved result with the current rules, offline: no model, no key. The answers are in the file; only the
// judgement changes. Used when the scoring rules are corrected, so earlier runs can be read fairly.
import { scenarioDifferences } from './compare.mjs';
import { lostAt } from './brain-arm.mjs';
import { summarise } from './report.mjs';
import { RULES_VERSION, scoreAnswer } from './score.mjs';

/**
 * @param saved a saved brain-eval result
 * @param scenarios the current scenarios (validated)
 * @param describe `(scenario) => { id, hash, notes, questions }`, the same description a run saves
 * @returns `{ ok: true, value }` or `{ ok: false, message }`
 */
export function rescoreRun(saved, scenarios, describe, { force = false } = {}) {
  if (saved === null || typeof saved !== 'object' || saved.kind !== 'brain-eval' || !Array.isArray(saved.results)) return { ok: false, message: 'that file is not a saved brain-eval result' };
  const current = { scenarios: scenarios.map(describe) };
  const differences = scenarioDifferences(saved, current);
  if (differences.length > 0 && !force) {
    return { ok: false, message: `The scenarios have changed since that run, so its answers cannot be re-scored fairly:\n${differences.map((d) => `  - ${d}`).join('\n')}\nUse --force to re-score the questions that still exist.` };
  }
  const questions = new Map(scenarios.flatMap((s) => s.questions.map((q) => [`${s.id}/${q.id}`, q])));
  let changed = 0;
  let skipped = 0;
  const results = [];
  for (const r of saved.results) {
    const q = questions.get(`${r.scenario}/${r.question}`);
    if (q === undefined) {
      skipped++;
      continue;
    }
    const answer = r.answer === null ? null : { headline: r.answer.headline, points: r.answer.points.map((text) => ({ text })), nothing: r.answer.nothing };
    const score = scoreAnswer(q, answer);
    const out = { ...r, pass: score.pass, score };
    if (r.diagnostic !== null && r.diagnostic !== undefined) {
      const inAnswer = score.groups.map((g) => g.met);
      out.diagnostic = { ...r.diagnostic, inAnswer, lostAt: lostAt(r.diagnostic.inBrain, r.diagnostic.inContext, inAnswer) };
    }
    if (out.pass !== r.pass) changed++;
    results.push(out);
  }
  const value = {
    ...saved,
    rescored: { rulesVersion: RULES_VERSION, previousRulesVersion: saved.rescored?.rulesVersion ?? saved.rulesVersion ?? 1, changedVerdicts: changed, skippedQuestions: skipped, forced: force && differences.length > 0 },
    rulesVersion: RULES_VERSION,
    summary: summarise(results),
    results,
  };
  return { ok: true, value };
}
