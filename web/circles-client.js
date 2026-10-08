// The web app's way of talking to the circle and invitation routes (R-004, R-006). Plain browser JavaScript.
//
// - Same rules as the account client: the same address by path only, JSON, the cookie left to the browser,
//   and it never throws: `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - **Every id is checked against the exact shape the service makes before it is put in a path** (a bad one
//   is a "not found" and nothing is sent), and the same for the ids that come back in answers.
// - Only the fields each call is meant to send are sent, and every answer is cut down to the fields the app
//   uses; an answer that is not shaped right is a server problem, never a crash.
// - Refusals become kinds and plain words (R-006). The service's own words are used where they say something
//   a person can act on (the only owner, a limit, a field's problem) and only after cleaning.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';

const ROLES = Object.freeze(['owner', 'manager', 'member', 'observer']);
const shapes = Object.freeze({ circle: /^c[a-z0-9]{16}$/, invitation: /^i[a-z0-9]{16}$/, user: /^u[a-z0-9]{16}$/ });
const NO_CIRCLE = 'No such circle, or you are not in it.';
const NOT_FOUND = Object.freeze({
  circle: NO_CIRCLE,
  invitation: 'No such invitation: it may have been withdrawn, used or expired.',
  member: 'That person is no longer in this circle.',
});

export const isCircleId = (value) => typeof value === 'string' && shapes.circle.test(value);
export const isInvitationId = (value) => typeof value === 'string' && shapes.invitation.test(value);
export const isUserId = (value) => typeof value === 'string' && shapes.user.test(value);
export const isRole = (value) => typeof value === 'string' && ROLES.includes(value);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value) => value === undefined || typeof value === 'string';
const whole = (value) => Number.isSafeInteger(value) && value >= 0;

function circleOf(json) {
  if (!isObject(json) || !isCircleId(json.id) || typeof json.name !== 'string' || !isRole(json.role) || !whole(json.memberCount) || !whole(json.createdAt) || !whole(json.updatedAt) || !optionalText(json.description)) return undefined;
  return Object.freeze({ id: json.id, name: json.name, ...(json.description === undefined ? {} : { description: json.description }), role: json.role, memberCount: json.memberCount, createdAt: json.createdAt, updatedAt: json.updatedAt });
}

function memberOf(json) {
  if (!isObject(json) || !isUserId(json.userId) || !isRole(json.role) || !whole(json.joinedAt) || !optionalText(json.username) || !optionalText(json.displayName)) return undefined;
  return Object.freeze({ userId: json.userId, ...(json.username === undefined ? {} : { username: json.username }), ...(json.displayName === undefined ? {} : { displayName: json.displayName }), role: json.role, joinedAt: json.joinedAt });
}

function invitationOf(json) {
  if (!isObject(json) || !isInvitationId(json.id) || typeof json.username !== 'string' || !isRole(json.role) || !whole(json.createdAt) || !whole(json.expiresAt) || !isObject(json.invitedBy) || !isUserId(json.invitedBy.userId) || !optionalText(json.invitedBy.displayName)) return undefined;
  return Object.freeze({
    id: json.id,
    username: json.username,
    role: json.role,
    invitedBy: Object.freeze({ userId: json.invitedBy.userId, ...(json.invitedBy.displayName === undefined ? {} : { displayName: json.invitedBy.displayName }) }),
    createdAt: json.createdAt,
    expiresAt: json.expiresAt,
  });
}

function myInvitationOf(json) {
  if (!isObject(json) || !isInvitationId(json.id) || !isRole(json.role) || !whole(json.createdAt) || !whole(json.expiresAt) || !isObject(json.circle) || !isCircleId(json.circle.id) || typeof json.circle.name !== 'string' || !isObject(json.invitedBy) || !optionalText(json.invitedBy.displayName)) return undefined;
  return Object.freeze({
    id: json.id,
    circle: Object.freeze({ id: json.circle.id, name: json.circle.name }),
    role: json.role,
    invitedBy: Object.freeze(json.invitedBy.displayName === undefined ? {} : { displayName: json.invitedBy.displayName }),
    createdAt: json.createdAt,
    expiresAt: json.expiresAt,
  });
}

/** A page: every item must be shaped right, or the whole answer is refused. */
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

const circleAnswer = (json) => (isObject(json) ? circleOf(json.circle) : undefined);
const memberAnswer = (json) => (isObject(json) ? memberOf(json.member) : undefined);
const invited = (json) => (isObject(json) && json.invited === true ? Object.freeze({ invited: true }) : undefined);
const nothing = () => true;

/** What a refusal means for the call being made. `what` names what a 404 is about; `fields` the form fields a 422 may name. */
function errorFor(what, fields, status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  if (status === 401) return { kind: 'signed-out', message: 'Your session has ended. Sign in again.' };
  if (status === 403) return { kind: 'forbidden', message: 'Your role in this circle does not allow that.' };
  if (status === 404) return { kind: 'not-found', what, message: NOT_FOUND[what] };
  if (status === 409) {
    if (error.code === 'LAST_OWNER') return { kind: 'last-owner', message: cleanMessage(error.message, 'You are the only owner: make someone else an owner, or delete the circle.') };
    return { kind: 'conflict', message: cleanMessage(error.message, 'That cannot be done right now.') };
  }
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

/** `?limit=&cursor=` from page options, or the problem with them. */
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

export function createCirclesClient({ fetchFn }) {
  const send = createRequester(fetchFn);

  /** Checks the ids, builds the path, sends. `ids` are `[kind, value]` pairs; a bad one is a not-found and nothing is sent. */
  async function call({ method, ids = [], path, body, parse, what = 'circle', fields = [], page }) {
    for (const [kind, value] of ids) {
      if (typeof value !== 'string' || !shapes[kind].test(value)) return fail({ kind: 'not-found', what: kind === 'user' ? 'member' : kind, message: NOT_FOUND[kind === 'user' ? 'member' : kind] });
    }
    const q = query(page);
    if (q.problem) return fail(q.problem);
    return send(method, `${path(ids.map(([, value]) => value))}${q.text}`, body, parse, (status, json, retryAfter) => errorFor(what, fields, status, json, retryAfter));
  }

  const text = (value) => (typeof value === 'string' ? value : undefined);

  return Object.freeze({
    listCircles: (page) => call({ method: 'GET', path: () => '/api/circles', parse: pageOf(circleOf), page }),
    createCircle: ({ name, description } = {}) =>
      call({ method: 'POST', path: () => '/api/circles', body: { name, ...(text(description) === undefined || description === '' ? {} : { description }) }, parse: circleAnswer, fields: ['name', 'description'] }),
    getCircle: (id) => call({ method: 'GET', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}`, parse: circleAnswer }),
    /** `{ name?, description? }`; `description: null` removes it. Only what is given is sent. */
    updateCircle: (id, change) => {
      const body = {};
      if (isObject(change)) {
        if (change.name !== undefined) body.name = change.name;
        if (change.description !== undefined) body.description = change.description;
      }
      if (Object.keys(body).length === 0) return Promise.resolve(fail({ kind: 'invalid', field: 'body', message: 'Nothing to change.' }));
      return call({ method: 'PATCH', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}`, body, parse: circleAnswer, fields: ['name', 'description'] });
    },
    deleteCircle: (id) => call({ method: 'DELETE', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}`, parse: nothing }),
    listMembers: (id, page) => call({ method: 'GET', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}/members`, parse: pageOf(memberOf), page }),
    changeRole: (id, userId, role) => call({ method: 'PATCH', ids: [['circle', id], ['user', userId]], path: ([c, u]) => `/api/circles/${c}/members/${u}`, body: { role }, parse: memberAnswer, what: 'member', fields: ['role'] }),
    removeMember: (id, userId) => call({ method: 'DELETE', ids: [['circle', id], ['user', userId]], path: ([c, u]) => `/api/circles/${c}/members/${u}`, parse: nothing, what: 'member' }),
    leaveCircle: (id) => call({ method: 'POST', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}/leave`, parse: nothing }),
    /** The answer is the same whatever the username is (R-004): `{ invited: true }`. */
    invite: (id, { username, role } = {}) => call({ method: 'POST', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}/invitations`, body: { username, role }, parse: invited, fields: ['username', 'role'] }),
    listInvitations: (id, page) => call({ method: 'GET', ids: [['circle', id]], path: ([c]) => `/api/circles/${c}/invitations`, parse: pageOf(invitationOf), page }),
    withdrawInvitation: (id, invitationId) => call({ method: 'DELETE', ids: [['circle', id], ['invitation', invitationId]], path: ([c, i]) => `/api/circles/${c}/invitations/${i}`, parse: nothing, what: 'invitation' }),
    myInvitations: (page) => call({ method: 'GET', path: () => '/api/invitations', parse: pageOf(myInvitationOf), page }),
    acceptInvitation: (invitationId) => call({ method: 'POST', ids: [['invitation', invitationId]], path: ([i]) => `/api/invitations/${i}/accept`, parse: circleAnswer, what: 'invitation' }),
    declineInvitation: (invitationId) => call({ method: 'POST', ids: [['invitation', invitationId]], path: ([i]) => `/api/invitations/${i}/decline`, parse: nothing, what: 'invitation' }),
  });
}
