// Scenario files (R-013 D7): plain JSON with dated notes and questions asked after a note. `validateScenario` lists every
// problem at once; `loadScenarios` reads a folder. A scenario that is unfair or unanswerable is refused before any model is paid for.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { containsPhrase, tokens } from './text.mjs';

export const KINDS = Object.freeze(['recall', 'override', 'retract', 'multi', 'distractor']);
export const MAX_NOTE_CHARS = 8000;
export const MAX_ASK_CHARS = 500;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?$/;
export const SCENARIO_FIELDS = ['id', 'title', 'description', 'notes', 'questions'];
export const NOTE_FIELDS = ['id', 'at', 'text'];
export const QUESTION_FIELDS = ['id', 'kind', 'after', 'ask', 'at', 'must', 'stale', 'expectNothing', 'why'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An ISO date or date-time (UTC) as milliseconds since 1970, or `undefined`. A date alone is 09:00 UTC. */
export function timeOf(at) {
  if (typeof at !== 'string' || !ISO.test(at)) return undefined;
  const text = at.length === 10 ? `${at}T09:00:00Z` : at.length === 16 ? `${at}:00Z` : at.endsWith('Z') ? at : `${at}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The time a question is asked: its own `at`, or one hour after the note it follows. */
export function askedAt(scenario, question) {
  if (question.at !== undefined) return timeOf(question.at);
  const note = scenario.notes.find((n) => n.id === question.after);
  return timeOf(note.at) + 3_600_000;
}

/** Every problem with a scenario, as a list of sentences that start with where it is. An empty list means it is sound. */
export function validateScenario(s) {
  const problems = [];
  const p = (where, message) => problems.push(`${where}: ${message}`);
  if (!isObject(s)) return ['scenario: must be an object'];
  const name = typeof s.id === 'string' ? `scenario "${s.id}"` : 'scenario';
  for (const key of Object.keys(s)) if (!SCENARIO_FIELDS.includes(key)) p(name, `unknown field "${key}"`);
  if (typeof s.id !== 'string' || !ID.test(s.id)) p(name, 'id must be lowercase letters, digits and hyphens');
  if (typeof s.title !== 'string' || s.title.trim() === '') p(name, 'title must be non-empty text');
  if (s.description !== undefined && typeof s.description !== 'string') p(name, 'description must be text');
  if (!Array.isArray(s.notes) || s.notes.length === 0) p(name, 'notes must be a non-empty list');
  if (!Array.isArray(s.questions) || s.questions.length === 0) p(name, 'questions must be a non-empty list');
  if (!Array.isArray(s.notes) || !Array.isArray(s.questions)) return problems;

  const noteIds = new Map();
  let last = -Infinity;
  s.notes.forEach((n, i) => {
    const where = `${name} note ${i + 1}${isObject(n) && typeof n.id === 'string' ? ` ("${n.id}")` : ''}`;
    if (!isObject(n)) return p(where, 'must be an object');
    for (const key of Object.keys(n)) if (!NOTE_FIELDS.includes(key)) p(where, `unknown field "${key}"`);
    if (typeof n.id !== 'string' || !ID.test(n.id)) p(where, 'id must be lowercase letters, digits and hyphens');
    else if (noteIds.has(n.id)) p(where, 'duplicate note id');
    else noteIds.set(n.id, i);
    const t = timeOf(n.at);
    if (t === undefined) p(where, 'at must be an ISO date like 2026-03-04 or 2026-03-04T10:30Z');
    else {
      if (t < last) p(where, 'is dated earlier than the note before it (notes must be in time order)');
      last = Math.max(last, t);
    }
    if (typeof n.text !== 'string' || n.text.trim() === '') p(where, 'text must be non-empty text');
    else if ([...n.text].length > MAX_NOTE_CHARS) p(where, `text is over ${MAX_NOTE_CHARS} characters`);
  });

  const questionIds = new Set();
  s.questions.forEach((q, i) => {
    const where = `${name} question ${i + 1}${isObject(q) && typeof q.id === 'string' ? ` ("${q.id}")` : ''}`;
    if (!isObject(q)) return p(where, 'must be an object');
    for (const key of Object.keys(q)) if (!QUESTION_FIELDS.includes(key)) p(where, `unknown field "${key}"`);
    if (typeof q.id !== 'string' || !ID.test(q.id)) p(where, 'id must be lowercase letters, digits and hyphens');
    else if (questionIds.has(q.id)) p(where, 'duplicate question id');
    else questionIds.add(q.id);
    if (!KINDS.includes(q.kind)) p(where, `kind must be one of ${KINDS.join(', ')}`);
    if (typeof q.ask !== 'string' || q.ask.trim() === '') p(where, 'ask must be non-empty text');
    else if ([...q.ask].length > MAX_ASK_CHARS) p(where, `ask is over ${MAX_ASK_CHARS} characters`);
    if (q.why !== undefined && typeof q.why !== 'string') p(where, 'why must be text');
    if (q.expectNothing !== undefined && typeof q.expectNothing !== 'boolean') p(where, 'expectNothing must be true or false');
    const checkpoint = typeof q.after === 'string' ? noteIds.get(q.after) : undefined;
    if (checkpoint === undefined) p(where, 'after must be the id of a note');
    if (q.at !== undefined) {
      const t = timeOf(q.at);
      if (t === undefined) p(where, 'at must be an ISO date like 2026-03-04 or 2026-03-04T10:30Z');
      else if (checkpoint !== undefined && t < (timeOf(s.notes[checkpoint]?.at) ?? 0)) p(where, 'at is earlier than the note it follows');
    }

    // must and stale
    const stale = q.stale;
    const must = q.must;
    const groups = [];
    if (must !== undefined) {
      if (!Array.isArray(must) || must.length === 0) p(where, 'must must be a non-empty list of groups');
      else
        must.forEach((g, gi) => {
          if (!Array.isArray(g) || g.length === 0 || g.some((a) => typeof a !== 'string' || tokens(a).length === 0)) p(where, `must group ${gi + 1} must be a non-empty list of non-empty phrases`);
          else groups.push(g);
        });
    }
    if (stale !== undefined) {
      if (!Array.isArray(stale) || stale.length === 0 || stale.some((a) => typeof a !== 'string' || tokens(a).length === 0)) p(where, 'stale must be a non-empty list of non-empty phrases');
    }
    if (q.kind === 'distractor') {
      if (q.expectNothing !== true) p(where, 'a distractor must set expectNothing to true');
      if (must !== undefined || stale !== undefined) p(where, 'a distractor has no must or stale phrases (the right answer is nothing relevant)');
    } else {
      if (q.expectNothing !== undefined) p(where, 'expectNothing is for distractor questions only');
      if (must === undefined) p(where, 'must is required (at least one group of alternative phrases)');
      if (stale !== undefined && q.kind !== 'override' && q.kind !== 'retract') p(where, 'stale phrases are for override and retract questions only');
      if (q.kind === 'override' && (!Array.isArray(stale) || stale.length === 0)) p(where, 'an override question needs a stale phrase');
      if (q.kind === 'multi' && groups.length < 2) p(where, 'a multi question needs at least two must groups');
    }

    // answerable, and the override is real
    if (checkpoint !== undefined && groups.length > 0) {
      const noteTokens = s.notes.slice(0, checkpoint + 1).map((n) => (typeof n?.text === 'string' ? tokens(n.text) : []));
      const firstHolding = (phrase) => noteTokens.findIndex((t) => containsPhrase(t, tokens(phrase)));
      const firsts = [];
      groups.forEach((g, gi) => {
        const holders = g.map(firstHolding).filter((x) => x >= 0);
        if (holders.length === 0) p(where, `must group ${gi + 1} (${JSON.stringify(g[0])}...) is in no note at or before the checkpoint, so the question cannot be answered`);
        else firsts.push(Math.min(...holders));
      });
      if (q.kind === 'override' && Array.isArray(stale) && firsts.length === groups.length) {
        const newest = Math.max(...firsts);
        for (const phrase of stale) {
          if (typeof phrase !== 'string' || tokens(phrase).length === 0) continue;
          const at = firstHolding(phrase);
          if (at < 0) p(where, `the stale phrase ${JSON.stringify(phrase)} is in no note at or before the checkpoint, so nothing is being overridden`);
          else if (at >= newest) p(where, `the stale phrase ${JSON.stringify(phrase)} first appears in note ${at + 1}, not earlier than the note that holds the new fact (note ${newest + 1}), so the override is not real`);
        }
      }
    }
  });
  return problems;
}

/** Reads every `.json` file in a folder as a scenario. Returns `{ ok: true, scenarios }` or `{ ok: false, problems }`. */
export function loadScenarios(dir) {
  const problems = [];
  const scenarios = [];
  let names;
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, problems: [`${dir} is not a folder`] };
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { ok: false, problems: [`the scenarios folder ${dir} does not exist`] };
  }
  if (names.length === 0) return { ok: false, problems: [`no .json scenario files in ${dir}`] };
  const seen = new Map();
  for (const name of names) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      problems.push(`${name}: is not valid JSON`);
      continue;
    }
    const found = validateScenario(data);
    if (found.length > 0) {
      problems.push(...found.map((f) => `${name}: ${f}`));
      continue;
    }
    if (seen.has(data.id)) {
      problems.push(`${name}: the scenario id "${data.id}" is already used by ${seen.get(data.id)}`);
      continue;
    }
    seen.set(data.id, name);
    scenarios.push(data);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, scenarios };
}
