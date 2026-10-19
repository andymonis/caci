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

/**
 * Word beginnings that say a fact is being reported as past, replaced, corrected or cancelled ("moved from", "the original",
 * "replaces", "an earlier note", "corrected", "rescheduled"). Found in the real answers of the first run (2026-10-14), where
 * the models explained a change in many more ways than the phrases above.
 */
export const CUE_STEMS = Object.freeze(['replac', 'supersed', 'correct', 'earlier', 'older', 'previous', 'origin', 'cancel', 'reschedul', 'mov', 'updat', 'swapp', 'wrong', 'mistake', 'ignore', 'outdated', 'stopp', 'chang', 'former', 'obsolete']);

/** Phrases a headline uses to say nothing was found, so a question that expects nothing is answered even when `nothing` is false. */
export const NOT_FOUND_PHRASES = Object.freeze([
  'nothing', 'can t find', 'couldn t find', 'cannot find', 'could not find', 'do not contain', 'don t contain', 'doesn t contain', 'do not include', 'don t include',
  'doesn t include', 'not mentioned', 'isn t mentioned', 'no mention', 'no information', 'no record', 'not in your notes', 'don t have', 'do not have', 'no notes',
]);
const NOT_FOUND_TOKENS = Object.freeze(NOT_FOUND_PHRASES.map((p) => tokens(p)));

/** Bumped whenever the scoring rules change, so a saved result says which rules scored it. */
export const RULES_VERSION = 2;

const hasCue = (unitTokens) => CUE_TOKENS.some((cue) => containsPhrase(unitTokens, cue)) || unitTokens.some((t) => CUE_STEMS.some((stem) => t.startsWith(stem)));

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
    const headline = tokens(typeof answer.headline === 'string' ? answer.headline : '');
    const saidNothing = nothing ? !Array.isArray(answer.points) || answer.points.length === 0 : NOT_FOUND_TOKENS.some((p) => containsPhrase(headline, p));
    if (!saidNothing) reasons.push('the question has no answer in the notes, but the answer gave one instead of saying nothing is relevant');
    return { pass: saidNothing, groups: [], stale: [], nothing, reasons };
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
    const allCued = holding.every(hasCue);
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
