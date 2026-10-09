// The words on the capture screen (R-007). Pure: no page access, so every sentence can be tested exactly.
// `capture-page.js` only puts them on the page.

import { NOTE_MAX } from './notes-client.js';
import { formatDate } from './circles-view.js';

export const MODE_WORDS = Object.freeze({
  demo: 'Filed by the free demo model: nothing leaves this machine.',
  anthropic: "Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised.",
});
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
  if (op.op === 'link') return `Link item ${op.item} to category ${op.category}${typeof op.weight === 'number' ? ` (weight ${op.weight})` : ''}`;
  return `${op.partition === 'item' ? 'Add or update item' : 'Add or update category'} ${op.id}${titleOf(op.data)}`;
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
  return `Written: ${plural(outcome.applied, 'operation', 'operations')}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}.`;
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
