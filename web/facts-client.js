// The web app's way of dealing with a fact (R-025): apply a verb to one exact fact, take it back, list your own. Plain browser JavaScript.
//
// - Four routes: `POST /api/facts/resolve`, `POST /api/facts/unresolve`, `GET /api/facts/resolutions` and `GET /api/facts/verbs` (the vocabulary). A fact is named by
//   `{ scope, id }` exactly as a status point carries it; the page never sends words, a graph or a person.
// - Same rules as the other clients: same address by path only, the cookie left to the browser, never throws:
//   `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - Ids and the verb are checked before anything is sent (a bad one is "not found" or "invalid" and sends nothing), every answer is cut
//   down to the fields the page uses, and anything not shaped right is a server problem.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';
import { NO_CIRCLE } from './notes-client.js';

const SIGNED_OUT = 'Your session has ended. Sign in again.';
export const NO_FACT = 'That fact is no longer there. Ask again for a fresh answer.';
export const FORBIDDEN_REMOVE = 'Only the owner can remove a fact for everyone.';
const CIRCLE_ID = /^c[a-z0-9]{16}$/;
const VERB = /^[a-z0-9-]{1,20}$/;
const ID_MAX = 256;
const EFFECTS = Object.freeze(['clear', 'remove']);
const RESULTS = Object.freeze(['hidden', 'deleted']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (id) => typeof id === 'string' && id !== '' && [...id].length <= ID_MAX && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id);

/** `{ kind: 'personal' }` or `{ kind: 'circle', circleId }` with a circle id of the exact shape, cut down to those fields; anything else is undefined. */
export function scopeOf(raw) {
  if (!isObject(raw)) return undefined;
  if (raw.kind === 'personal') return Object.freeze({ kind: 'personal' });
  if (raw.kind === 'circle' && typeof raw.circleId === 'string' && CIRCLE_ID.test(raw.circleId)) return Object.freeze({ kind: 'circle', circleId: raw.circleId });
  return undefined;
}

/** A fact reference `{ scope, id }` as the page may send it: a missing scope is your own brain. Undefined when it is not one. */
export function factOf(raw) {
  if (!isObject(raw) || !validId(raw.id)) return undefined;
  const scope = raw.scope === undefined ? Object.freeze({ kind: 'personal' }) : scopeOf(raw.scope);
  return scope === undefined ? undefined : Object.freeze({ scope, id: raw.id });
}

const scopeText = (scope) => (scope.kind === 'personal' ? 'personal' : `circle:${scope.circleId}`);

function refOf(raw) {
  if (!isObject(raw) || !validId(raw.id)) return undefined;
  const scope = scopeOf(raw.scope);
  return scope === undefined ? undefined : Object.freeze({ scope, id: raw.id });
}

function resolvedOf(json) {
  const v = isObject(json) ? json.resolved : undefined;
  if (!isObject(v) || typeof v.verb !== 'string' || !VERB.test(v.verb) || !EFFECTS.includes(v.effect) || !RESULTS.includes(v.result)) return undefined;
  const fact = refOf(v.fact);
  return fact === undefined ? undefined : Object.freeze({ fact, verb: v.verb, effect: v.effect, result: v.result });
}

function unresolvedOf(json) {
  const v = isObject(json) ? json.unresolved : undefined;
  const fact = isObject(v) ? refOf(v.fact) : undefined;
  return fact === undefined ? undefined : Object.freeze({ fact });
}

function resolutionsOf(json) {
  if (!isObject(json) || !Array.isArray(json.items)) return undefined;
  const items = [];
  for (const raw of json.items) {
    const fact = isObject(raw) ? refOf(raw.fact) : undefined;
    if (fact === undefined || typeof raw.verb !== 'string' || !VERB.test(raw.verb) || !Number.isSafeInteger(raw.at) || raw.at < 0) return undefined;
    items.push(Object.freeze({ fact, verb: raw.verb, at: raw.at }));
  }
  let next = null;
  if (json.next !== null) {
    next = refOf(json.next);
    if (next === undefined) return undefined;
  }
  return Object.freeze({ items: Object.freeze(items), next });
}

const HELP_MAX = 80;
function verbsOf(json) {
  if (!isObject(json) || !Array.isArray(json.items) || json.items.length > 20) return undefined;
  const items = [];
  for (const raw of json.items) {
    if (!isObject(raw) || typeof raw.name !== 'string' || !VERB.test(raw.name) || !EFFECTS.includes(raw.effect) || typeof raw.help !== 'string' || raw.help === '' || [...raw.help].length > HELP_MAX) return undefined;
    items.push(Object.freeze({ name: raw.name, effect: raw.effect, help: raw.help }));
  }
  return Object.freeze({ items: Object.freeze(items) });
}

function errorFor(status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  const message = typeof error.message === 'string' ? error.message : '';
  const seconds = parseRetryAfter(retryAfter);
  if (status === 401) return { kind: 'signed-out', message: SIGNED_OUT };
  if (status === 403) return { kind: 'forbidden', message: FORBIDDEN_REMOVE };
  if (status === 404) return message.includes('circle') ? { kind: 'not-found', what: 'circle', message: NO_CIRCLE } : { kind: 'not-found', what: 'fact', message: NO_FACT };
  if (status === 422) {
    const field = ['scope', 'id', 'verb', 'limit', 'after'].find((f) => f === error.field || (typeof error.field === 'string' && error.field.startsWith(`${f}.`)) || error.field === `after_${f}`);
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you asked for.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) return { kind: 'limit', message: cleanMessage(error.message, 'A limit has been reached. Try again later.'), ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  return { kind: 'server', message: SERVER };
}

export function createFactsClient({ fetchFn }) {
  const send = createRequester(fetchFn);
  const notFound = () => Promise.resolve(fail({ kind: 'not-found', what: 'fact', message: NO_FACT }));
  return Object.freeze({
    /** Applies a verb (by name) to one fact: `fact` is `{ scope, id }` as a status point carries it. */
    resolve(fact, verb) {
      const ref = factOf(fact);
      if (ref === undefined) return notFound();
      if (typeof verb !== 'string' || !VERB.test(verb)) return Promise.resolve(fail({ kind: 'invalid', field: 'verb', message: 'Choose one of the verbs.' }));
      return send('POST', '/api/facts/resolve', { scope: ref.scope, id: ref.id, verb }, resolvedOf, errorFor);
    },
    /** Takes back your own resolution of a fact (the answer is the same when there was none). */
    unresolve(fact) {
      const ref = factOf(fact);
      if (ref === undefined) return notFound();
      return send('POST', '/api/facts/unresolve', { scope: ref.scope, id: ref.id }, unresolvedOf, errorFor);
    },
    /** The vocabulary of verbs the service offers: name, effect (`clear` or `remove`) and a help line each. */
    verbs() {
      return send('GET', '/api/facts/verbs', undefined, verbsOf, errorFor);
    },
    /** One page of your own resolutions; `page.after` is the `next` of the page before. */
    list(page = {}) {
      if (!isObject(page)) return Promise.resolve(fail({ kind: 'invalid', field: 'limit', message: 'Please check what you asked for.' }));
      const parts = [];
      if (page.limit !== undefined) {
        if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) return Promise.resolve(fail({ kind: 'invalid', field: 'limit', message: 'A page is 1 to 100 resolutions.' }));
        parts.push(`limit=${page.limit}`);
      }
      if (page.after !== undefined) {
        const after = refOf(page.after);
        if (after === undefined) return Promise.resolve(fail({ kind: 'invalid', field: 'after', message: 'That page position is not one of ours.' }));
        parts.push(`after_scope=${scopeText(after.scope)}`, `after_id=${encodeURIComponent(after.id)}`);
      }
      return send('GET', `/api/facts/resolutions${parts.length === 0 ? '' : `?${parts.join('&')}`}`, undefined, resolutionsOf, errorFor);
    },
  });
}
