// The web app's way of talking to the sharing routes (R-008). Plain browser JavaScript.
//
// - Same rules as the other clients: the same address by path only, JSON, the cookie left to the browser, and
//   it never throws: `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - **Circle and person ids have the exact shape the service makes** before they are put in a path (a bad one
//   is a "not found" and nothing is sent). **A category or item id is any non-empty text of at most 256
//   characters and goes only in the query string, encoded.** The page never names whose brain is read except
//   by the id the service gave in the list of who has shared with you, and never names a graph.
// - Only `{ categories }` is ever sent. Every answer is cut down to the fields the page uses.
// - Refusals become kinds and plain words. What is not shared with you reads as one "not found", whatever the
//   reason; the service's own words are used only for field problems and limits, after cleaning.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';
import { isCircleId, isUserId } from './circles-client.js';
import { categoryItemsOf, categoryOf, isNodeId, itemDetailOf, pageOf, query } from './notes-client.js';

export const MAX_SHARED_CATEGORIES = 200;
const NOT_FOUND = Object.freeze({
  circle: 'No such circle, or you are not in it.',
  member: 'That person is no longer in this circle.',
  brain: 'Nothing is shared with you by that person.',
  category: 'Not found: it may no longer be shared with you.',
  item: 'Not found: it may no longer be shared with you.',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const optionalText = (value) => value === undefined || typeof value === 'string';
const named = (json) => ({ ...(typeof json.username === 'string' ? { username: json.username } : {}), ...(typeof json.displayName === 'string' ? { displayName: json.displayName } : {}) });

function grantOf(json) {
  if (!isObject(json) || !isUserId(json.userId) || !optionalText(json.username) || !optionalText(json.displayName) || !whole(json.updatedAt) || !Array.isArray(json.categories)) return undefined;
  const categories = [];
  for (const raw of json.categories) {
    if (!isObject(raw) || !isNodeId(raw.id) || !optionalText(raw.name)) return undefined;
    categories.push(Object.freeze({ id: raw.id, ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}) }));
  }
  return Object.freeze({ userId: json.userId, ...named(json), categories: Object.freeze(categories), updatedAt: json.updatedAt });
}

function sharedBrainOf(json) {
  if (!isObject(json) || !isUserId(json.userId) || !optionalText(json.username) || !optionalText(json.displayName) || !whole(json.categoryCount)) return undefined;
  return Object.freeze({ userId: json.userId, ...named(json), categoryCount: json.categoryCount });
}

/** A set answers `{ grant }`; the empty set answers nothing (204), which is `{ grant: null }` here. */
const setAnswer = (json) => {
  if (json === undefined) return Object.freeze({ grant: null });
  const grant = isObject(json) ? grantOf(json.grant) : undefined;
  return grant === undefined ? undefined : Object.freeze({ grant });
};

const nothing = () => true;

/** What a 404 is about: the service's own words tell a missing circle from the rest; otherwise it is what the call asked about (the person named in a grant call, the owner of a brain in a read). */
function whatOf(what, json) {
  const message = isObject(json) && isObject(json.error) ? json.error.message : undefined;
  if (message === 'no such circle') return 'circle';
  return what;
}

function errorFor(what, fields, status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  if (status === 401) return { kind: 'signed-out', message: 'Your session has ended. Sign in again.' };
  if (status === 403) return { kind: 'forbidden', message: 'The service refused that request.' };
  if (status === 404) {
    const kind = whatOf(what, json);
    return { kind: 'not-found', what: kind, message: NOT_FOUND[kind] };
  }
  if (status === 422) {
    const field = fields.includes(error.field) ? error.field : undefined;
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you chose.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) {
    if (error.code === 'LIMIT_REACHED') return { kind: 'limit', message: cleanMessage(error.message, 'A limit has been reached.') };
    const seconds = parseRetryAfter(retryAfter);
    return { kind: 'throttled', message: seconds === undefined ? 'Too many tries. Wait a little and try again.' : `Too many tries. Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} and try again.`, ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  }
  return { kind: 'server', message: SERVER };
}

export function createSharingClient({ fetchFn }) {
  const send = createRequester(fetchFn);

  /** `ids` are `[kind, value]` pairs for the path ('circle' or 'user'); `node` is `[id]` for a category or item id in the query string. */
  async function call({ method, ids = [], path, body, parse, what = 'circle', fields = [], page, node }) {
    for (const [kind, value] of ids) {
      const ok = kind === 'circle' ? isCircleId(value) : isUserId(value);
      if (!ok) {
        const about = kind === 'circle' ? 'circle' : what === 'circle' || what === 'member' ? 'member' : 'brain';
        return fail({ kind: 'not-found', what: about, message: NOT_FOUND[about] });
      }
    }
    const extra = [];
    if (node !== undefined) {
      if (!isNodeId(node[0])) return fail({ kind: 'not-found', what, message: NOT_FOUND[what] });
      extra.push(`id=${encodeURIComponent(node[0])}`);
    }
    const q = query(page, extra);
    if (q.problem) return fail(q.problem);
    return send(method, `${path(ids.map(([, value]) => value))}${q.text}`, body, parse, (status, json, retryAfter) => errorFor(what, fields, status, json, retryAfter));
  }

  return Object.freeze({
    /** What I share in a circle, one entry per other member. */
    listGrants: (circleId, page) => call({ method: 'GET', ids: [['circle', circleId]], path: ([c]) => `/api/circles/${c}/grants`, parse: pageOf(grantOf), page, fields: ['limit', 'cursor'] }),
    /** Replaces the set shared with one member; the empty list withdraws it (`{ grant: null }`). Only `{ categories }` is sent. */
    setGrant(circleId, userId, categories) {
      if (!Array.isArray(categories) || categories.length > MAX_SHARED_CATEGORIES || !categories.every(isNodeId)) {
        return Promise.resolve(fail({ kind: 'invalid', field: 'categories', message: `Choose at most ${MAX_SHARED_CATEGORIES} of your categories.` }));
      }
      return call({ method: 'PUT', ids: [['circle', circleId], ['user', userId]], path: ([c, u]) => `/api/circles/${c}/grants/${u}`, body: { categories }, parse: setAnswer, what: 'member', fields: ['categories', 'granteeId'] });
    },
    withdrawGrant: (circleId, userId) => call({ method: 'DELETE', ids: [['circle', circleId], ['user', userId]], path: ([c, u]) => `/api/circles/${c}/grants/${u}`, parse: nothing, what: 'member' }),
    /** Who in the circle has shared with me. */
    sharedWithMe: (circleId, page) => call({ method: 'GET', ids: [['circle', circleId]], path: ([c]) => `/api/circles/${c}/shared`, parse: pageOf(sharedBrainOf), page, fields: ['limit', 'cursor'] }),
    sharedCategories: (circleId, ownerId, page) => call({ method: 'GET', ids: [['circle', circleId], ['user', ownerId]], path: ([c, u]) => `/api/circles/${c}/shared/${u}/categories`, parse: pageOf(categoryOf), page, what: 'brain', fields: ['limit', 'cursor'] }),
    sharedCategoryItems: (circleId, ownerId, categoryId, page) => call({ method: 'GET', ids: [['circle', circleId], ['user', ownerId]], path: ([c, u]) => `/api/circles/${c}/shared/${u}/category`, parse: categoryItemsOf, page, node: [categoryId], what: 'category', fields: ['limit', 'cursor', 'id'] }),
    sharedItem: (circleId, ownerId, itemId) => call({ method: 'GET', ids: [['circle', circleId], ['user', ownerId]], path: ([c, u]) => `/api/circles/${c}/shared/${u}/item`, parse: itemDetailOf, node: [itemId], what: 'item', fields: ['id'] }),
  });
}
