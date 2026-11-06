// The web app's way of managing the person's agent access keys (R-022): list, make and stop. Plain browser JavaScript.
//
// - Three routes on the same address, `/api/me/agent-tokens`, with the session cookie left to the browser. The key is shown by the
//   service once, in the answer to making it, and never in a list.
// - Never throws: `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`. A service that has agent access
//   switched off answers 404, which is `unavailable` here: the page then shows nothing at all.
// - Early checks mirror the service's (the service decides). Only the four fields the service takes are sent.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';
import { isCircleId } from './circles-client.js';

const SIGNED_OUT = 'Your session has ended. Sign in again.';
const UNAVAILABLE = 'Agent access is not switched on for this service.';
const GONE = 'That access key no longer exists.';
const NAME_MAX = 60;
const SCOPES_MAX = 20;
const TOKEN = /^cpat_[A-Za-z0-9_-]{43}$/;
const ID = /^t[a-z0-9]{16}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v) => Number.isSafeInteger(v) && v >= 0;
const validScope = (s) => s === 'personal' || (typeof s === 'string' && s.startsWith('circle:') && isCircleId(s.slice(7)));

function viewOf(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string' || raw.name === '') return undefined;
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0 || raw.scopes.length > SCOPES_MAX || !raw.scopes.every(validScope)) return undefined;
  if (typeof raw.checks !== 'boolean' || !whole(raw.createdAt) || !whole(raw.expiresAt) || !(raw.lastUsedAt === null || whole(raw.lastUsedAt))) return undefined;
  return Object.freeze({ id: raw.id, name: raw.name, scopes: Object.freeze([...raw.scopes]), checks: raw.checks, createdAt: raw.createdAt, expiresAt: raw.expiresAt, lastUsedAt: raw.lastUsedAt });
}
function listOf(json) {
  if (!isObject(json) || !Array.isArray(json.items)) return undefined;
  const items = [];
  for (const raw of json.items) {
    const v = viewOf(raw);
    if (v === undefined) return undefined;
    items.push(v);
  }
  return Object.freeze({ items: Object.freeze(items) });
}
function madeOf(json) {
  if (!isObject(json) || typeof json.token !== 'string' || !TOKEN.test(json.token)) return undefined;
  const agentToken = viewOf(json.agentToken);
  return agentToken === undefined ? undefined : Object.freeze({ token: json.token, agentToken });
}

function errorFor(status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  const seconds = parseRetryAfter(retryAfter);
  if (status === 401) return { kind: 'signed-out', message: SIGNED_OUT };
  if (status === 404) return { kind: 'unavailable', message: UNAVAILABLE };
  if (status === 409) return { kind: 'limit', message: cleanMessage(error.message, 'You already have the most access keys allowed: stop one first.') };
  if (status === 422) {
    const field = ['name', 'scopes', 'checks', 'days'].find((f) => f === error.field);
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you asked for.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) return { kind: 'throttled', message: cleanMessage(error.message, 'Too many requests. Try again later.'), ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  return { kind: 'server', message: SERVER };
}
const revokeError = (status, json, retryAfter) => (status === 404 ? { kind: 'not-found', message: GONE } : errorFor(status, json, retryAfter));

export function createAgentTokensClient({ fetchFn }) {
  const send = createRequester(fetchFn);
  return Object.freeze({
    /** The person's live access keys, newest first. `unavailable` when the service has agent access off. */
    list: () => send('GET', '/api/me/agent-tokens', undefined, listOf, errorFor),
    /** Makes a key: `{ name, scopes: ['personal', 'circle:<id>'...], checks, days }`. The key itself is in the answer once. */
    create(input) {
      const bad = (field, message) => Promise.resolve(fail({ kind: 'invalid', field, message }));
      if (!isObject(input)) return bad('name', 'Give the key a name.');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '' || [...name].length > NAME_MAX) return bad('name', `Give the key a name of 1 to ${NAME_MAX} characters.`);
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) return bad('scopes', 'Choose at least one set of notes it may read.');
      if (input.scopes.length > SCOPES_MAX || !input.scopes.every(validScope) || new Set(input.scopes).size !== input.scopes.length) return bad('scopes', 'Those notes cannot be chosen.');
      if (typeof input.checks !== 'boolean') return bad('checks', 'Say whether it may ask for attention checks.');
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) return bad('days', 'Choose how long the key lasts: 1 to 365 days.');
      return send('POST', '/api/me/agent-tokens', { name, scopes: [...input.scopes], checks: input.checks, days: input.days }, madeOf, errorFor);
    },
    /** Stops one key by its id. */
    revoke: (id) => (typeof id === 'string' && ID.test(id) ? send('DELETE', `/api/me/agent-tokens/${id}`, undefined, () => true, revokeError) : Promise.resolve(fail({ kind: 'not-found', message: GONE }))),
  });
}
