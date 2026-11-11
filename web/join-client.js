// The web app's way of talking to the join link routes (R-023). Plain browser JavaScript.
//
// - Same rules as the other clients: the same address by path only, JSON, the cookie left to the browser, and it never throws:
//   `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - **A link's token is only ever sent in a request body** (never a path or a query), and only if it has exactly the shape this
//   service makes; anything else is "this link does not work" and nothing is sent.
// - Circle, link and request ids are checked against their exact shapes before they are put in a path.
// - Only the fields each call is meant to send are sent, every answer is cut down to what the app uses, and an answer that is
//   not shaped right is a server problem, never a crash.
// - When join links are switched off the service answers 404 with words that are none of the three it uses for a missing circle,
//   link or request: that is `unavailable`, so a page can say "not switched on here" instead of "no such circle".

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';
import { circleOf, isUserId, memberOf } from './circles-client.js';

const shapes = Object.freeze({ circle: /^c[a-z0-9]{16}$/, link: /^j[a-z0-9]{16}$/, request: /^r[a-z0-9]{16}$/ });
export const TOKEN_SHAPE = /^cjoin_[A-Za-z0-9_-]{43}$/;
export const isJoinLinkId = (value) => typeof value === 'string' && shapes.link.test(value);
export const isJoinRequestId = (value) => typeof value === 'string' && shapes.request.test(value);
export const isJoinToken = (value) => typeof value === 'string' && TOKEN_SHAPE.test(value);

const WORDS = Object.freeze({
  circle: 'No such circle, or you are not in it.',
  link: 'This link does not work: it may have been used up, have expired or have been withdrawn.',
  request: 'No such request: it may have been approved, declined or have lapsed.',
});
/** What the service says for each missing thing, by its fixed words. */
const SERVICE_SAYS = Object.freeze({ 'no such circle': 'circle', 'no such join link': 'link', 'no such join request': 'request' });
export const UNAVAILABLE = 'Join links are not switched on in this service.';

const ROLES = Object.freeze(['member', 'observer']);
const isRole = (value) => typeof value === 'string' && ROLES.includes(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value) => value === undefined || typeof value === 'string';
const whole = (value) => Number.isSafeInteger(value) && value >= 0;

function linkOf(json) {
  if (!isObject(json) || !isJoinLinkId(json.id) || !isRole(json.role) || typeof json.label !== 'string' || !whole(json.createdAt) || !whole(json.expiresAt) || !whole(json.maxUses) || json.maxUses < 1 || !whole(json.uses) || typeof json.approval !== 'boolean') return undefined;
  if (!isObject(json.createdBy) || !isUserId(json.createdBy.userId) || !optionalText(json.createdBy.displayName)) return undefined;
  return Object.freeze({
    id: json.id,
    role: json.role,
    label: json.label,
    createdBy: Object.freeze({ userId: json.createdBy.userId, ...(json.createdBy.displayName === undefined ? {} : { displayName: json.createdBy.displayName }) }),
    createdAt: json.createdAt,
    expiresAt: json.expiresAt,
    maxUses: json.maxUses,
    uses: json.uses,
    approval: json.approval,
  });
}

function requestOf(json) {
  if (!isObject(json) || !isJoinRequestId(json.id) || !isRole(json.role) || !whole(json.createdAt) || !whole(json.expiresAt) || !isObject(json.person) || !optionalText(json.person.displayName)) return undefined;
  return Object.freeze({ id: json.id, person: Object.freeze(json.person.displayName === undefined ? {} : { displayName: json.person.displayName }), role: json.role, createdAt: json.createdAt, expiresAt: json.expiresAt });
}

function myRequestOf(json) {
  if (!isObject(json) || !isJoinRequestId(json.id) || !isRole(json.role) || !whole(json.createdAt) || !whole(json.expiresAt) || !isObject(json.circle) || typeof json.circle.name !== 'string') return undefined;
  return Object.freeze({ id: json.id, circle: Object.freeze({ name: json.circle.name }), role: json.role, createdAt: json.createdAt, expiresAt: json.expiresAt });
}

const pageOf = (itemOf) => (json) => {
  if (!isObject(json) || !Array.isArray(json.items) || !(json.nextCursor === null || (typeof json.nextCursor === 'string' && json.nextCursor !== ''))) return undefined;
  const items = [];
  for (const raw of json.items) {
    const item = itemOf(raw);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor: json.nextCursor });
};

function createdOf(json) {
  if (!isObject(json) || !isJoinToken(json.token)) return undefined;
  const link = linkOf(json.link);
  return link === undefined ? undefined : Object.freeze({ token: json.token, link });
}

function previewOf(json) {
  const p = isObject(json) ? json.preview : undefined;
  if (!isObject(p) || !isObject(p.circle) || typeof p.circle.name !== 'string' || !isRole(p.role) || !isObject(p.createdBy) || !optionalText(p.createdBy.displayName)) return undefined;
  return Object.freeze({ circle: Object.freeze({ name: p.circle.name }), role: p.role, createdBy: Object.freeze(p.createdBy.displayName === undefined ? {} : { displayName: p.createdBy.displayName }) });
}

function resultOf(json) {
  const r = isObject(json) ? json.result : undefined;
  if (!isObject(r)) return undefined;
  if (r.state === 'joined' || r.state === 'member') {
    const circle = circleOf(r.circle);
    return circle === undefined ? undefined : Object.freeze({ state: r.state, circle });
  }
  if (r.state === 'requested' || r.state === 'waiting') {
    if (!isObject(r.circle) || typeof r.circle.name !== 'string' || !isRole(r.role) || !whole(r.expiresAt)) return undefined;
    return Object.freeze({ state: r.state, circle: Object.freeze({ name: r.circle.name }), role: r.role, expiresAt: r.expiresAt });
  }
  return undefined;
}

const memberAnswer = (json) => (isObject(json) ? memberOf(json.member) : undefined);
const nothing = () => true;

/** What a refusal means. `fields` are the form fields a 422 may name. */
function errorFor(fields, status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  if (status === 401) return { kind: 'signed-out', message: 'Your session has ended. Sign in again.' };
  if (status === 403) return { kind: 'forbidden', message: 'Your role in this circle does not allow that.' };
  if (status === 404) {
    const what = Object.hasOwn(SERVICE_SAYS, error.message) ? SERVICE_SAYS[error.message] : undefined;
    return what === undefined ? { kind: 'unavailable', message: UNAVAILABLE } : { kind: 'not-found', what, message: WORDS[what] };
  }
  if (status === 409) return { kind: 'conflict', message: cleanMessage(error.message, 'That cannot be done right now.') };
  if (status === 422) {
    const field = fields.includes(error.field) ? error.field : undefined;
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you typed.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) {
    if (error.code === 'LIMIT_REACHED') return { kind: 'limit', message: cleanMessage(error.message, 'A limit has been reached.') };
    const seconds = parseRetryAfter(retryAfter);
    return { kind: 'throttled', message: seconds === undefined ? 'Too many tries. Wait a little and try again.' : `Too many tries. Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} and try again.`, ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  }
  return { kind: 'server', message: SERVER };
}

function query(page) {
  if (page === undefined) return { text: '' };
  if (!isObject(page)) return { problem: { kind: 'invalid', message: 'Please check what you asked for.' } };
  const parts = [];
  if (page.limit !== undefined) {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) return { problem: { kind: 'invalid', field: 'limit', message: 'A page is 1 to 100 items.' } };
    parts.push(`limit=${page.limit}`);
  }
  if (page.cursor !== undefined && page.cursor !== null) {
    if (typeof page.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(page.cursor)) return { problem: { kind: 'invalid', field: 'cursor', message: 'That page marker is not one the service gave.' } };
    parts.push(`cursor=${encodeURIComponent(page.cursor)}`);
  }
  return { text: parts.length === 0 ? '' : `?${parts.join('&')}` };
}

export function createJoinClient({ fetchFn }) {
  const send = createRequester(fetchFn);

  /** `ids` are `[kind, value]` pairs checked before a path is built; a bad one is a not-found and nothing is sent. */
  async function call({ method, ids = [], path, body, parse, fields = [], page }) {
    for (const [kind, value] of ids) {
      if (typeof value !== 'string' || !shapes[kind].test(value)) return fail({ kind: 'not-found', what: kind, message: WORDS[kind] });
    }
    const q = query(page);
    if (q.problem) return fail(q.problem);
    return send(method, `${path(ids.map(([, value]) => value))}${q.text}`, body, parse, (status, json, retryAfter) => errorFor(fields, status, json, retryAfter));
  }
  /** A call that takes the token in its body: a token that is not shaped like one is a miss without being sent. */
  function withToken(path, token, parse) {
    if (!isJoinToken(token)) return Promise.resolve(fail({ kind: 'not-found', what: 'link', message: WORDS.link }));
    return call({ method: 'POST', path: () => path, body: { token }, parse });
  }

  return Object.freeze({
    /** `{ label, role?, days?, uses?, approval? }`: only what is given is sent. The answer holds the token, once. */
    createLink: (circleId, input = {}) => {
      const body = { label: input.label };
      for (const key of ['role', 'days', 'uses', 'approval']) if (input[key] !== undefined) body[key] = input[key];
      return call({ method: 'POST', ids: [['circle', circleId]], path: ([c]) => `/api/circles/${c}/join-links`, body, parse: createdOf, fields: ['label', 'role', 'days', 'uses', 'approval'] });
    },
    listLinks: (circleId, page) => call({ method: 'GET', ids: [['circle', circleId]], path: ([c]) => `/api/circles/${c}/join-links`, parse: pageOf(linkOf), page }),
    revokeLink: (circleId, linkId) => call({ method: 'DELETE', ids: [['circle', circleId], ['link', linkId]], path: ([c, l]) => `/api/circles/${c}/join-links/${l}`, parse: nothing }),
    preview: (token) => withToken('/api/join/preview', token, previewOf),
    join: (token) => withToken('/api/join', token, resultOf),
    listRequests: (circleId, page) => call({ method: 'GET', ids: [['circle', circleId]], path: ([c]) => `/api/circles/${c}/join-requests`, parse: pageOf(requestOf), page }),
    approve: (circleId, requestId) => call({ method: 'POST', ids: [['circle', circleId], ['request', requestId]], path: ([c, r]) => `/api/circles/${c}/join-requests/${r}/approve`, parse: memberAnswer }),
    decline: (circleId, requestId) => call({ method: 'POST', ids: [['circle', circleId], ['request', requestId]], path: ([c, r]) => `/api/circles/${c}/join-requests/${r}/decline`, parse: nothing }),
    myRequests: (page) => call({ method: 'GET', path: () => '/api/join-requests', parse: pageOf(myRequestOf), page }),
  });
}

