import { LEDGER_ACTIONS, LEDGER_KINDS, SUBJECT_MAX, SUMMARY_MAX, TEXT_MAX, TITLE_MAX, type LedgerEntry, type LedgerScope } from './types.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = ['id', 'at', 'scope', 'actor', 'action', 'kind', 'subject', 'title', 'summary', 'text', 'proposalId'] as const;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const length = (text: string): number => [...text].length;

/** The text cut to at most `max` characters (by character, never half an emoji). */
export function capText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** `personal:<user id>` or `circle:<circle id>`: one key per scope. */
export const scopeKey = (scope: LedgerScope): string => (scope.kind === 'personal' ? `personal:${scope.userId}` : `circle:${scope.circleId}`);

/** What is wrong with a scope, or `undefined`. */
export function scopeProblem(scope: unknown): string | undefined {
  if (!isObject(scope)) return 'scope must be an object';
  const keys = Object.keys(scope);
  if (scope.kind === 'personal') return keys.length === 2 && typeof scope.userId === 'string' && ID.test(scope.userId) ? undefined : 'a personal scope is { kind, userId } with an id';
  if (scope.kind === 'circle') return keys.length === 2 && typeof scope.circleId === 'string' && ID.test(scope.circleId) ? undefined : 'a circle scope is { kind, circleId } with an id';
  return 'scope.kind must be personal or circle';
}

/** What is wrong with an entry, as one sentence, or `undefined` when it is sound. Every store uses this one check. */
export function entryProblem(entry: unknown): string | undefined {
  if (!isObject(entry)) return 'an entry must be an object';
  for (const key of Object.keys(entry)) if (!(FIELDS as readonly string[]).includes(key)) return `unknown field "${key.slice(0, 20)}"`;
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) return 'id must be 1 to 128 letters, digits, - or _';
  if (typeof entry.at !== 'number' || !Number.isSafeInteger(entry.at) || entry.at < 0) return 'at must be a whole number of milliseconds, 0 or more';
  const scope = scopeProblem(entry.scope);
  if (scope !== undefined) return scope;
  if (typeof entry.actor !== 'string' || !ID.test(entry.actor)) return 'actor must be 1 to 128 letters, digits, - or _';
  if (!(LEDGER_ACTIONS as readonly unknown[]).includes(entry.action)) return `action must be one of ${LEDGER_ACTIONS.join(', ')}`;
  if (!(LEDGER_KINDS as readonly unknown[]).includes(entry.kind)) return `kind must be one of ${LEDGER_KINDS.join(', ')}`;
  if (typeof entry.subject !== 'string' || entry.subject === '' || length(entry.subject) > SUBJECT_MAX) return `subject must be 1 to ${SUBJECT_MAX} characters`;
  if (entry.title !== undefined && (typeof entry.title !== 'string' || length(entry.title) > TITLE_MAX)) return `title must be text of at most ${TITLE_MAX} characters`;
  if (entry.summary !== undefined && (typeof entry.summary !== 'string' || length(entry.summary) > SUMMARY_MAX)) return `summary must be text of at most ${SUMMARY_MAX} characters`;
  if (entry.kind === 'input') {
    // R-017 D5: one entry holds the words of an update, as an addition, and nothing else about a fact
    if (entry.action !== 'added') return 'an input is always added';
    if (entry.title !== undefined || entry.summary !== undefined) return 'an input has text, not a title or summary';
    if (typeof entry.text !== 'string' || entry.text === '' || length(entry.text) > TEXT_MAX) return `an input needs text of 1 to ${TEXT_MAX} characters`;
  } else if (entry.text !== undefined) return 'only an input has text';
  if (typeof entry.proposalId !== 'string' || !ID.test(entry.proposalId)) return 'proposalId must be 1 to 128 letters, digits, - or _';
  return undefined;
}

/** A copy of an entry that shares nothing with the original (the scope too), leaving out optional fields that are not there. */
export function copyEntry(entry: LedgerEntry): LedgerEntry {
  return {
    id: entry.id,
    at: entry.at,
    scope: entry.scope.kind === 'personal' ? { kind: 'personal', userId: entry.scope.userId } : { kind: 'circle', circleId: entry.scope.circleId },
    actor: entry.actor,
    action: entry.action,
    kind: entry.kind,
    subject: entry.subject,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    ...(entry.text === undefined ? {} : { text: entry.text }),
    proposalId: entry.proposalId,
  };
}
