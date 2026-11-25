import { err, ok, type Result } from '../graph_store/index.js';

// The verb vocabulary (R-025 D9): what a person can say about a fact they have dealt with. The operator's file
// `controls/verbs.json` is read at start-up; this module checks its text and is pure. A verb names an effect;
// it never calls anything outside CaCi (D4). Every problem is returned at once, each naming the file.

/** What a verb does to the fact (R-025 D10): `clear` hides it for the person (or deletes it in their own brain); `remove` deletes it, owner only. */
export type VerbEffect = 'clear' | 'remove';

export interface Verb {
  readonly name: string;
  readonly effect: VerbEffect;
  /** One line, used in the thread when the verb is applied and as a button's label. */
  readonly help: string;
}

/** The checked vocabulary. */
export interface Verbs {
  readonly list: readonly Verb[];
  /** The verb of a name, or undefined. */
  get(name: string): Verb | undefined;
}

export const VERBS_FILE = 'verbs.json';
export const MAX_VERBS = 20;
export const MAX_VERB_HELP_CHARS = 80;
const NAME = /^[a-z0-9-]{1,20}$/;
const EFFECTS = ['clear', 'remove'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Makes a vocabulary from already-checked verbs. */
function make(list: readonly Verb[]): Verbs {
  const frozen = Object.freeze(list.map((v) => Object.freeze({ ...v })));
  const byName = new Map(frozen.map((v) => [v.name, v]));
  return Object.freeze({ list: frozen, get: (name: string) => byName.get(name) });
}

/** Checks the text of `verbs.json`. Never throws; every problem names the file. */
export function parseVerbs(text: string): Result<Verbs, readonly string[]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return err([`${VERBS_FILE}: is not valid JSON`]);
  }
  if (!isRecord(data)) return err([`${VERBS_FILE}: must be an object with a "verbs" list`]);
  const problems: string[] = [];
  for (const key of Object.keys(data)) if (key !== 'verbs') problems.push(`${VERBS_FILE}: unknown field "${key}"`);
  const raw = data.verbs;
  if (!Array.isArray(raw)) return err([...problems, `${VERBS_FILE}: "verbs" must be a list`]);
  if (raw.length === 0) problems.push(`${VERBS_FILE}: "verbs" must not be empty`);
  if (raw.length > MAX_VERBS) problems.push(`${VERBS_FILE}: ${raw.length} verbs, over the limit of ${MAX_VERBS}`);
  const seen = new Set<string>();
  const list: Verb[] = [];
  raw.slice(0, MAX_VERBS).forEach((entry, i) => {
    const at = `${VERBS_FILE}: verb ${i + 1}`;
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) if (!['name', 'effect', 'help'].includes(key)) problems.push(`${at}: unknown field "${key}"`);
    const { name, effect, help } = entry;
    let good = true;
    if (typeof name !== 'string' || !NAME.test(name)) {
      problems.push(`${at}: "name" must be 1 to 20 characters of a-z, 0-9 and -`);
      good = false;
    } else if (seen.has(name)) {
      problems.push(`${at}: the name "${name}" is used twice`);
      good = false;
    } else seen.add(name);
    if (typeof effect !== 'string' || !(EFFECTS as readonly string[]).includes(effect)) {
      problems.push(`${at}: "effect" must be "clear" or "remove"`);
      good = false;
    }
    if (typeof help !== 'string' || help.trim() === '' || [...help].length > MAX_VERB_HELP_CHARS || CONTROL.test(help)) {
      problems.push(`${at}: "help" must be one line of 1 to ${MAX_VERB_HELP_CHARS} characters`);
      good = false;
    }
    if (good) list.push({ name: name as string, effect: effect as VerbEffect, help: (help as string).trim() });
  });
  return problems.length > 0 ? err(problems) : ok(make(list));
}

/** A vocabulary for tests and tools: the shipped three. */
export function defaultVerbs(): Verbs {
  return make([
    { name: 'clear', effect: 'clear', help: 'Clear this for me.' },
    { name: 'pay', effect: 'clear', help: 'Mark this as paid.' },
    { name: 'remove', effect: 'remove', help: 'Remove this fact for everyone.' },
  ]);
}
