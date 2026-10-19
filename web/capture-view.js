// The words on the capture screen (R-007). Pure: no page access, so every sentence can be tested exactly.
// `capture-page.js` only puts them on the page.

import { NOTE_MAX } from './notes-client.js';
import { formatDate } from './circles-view.js';

export const MODE_WORDS = Object.freeze({
  demo: 'Filed by the free demo model: nothing leaves this machine.',
  anthropic: "Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised.",
});
/**
 * What a person is told before and while a note goes into a circle's brain (R-009): who will see it, that it cannot be
 * taken back, and, when a real model files it, where the note goes. `name` is the circle's name as the service gave it.
 */
export function circleNotice(name, mode) {
  const circle = typeof name === 'string' && name !== '' ? `"${name}"` : 'this circle';
  const seen = `This note will be added to the circle ${circle}. Everyone in the circle can read it, and it cannot be taken back once approved.`;
  return mode === 'anthropic' ? `${seen} The note and the names of the circle's categories are sent to Anthropic and are not anonymised.` : seen;
}
/** Where a proposal will be written, in words (the preview and the outcome). */
export const scopeLine = (scope) => (scope && scope.kind === 'circle' ? `Goes to the circle "${typeof scope.circleName === 'string' && scope.circleName !== '' ? scope.circleName : 'this circle'}".` : 'Goes to your own notes.');
/** The notice that belongs to a scope: a circle's (who can read, cannot be taken back) or the personal one. */
export const scopeNotice = (scope, mode) => (scope && scope.kind === 'circle' ? circleNotice(scope.circleName, mode) : PERSONAL_NOTICE);
/** The circles the person can read but may not add notes to, in one sentence (nothing when there are none). */
export function readOnlyLine(scopes) {
  const names = scopes.filter((s) => s.scope.kind === 'circle' && s.canCapture === false).map((s) => `"${s.label}"`);
  return names.length === 0 ? '' : `You can read, but not add notes to: ${names.join(', ')}.`;
}
export const PERSONAL_NOTICE = 'This note will be added to your own notes. Only you can read it.';
export const MODE_UNKNOWN = 'Could not tell which model files your notes.';
export const MODE_LOADING = 'Checking which model files your notes…';
export const REJECTED_WORDS = 'Rejected. Nothing was written.';

/** The notice about which model files the note, from the mode state of the capture session. */
export function modeNotice(mode) {
  if (mode && mode.status === 'known' && Object.hasOwn(MODE_WORDS, mode.value)) return MODE_WORDS[mode.value];
  if (mode && mode.status === 'loading') return MODE_LOADING;
  return MODE_UNKNOWN;
}

/** The notice on a preview: the mode the proposal itself carries. */
export const previewNotice = (proposal) => (proposal && Object.hasOwn(MODE_WORDS, proposal.mode) ? MODE_WORDS[proposal.mode] : MODE_UNKNOWN);

/** "12 / 8,000". */
export const countText = (length) => `${Math.max(0, Number.isSafeInteger(length) ? length : 0).toLocaleString('en-GB')} / ${NOTE_MAX.toLocaleString('en-GB')}`;

/** A time as `YYYY-MM-DD HH:MM UTC`, or nothing for a value that is not a time. */
export function formatTime(ms) {
  const day = formatDate(ms);
  if (day === '') return '';
  return `${day} ${new Date(ms).toISOString().slice(11, 16)} UTC`;
}
export const expiresText = (ms) => {
  const when = formatTime(ms);
  return when === '' ? '' : `Expires ${when}. After that it is forgotten and nothing is written.`;
};

const titleOf = (data) => {
  if (!data || typeof data !== 'object') return '';
  const t = typeof data.title === 'string' && data.title !== '' ? data.title : typeof data.name === 'string' ? data.name : '';
  return t === '' ? '' : ` "${t}"`;
};

/** One operation in words, as the person would be approving it. */
export function opText(op) {
  if (op.op === 'deleteNode') return `Remove ${op.partition === 'item' ? 'note' : 'category'} ${op.id}`;
  if (op.op === 'link') return `Link item ${op.item} to category ${op.category}${typeof op.weight === 'number' ? ` (weight ${op.weight})` : ''}`;
  return `${op.partition === 'item' ? 'Add or update item' : 'Add or update category'} ${op.id}${titleOf(op.data)}`;
}

/** The notes a proposal would remove, one line each, in the person's words (R-014). Empty when it replaces nothing. */
export function replaceLines(summary) {
  const removed = Array.isArray(summary.removed) ? summary.removed : [];
  return removed.map((r) => {
    const name = r.title !== '' ? r.title : r.id;
    return `This note replaces: ${name}${r.summary === '' ? '' : ` (${r.summary})`}. The old note will be removed when you approve.`;
  });
}

/** The lines under "Be careful": problems first (approving may be refused), then notes. */
export const problemLines = (summary) => summary.problems.map((p) => `Problem: ${p}`);
export const noteLines = (summary) => summary.notes.map((n) => `Note: ${n}`);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What was written, in one sentence. */
export function writtenText(outcome) {
  const s = outcome.summary;
  const parts = [];
  if (s.newItems.length > 0) parts.push(plural(s.newItems.length, 'new item', 'new items'));
  if (s.updatedItems.length > 0) parts.push(plural(s.updatedItems.length, 'updated item', 'updated items'));
  if (s.newCategories.length > 0) parts.push(plural(s.newCategories.length, 'new category', 'new categories'));
  if (s.updatedCategories.length > 0) parts.push(plural(s.updatedCategories.length, 'updated category', 'updated categories'));
  if (s.reusedCategories.length > 0) parts.push(plural(s.reusedCategories.length, 'category reused', 'categories reused'));
  if (s.newLinks.length > 0) parts.push(plural(s.newLinks.length, 'link', 'links'));
  const gone = Array.isArray(s.removed) ? s.removed.length : 0;
  const tidied = Array.isArray(outcome.tidied) ? outcome.tidied.length : 0;
  if (gone > 0 || tidied > 0) {
    const bits = [];
    if (gone > 0) bits.push(plural(gone, 'old note', 'old notes'));
    if (tidied > 0) bits.push(plural(tidied, 'empty category', 'empty categories'));
    parts.push(`removed ${bits.join(' and ')}`);
  }
  const where = outcome.scope && outcome.scope.kind === 'circle' ? ` Added to the circle "${typeof outcome.scope.circleName === 'string' && outcome.scope.circleName !== '' ? outcome.scope.circleName : 'this circle'}".` : '';
  return `Written: ${plural(outcome.applied, 'operation', 'operations')}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}.${where}`;
}

/** The sentence for the outcome of a proposal. */
export function outcomeText(outcome) {
  if (outcome.kind === 'written') return writtenText(outcome);
  if (outcome.kind === 'rejected') return REJECTED_WORDS;
  return typeof outcome.message === 'string' && outcome.message !== '' ? outcome.message : 'That proposal is gone or has expired. Make it again.';
}

/** A refusal in words, with the wait when the service gave one. */
export function withWait(message, seconds) {
  return Number.isSafeInteger(seconds) && seconds > 0 ? `${message} Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.` : message;
}
