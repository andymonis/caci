// Scoring an answer by rules (R-013 D9). Pure and deterministic. An answer is `{ headline, points: [{ text }], nothing }`.
import { containsPhrase, tokens } from './text.mjs';

/**
 * Words that say a fact is being given as past or replaced. A stale phrase in the same headline or point as one of
 * these is a truthful mention of what changed, not the old fact given as current.
 */
export const CUES = Object.freeze([
  'no longer', 'previously', 'instead of', 'changed from', 'was changed', 'replaced', 'stopped', 'used to', 'cancelled', 'canceled',
  'formerly', 'anymore', 'any more', 'no more', 'switched from', 'rather than',
]);
const CUE_TOKENS = Object.freeze(CUES.map((cue) => tokens(cue)));

/** The headline and each point, as separate pieces of text. */
const unitsOf = (answer) => [answer.headline, ...(Array.isArray(answer.points) ? answer.points.map((p) => p?.text) : [])].filter((t) => typeof t === 'string' && t.trim() !== '');

/**
 * Scores one answer to one question.
 * @returns `{ pass, groups: [{ met, by }], stale: [{ phrase, status }], nothing, reasons }` where a stale phrase's
 *   status is `surfaced` (given as current), `superseded` (mentioned with a cue) or `absent`.
 */
export function scoreAnswer(question, answer) {
  const reasons = [];
  if (answer === null || answer === undefined || typeof answer !== 'object') {
    return { pass: false, groups: [], stale: [], nothing: false, reasons: ['there was no answer'] };
  }
  const nothing = answer.nothing === true;
  if (question.expectNothing === true) {
    const pass = nothing && (!Array.isArray(answer.points) || answer.points.length === 0);
    if (!pass) reasons.push('the question has no answer in the notes, but the answer gave one instead of saying nothing is relevant');
    return { pass, groups: [], stale: [], nothing, reasons };
  }
  const units = unitsOf(answer).map((text) => tokens(text));
  const groups = (question.must ?? []).map((group) => {
    const by = group.find((alt) => units.some((u) => containsPhrase(u, tokens(alt))));
    return { met: by !== undefined, by: by ?? null };
  });
  const stale = (question.stale ?? []).map((phrase) => {
    const t = tokens(phrase);
    const holding = units.filter((u) => containsPhrase(u, t));
    if (holding.length === 0) return { phrase, status: 'absent' };
    const allCued = holding.every((u) => CUE_TOKENS.some((cue) => containsPhrase(u, cue)));
    return { phrase, status: allCued ? 'superseded' : 'surfaced' };
  });
  if (nothing) reasons.push('the answer said nothing was relevant, but the notes hold the answer');
  groups.forEach((g, i) => {
    if (!g.met) reasons.push(`a required fact is missing (one of: ${(question.must[i] ?? []).map((a) => JSON.stringify(a)).join(', ')})`);
  });
  for (const s of stale) if (s.status === 'surfaced') reasons.push(`the old fact ${JSON.stringify(s.phrase)} was given as current`);
  const pass = !nothing && groups.every((g) => g.met) && stale.every((s) => s.status !== 'surfaced');
  return { pass, groups, stale, nothing, reasons };
}

/** Turns the scores of repeats into a pass rate and how often the old fact surfaced or was mentioned as superseded. */
export function aggregate(scores) {
  const n = scores.length;
  const count = (test) => scores.filter(test).length;
  const rate = (k) => (n === 0 ? 0 : k / n);
  const passes = count((s) => s.pass);
  const surfaced = count((s) => s.stale.some((x) => x.status === 'surfaced'));
  const superseded = count((s) => s.stale.some((x) => x.status === 'superseded'));
  return { n, passes, passRate: rate(passes), surfaced, staleSurfacedRate: rate(surfaced), superseded, supersededRate: rate(superseded) };
}
