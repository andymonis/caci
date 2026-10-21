// The words on the change-log screen (R-014). Pure: no page access, so every sentence can be tested exactly.
// `ledger-page.js` only puts them on the page. Everything shown is text, including what the notes said.

import { formatTime } from './capture-view.js';

export const LEDGER_NOTICE = 'This is a review log of recent changes to the notes: what was added, updated or removed, when, and by whom. It is not a full record of every version of your notes. It is kept for a limited time (90 days unless the operator chose otherwise), and older entries are forgotten. The words typed for each update are kept with the change, for as long as the change log is kept, and everyone who can read this log can read them.';
export const LEDGER_EMPTY = 'Nothing has changed here yet, or the older changes have been forgotten.';
export const LEDGER_LOADING = 'Loading…';
export const NO_ONE = 'someone who has since left';
export const LEDGER_MORE_ERROR = 'Could not load older entries.';

const KIND_WORDS = Object.freeze({ item: 'note', category: 'category' });

const text = (v) => (typeof v === 'string' ? v : '');

/** What was changed, as the person would say it: the title, then what it said when that is known. */
function whatText(entry) {
  const title = text(entry.title);
  const summary = text(entry.summary);
  return `"${title === '' ? text(entry.subject) : title}"${summary === '' ? '' : ` — ${summary}`}`;
}

/** The most characters of an update's words shown on the line (the answer holds them all). */
export const INPUT_SHOWN = 600;

/** One entry on one line: `2026-10-14 09:30 UTC · Ann A · removed note · "Tablet A" — 2 x daily`. */
export function entryText(entry) {
  const when = formatTime(entry.at);
  const who = entry.by !== undefined && text(entry.by.displayName) !== '' ? entry.by.displayName : NO_ONE;
  if (entry.kind === 'input') {
    const chars = [...text(entry.text)];
    return `${when === '' ? 'Unknown time' : when} · Entered by ${who}: "${chars.length > INPUT_SHOWN ? `${chars.slice(0, INPUT_SHOWN).join('')}…` : chars.join('')}"`;
  }
  const kind = Object.hasOwn(KIND_WORDS, entry.kind) ? KIND_WORDS[entry.kind] : 'item';
  return `${when === '' ? 'Unknown time' : when} · ${who} · ${text(entry.action)} ${kind} · ${whatText(entry)}`;
}

/** A line under the scope choice saying whose log this is. */
export function ledgerScopeHint(browseKey, scopes) {
  const chosen = scopes.find((s) => s.key === browseKey);
  if (chosen && chosen.scope.kind === 'circle') return `Showing the changes to the circle "${chosen.label}", made by its members.`;
  return 'Showing the changes to your own notes.';
}
