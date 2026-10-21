// The web app's way of reading the change log of a brain (R-014). Plain browser JavaScript.
//
// - Read-only: one route, `GET /api/ledger`. The scope is the person's own notes or a circle they can read; the page
//   never names a graph or a person.
// - Same rules as the other clients: same address by path only, the cookie left to the browser, never throws:
//   `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - Every answer is cut down to the fields the page uses; one that is not shaped right is a server problem.
//   Text in an entry (a title, a summary, a name) is only ever shown as text.
// - It is a review log, not a history: the service keeps it for a limited time.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';
import { NO_CIRCLE, provenanceOf, query, scopeText } from './notes-client.js';

const SIGNED_OUT = 'Your session has ended. Sign in again.';
const ACTIONS = Object.freeze(['added', 'updated', 'removed']);
const KINDS = Object.freeze(['item', 'category', 'input']);
const TEXT_MAX = 8000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v) => Number.isSafeInteger(v) && v >= 0;
const optionalText = (v) => v === undefined || typeof v === 'string';

function entryOf(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || !whole(raw.at) || !ACTIONS.includes(raw.action) || !KINDS.includes(raw.kind)) return undefined;
  if (!optionalText(raw.title) || !optionalText(raw.summary)) return undefined;
  const input = raw.kind === 'input';
  // an input (R-017) holds the words as sent and no subject; every other entry names the note or category it is about
  if (input ? raw.action !== 'added' || typeof raw.text !== 'string' || raw.text === '' || [...raw.text].length > TEXT_MAX : typeof raw.subject !== 'string' || raw.text !== undefined) return undefined;
  let by;
  if (raw.by !== undefined) {
    if (!isObject(raw.by) || typeof raw.by.username !== 'string' || typeof raw.by.displayName !== 'string') return undefined;
    by = Object.freeze({ username: raw.by.username, displayName: raw.by.displayName });
  }
  return Object.freeze({
    id: raw.id,
    at: raw.at,
    action: raw.action,
    kind: raw.kind,
    ...(input ? { text: raw.text } : { subject: raw.subject }),
    ...(typeof raw.title === 'string' && raw.title !== '' ? { title: raw.title } : {}),
    ...(typeof raw.summary === 'string' && raw.summary !== '' ? { summary: raw.summary } : {}),
    ...(by === undefined ? {} : { by }),
  });
}

function ledgerOf(json) {
  if (!isObject(json) || !Array.isArray(json.items) || !(json.nextCursor === null || typeof json.nextCursor === 'string')) return undefined;
  const items = [];
  for (const raw of json.items) {
    const entry = entryOf(raw);
    if (entry === undefined) return undefined;
    items.push(entry);
  }
  const scope = json.scope === undefined ? undefined : provenanceOf(json.scope);
  if (json.scope !== undefined && scope === undefined) return undefined;
  return Object.freeze({ items: Object.freeze(items), nextCursor: json.nextCursor, ...(scope === undefined ? {} : { scope }) });
}

function errorFor(status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  const seconds = parseRetryAfter(retryAfter);
  if (status === 401) return { kind: 'signed-out', message: SIGNED_OUT };
  if (status === 404) return { kind: 'not-found', what: 'circle', message: NO_CIRCLE };
  if (status === 422) {
    const field = ['scope', 'limit', 'cursor'].find((f) => f === error.field || (typeof error.field === 'string' && error.field.startsWith(`${f}.`)));
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you asked for.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) return { kind: 'limit', message: cleanMessage(error.message, 'A limit has been reached. Try again later.'), ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  return { kind: 'server', message: SERVER };
}

export function createLedgerClient({ fetchFn }) {
  const send = createRequester(fetchFn);
  return Object.freeze({
    /** One page of the change log, newest first. `scope` is undefined (own notes), `{ kind: 'personal' }` or `{ kind: 'circle', circleId }`. */
    list(scope, page) {
      const text = scopeText(scope);
      if (text === undefined) return Promise.resolve(fail({ kind: 'invalid', field: 'scope', message: 'Choose your own notes or one of your circles.' }));
      const q = query(page, [`scope=${text}`]);
      if (q.problem) return Promise.resolve(fail(q.problem));
      return send('GET', `/api/ledger${q.text}`, undefined, ledgerOf, errorFor);
    },
  });
}
