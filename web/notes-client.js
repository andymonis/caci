// The web app's way of talking to the note capture and browsing routes (R-003, R-007). Plain browser JavaScript.
//
// - Same rules as the other clients: same address by path only, JSON, the cookie left to the browser, and it
//   never throws: `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - **A proposal id has the exact shape the service makes** before it is put in a path. **A category or item id
//   is any non-empty text of at most 256 characters and goes only in the query string, encoded**, never in a
//   path or the address bar. The page never names a graph or a person: the service takes both from the session.
// - Every answer is cut down to the fields the app uses (never a graph id, usage, a prompt or a model name);
//   an answer that is not shaped right is a server problem, never a crash.
// - Refusals become kinds and words. The model's failures and the limits use the service's own fixed words
//   (after cleaning); everything else uses ours.

import { cleanMessage, createRequester, fail, parseRetryAfter, SERVER } from './api-client.js';

export const NOTE_MAX = 8000;
const ID_MAX = 256;
const PROPOSAL_ID = /^prop-[a-z0-9-]{1,60}$/;
const CURSOR = /^[A-Za-z0-9_.~-]{1,2048}$/;
const GONE_PROPOSAL = 'That proposal is gone or has expired. Make it again.';
export const NO_CIRCLE = 'No such circle, or you are not in it.';
const NOT_FOUND = Object.freeze({ proposal: GONE_PROPOSAL, category: 'Not found: it may have been removed.', item: 'Not found: it may have been removed.', circle: NO_CIRCLE });
const CIRCLE_ID = /^c[a-z0-9]{16}$/;
const SIGNED_OUT = 'Your session has ended. Sign in again.';

export const isProposalId = (value) => typeof value === 'string' && PROPOSAL_ID.test(value);
/** A category or item id: any non-empty text of at most 256 characters (ids are opaque). */
export const isNodeId = (value) => typeof value === 'string' && value !== '' && [...value].length <= ID_MAX && !hasLoneSurrogate(value);

function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
const optionalName = (value) => value === undefined || typeof value === 'string';
const MODES = Object.freeze(['demo', 'anthropic']);

export const isCircleId = (value) => typeof value === 'string' && CIRCLE_ID.test(value);

/** A circle scope, as the page holds it: its id, and optionally the name it was shown with (which is never sent); no other key. */
const isCircle = (scope) => isObject(scope) && scope.kind === 'circle' && isCircleId(scope.circleId) && Object.keys(scope).every((k) => k === 'kind' || k === 'circleId' || k === 'circleName');

/** Where something came from: `{ kind: 'personal' }` or a circle with its id and name; anything else is not shaped right. */
export function provenanceOf(raw) {
  if (!isObject(raw)) return undefined;
  if (raw.kind === 'personal') return Object.freeze({ kind: 'personal' });
  if (raw.kind === 'circle' && isCircleId(raw.circleId) && typeof raw.circleName === 'string') return Object.freeze({ kind: 'circle', circleId: raw.circleId, circleName: raw.circleName });
  return undefined;
}

/**
 * How a scope goes in a request: `personal`, `circle:<id>` or (where allowed) `mine`. A scope is `undefined` or
 * `{ kind: 'personal' }` (personal), `{ kind: 'circle', circleId }` or the text `mine`. Anything else is `undefined`.
 */
export function scopeText(scope, allowMine = false) {
  if (scope === undefined) return 'personal';
  if (scope === 'mine') return allowMine ? 'mine' : undefined;
  if (!isObject(scope)) return undefined;
  if (scope.kind === 'personal' && Object.keys(scope).length === 1) return 'personal';
  if (isCircle(scope)) return `circle:${scope.circleId}`;
  return undefined;
}

/** The scope a proposal is sent with: nothing for the personal brain, as before. */
const proposeScope = (scope) => (scope === undefined || (isObject(scope) && scope.kind === 'personal') ? undefined : isCircle(scope) ? Object.freeze({ kind: 'circle', circleId: scope.circleId }) : null);

function operationOf(json) {
  if (!isObject(json)) return undefined;
  if (json.op === 'upsertNode') {
    if ((json.partition !== 'item' && json.partition !== 'category') || typeof json.id !== 'string' || !(json.data === undefined || isObject(json.data))) return undefined;
    return Object.freeze({ op: 'upsertNode', partition: json.partition, id: json.id, ...(json.data === undefined ? {} : { data: Object.freeze({ ...json.data }) }) });
  }
  if (json.op === 'link') {
    if (typeof json.item !== 'string' || typeof json.category !== 'string' || !(json.weight === undefined || typeof json.weight === 'number')) return undefined;
    return Object.freeze({ op: 'link', item: json.item, category: json.category, ...(json.weight === undefined ? {} : { weight: json.weight }) });
  }
  return undefined;
}

function summaryOf(json) {
  if (!isObject(json)) return undefined;
  const lists = ['newItems', 'updatedItems', 'newCategories', 'updatedCategories', 'reusedCategories', 'problems', 'notes'];
  if (!lists.every((k) => strings(json[k]))) return undefined;
  if (!Array.isArray(json.newLinks) || !json.newLinks.every((l) => isObject(l) && typeof l.item === 'string' && typeof l.category === 'string')) return undefined;
  return Object.freeze({
    ...Object.fromEntries(lists.map((k) => [k, Object.freeze([...json[k]])])),
    newLinks: Object.freeze(json.newLinks.map((l) => Object.freeze({ item: l.item, category: l.category }))),
  });
}

function proposalOf(json) {
  const p = isObject(json) ? json.proposal : undefined;
  if (!isObject(p) || !isProposalId(p.id) || !whole(p.createdAt) || !whole(p.expiresAt) || !MODES.includes(p.mode) || typeof p.text !== 'string' || !Array.isArray(p.operations)) return undefined;
  if (!(p.rationale === undefined || typeof p.rationale === 'string')) return undefined;
  const summary = summaryOf(p.summary);
  if (summary === undefined) return undefined;
  const scope = p.scope === undefined ? undefined : provenanceOf(p.scope);
  if (p.scope !== undefined && scope === undefined) return undefined;
  const operations = [];
  for (const raw of p.operations) {
    const op = operationOf(raw);
    if (op === undefined) return undefined;
    operations.push(op);
  }
  return Object.freeze({ id: p.id, createdAt: p.createdAt, expiresAt: p.expiresAt, mode: p.mode, text: p.text, summary, operations: Object.freeze(operations), ...(p.rationale === undefined || p.rationale === '' ? {} : { rationale: p.rationale }), ...(scope === undefined ? {} : { scope }) });
}

function writtenOf(json) {
  const w = isObject(json) ? json.written : undefined;
  if (!isObject(w) || !isProposalId(w.id) || !whole(w.applied)) return undefined;
  const summary = summaryOf(w.summary);
  return summary === undefined ? undefined : Object.freeze({ id: w.id, applied: w.applied, summary });
}

const modeOf = (json) => (isObject(json) && MODES.includes(json.mode) ? Object.freeze({ mode: json.mode }) : undefined);

const itemOf = (raw) => {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || !isObject(raw.data) || !(raw.dataTruncated === undefined || raw.dataTruncated === true)) return undefined;
  return Object.freeze({ id: raw.id, data: Object.freeze({ ...raw.data }), ...(raw.dataTruncated === true ? { dataTruncated: true } : {}) });
};

export const pageOf = (itemParser, extra) => (json) => {
  if (!isObject(json) || !Array.isArray(json.items) || !(json.nextCursor === null || (typeof json.nextCursor === 'string' && CURSOR.test(json.nextCursor)))) return undefined;
  const items = [];
  for (const raw of json.items) {
    const item = itemParser(raw);
    if (item === undefined) return undefined;
    items.push(item);
  }
  const more = extra === undefined ? {} : extra(json);
  if (more === undefined) return undefined;
  return Object.freeze({ ...more, items: Object.freeze(items), nextCursor: json.nextCursor });
};

export const categoryOf = (raw) => {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || !optionalName(raw.name) || !whole(raw.itemCount) || !(raw.itemCountCapped === undefined || raw.itemCountCapped === true)) return undefined;
  return Object.freeze({ id: raw.id, ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}), itemCount: raw.itemCount, ...(raw.itemCountCapped === true ? { itemCountCapped: true } : {}) });
};

export const categoryItemsOf = pageOf(itemOf, (json) => {
  const c = json.category;
  if (!isObject(c) || typeof c.id !== 'string' || c.id === '' || !optionalName(c.name)) return undefined;
  return { category: Object.freeze({ id: c.id, ...(typeof c.name === 'string' && c.name !== '' ? { name: c.name } : {}) }) };
});

export function itemDetailOf(json) {
  if (!isObject(json) || !Array.isArray(json.categories) || !(json.moreCategories === undefined || json.moreCategories === true)) return undefined;
  const item = itemOf(json.item);
  if (item === undefined) return undefined;
  const categories = [];
  for (const c of json.categories) {
    if (!isObject(c) || typeof c.id !== 'string' || c.id === '' || !optionalName(c.name) || typeof c.weight !== 'number') return undefined;
    categories.push(Object.freeze({ id: c.id, ...(typeof c.name === 'string' && c.name !== '' ? { name: c.name } : {}), weight: c.weight }));
  }
  return Object.freeze({ item, categories: Object.freeze(categories), ...(json.moreCategories === true ? { moreCategories: true } : {}) });
}

/** What a refusal means for the call being made. `what` names what a 404 is about; `fields` the form fields a 422 may name. */
function errorFor(what, fields, status, json, retryAfter) {
  const error = isObject(json) && isObject(json.error) ? json.error : {};
  const seconds = parseRetryAfter(retryAfter);
  const wait = seconds === undefined ? {} : { retryAfterSeconds: seconds };
  if (status === 401) return { kind: 'signed-out', message: SIGNED_OUT };
  if (status === 404) {
    const circle = error.message === 'no such circle';
    return { kind: 'not-found', what: circle ? 'circle' : what, message: circle ? NO_CIRCLE : NOT_FOUND[what] };
  }
  if (status === 410) return { kind: 'expired', what: 'proposal', message: GONE_PROPOSAL };
  if (status === 409) return { kind: 'refused', message: cleanMessage(error.message, 'This proposal can no longer be applied.') };
  if (status === 422) {
    const named = typeof error.field === 'string' && error.field.startsWith('scope.') ? 'scope' : error.field;
    const field = fields.includes(named) ? named : undefined;
    return { kind: 'invalid', message: cleanMessage(error.message, 'Please check what you typed.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 429) return { kind: 'limit', message: cleanMessage(error.message, 'A limit has been reached. Try again later.'), ...wait };
  if (status === 502 || status === 503) {
    const reason = error.code === 'MODEL_TIMEOUT' ? 'timeout' : error.code === 'MODEL_REFUSED' ? 'refused' : error.code === 'MODEL_BUSY' ? 'busy' : 'error';
    return { kind: 'model', reason, message: cleanMessage(error.message, 'The model could not file this note: try again.'), ...wait };
  }
  return { kind: 'server', message: SERVER };
}

/** `?limit=&cursor=` from page options, or the problem with them. */
export function query(page, extra = []) {
  const parts = [...extra];
  if (page !== undefined) {
    if (!isObject(page)) return { problem: { kind: 'invalid', message: 'Please check what you asked for.' } };
    if (page.limit !== undefined) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) return { problem: { kind: 'invalid', field: 'limit', message: 'A page is 1 to 100 items.' } };
      parts.push(`limit=${page.limit}`);
    }
    if (page.cursor !== undefined && page.cursor !== null) {
      if (typeof page.cursor !== 'string' || !CURSOR.test(page.cursor)) return { problem: { kind: 'invalid', field: 'cursor', message: 'That page marker is not one the service gave.' } };
      parts.push(`cursor=${encodeURIComponent(page.cursor)}`);
    }
  }
  return { text: parts.length === 0 ? '' : `?${parts.join('&')}` };
}

/** A scoped answer: the shape of the plain one plus, when the service names a circle, where it came from. */
const scoped = (parse) => (json) => {
  const value = parse(json);
  if (value === undefined) return undefined;
  const holder = isObject(json) && isObject(json.summary) ? json.summary : json;
  if (!isObject(holder) || holder.scope === undefined) return value;
  const scope = provenanceOf(holder.scope);
  return scope === undefined ? undefined : Object.freeze({ ...value, scope });
};

const countsOf = (raw) => (isObject(raw) && whole(raw.itemCount) && whole(raw.categoryCount) && whole(raw.edgeCount) ? { itemCount: raw.itemCount, categoryCount: raw.categoryCount, edgeCount: raw.edgeCount } : undefined);
const summaryOnly = (json) => {
  const c = isObject(json) ? countsOf(json.summary) : undefined;
  return c === undefined ? undefined : Object.freeze(c);
};
const mineSummaryOf = (json) => {
  const s = isObject(json) ? json.summary : undefined;
  const total = countsOf(s);
  if (total === undefined || !Array.isArray(s.scopes)) return undefined;
  const rows = [];
  for (const raw of s.scopes) {
    const c = countsOf(raw);
    const scope = isObject(raw) ? provenanceOf(raw.scope) : undefined;
    if (c === undefined || scope === undefined) return undefined;
    rows.push(Object.freeze({ ...c, scope }));
  }
  return Object.freeze({ ...total, scopes: Object.freeze(rows) });
};
const scopeListOf = (json) => {
  if (!isObject(json) || !Array.isArray(json.items)) return undefined;
  const items = [];
  for (const raw of json.items) {
    const scope = isObject(raw) ? provenanceOf(raw.scope) : undefined;
    if (scope === undefined || typeof raw.canCapture !== 'boolean' || !(raw.role === undefined || ['owner', 'manager', 'member', 'observer'].includes(raw.role))) return undefined;
    items.push(Object.freeze({ scope, ...(raw.role === undefined ? {} : { role: raw.role }), canCapture: raw.canCapture }));
  }
  return Object.freeze({ items: Object.freeze(items) });
};
/** Rows of My Brain: the plain row and where it is. */
const tagged = (parse) => (raw) => {
  const value = parse(raw);
  const scope = isObject(raw) ? provenanceOf(raw.scope) : undefined;
  return value === undefined || scope === undefined ? undefined : Object.freeze({ ...value, scope });
};
const mineCategoryItemsOf = (json) => {
  const scope = isObject(json) ? provenanceOf(json.scope) : undefined;
  const plain = scope === undefined ? undefined : pageOf(tagged(itemOf), (j) => {
    const c = j.category;
    if (!isObject(c) || typeof c.id !== 'string' || c.id === '' || !optionalName(c.name)) return undefined;
    return { category: Object.freeze({ id: c.id, ...(typeof c.name === 'string' && c.name !== '' ? { name: c.name } : {}) }) };
  })(json);
  return plain === undefined ? undefined : Object.freeze({ ...plain, scope });
};
const mineItemOf = (json) => {
  const scope = isObject(json) ? provenanceOf(json.scope) : undefined;
  if (scope === undefined || !isObject(json.item) || !Array.isArray(json.categories) || !(json.moreCategories === undefined || json.moreCategories === true)) return undefined;
  const item = tagged(itemOf)(json.item);
  if (item === undefined) return undefined;
  const categories = [];
  for (const c of json.categories) {
    const tag = isObject(c) ? provenanceOf(c.scope) : undefined;
    if (!isObject(c) || tag === undefined || typeof c.id !== 'string' || c.id === '' || !optionalName(c.name) || typeof c.weight !== 'number') return undefined;
    categories.push(Object.freeze({ id: c.id, ...(typeof c.name === 'string' && c.name !== '' ? { name: c.name } : {}), weight: c.weight, scope: tag }));
  }
  return Object.freeze({ scope, item, categories: Object.freeze(categories), ...(json.moreCategories === true ? { moreCategories: true } : {}) });
};

const badScope = () => fail({ kind: 'invalid', field: 'scope', message: 'Choose your own notes or one of your circles.' });

export function createNotesClient({ fetchFn }) {
  const send = createRequester(fetchFn);

  /** `proposal` and `node` are `[id]` when the call takes one (so a missing id is a bad id, not no id). */
  async function call({ method, path, body, parse, what = 'proposal', fields = [], page, proposal, node, params = [] }) {
    const proposalId = proposal?.[0];
    if (proposal !== undefined && !isProposalId(proposalId)) return fail({ kind: 'not-found', what: 'proposal', message: NOT_FOUND.proposal });
    const extra = [...params];
    if (node !== undefined) {
      if (!isNodeId(node[0])) return fail({ kind: 'not-found', what, message: NOT_FOUND[what] });
      extra.push(`id=${encodeURIComponent(node[0])}`);
    }
    const q = query(page, extra);
    if (q.problem) return fail(q.problem);
    return send(method, `${path(proposalId)}${q.text}`, body, parse, (status, json, retryAfter) => errorFor(what, fields, status, json, retryAfter));
  }

  return Object.freeze({
    /** Which model files notes: `{ mode: 'demo' | 'anthropic' }`. */
    mode: () => call({ method: 'GET', path: () => '/api/capture/mode', parse: modeOf }),
    /** Asks the model how to file a note. The note is checked first: 1 to 8,000 characters after trimming. Nothing is written. */
    propose(text, scope) {
      const note = typeof text === 'string' ? text.trim() : '';
      if (note === '') return Promise.resolve(fail({ kind: 'invalid', field: 'text', message: 'Write a note first.' }));
      if ([...note].length > NOTE_MAX) return Promise.resolve(fail({ kind: 'invalid', field: 'text', message: `A note is at most 8,000 characters.` }));
      const target = proposeScope(scope);
      if (target === null) return Promise.resolve(badScope());
      return call({ method: 'POST', path: () => '/api/capture/propose', body: { text: note, ...(target === undefined ? {} : { scope: target }) }, parse: proposalOf, fields: ['text', 'scope'] });
    },
    getProposal: (id) => call({ method: 'GET', proposal: [id], path: (p) => `/api/capture/proposals/${p}`, parse: proposalOf }),
    approve: (id) => call({ method: 'POST', proposal: [id], path: (p) => `/api/capture/proposals/${p}/approve`, parse: writtenOf }),
    reject: (id) => call({ method: 'POST', proposal: [id], path: (p) => `/api/capture/proposals/${p}/reject`, parse: () => true }),
    categories: (page) => call({ method: 'GET', path: () => '/api/graph/categories', parse: pageOf(categoryOf), page, what: 'category', fields: ['limit', 'cursor'] }),
    categoryItems: (id, page) => call({ method: 'GET', path: () => '/api/graph/category', parse: categoryItemsOf, page, node: [id], what: 'category', fields: ['limit', 'cursor', 'id'] }),
    item: (id) => call({ method: 'GET', path: () => '/api/graph/item', parse: itemDetailOf, node: [id], what: 'item', fields: ['id'] }),

    // R-009: one scope (the own brain or one circle's), and My Brain
    /** The scopes this person may use: their own brain first, then each circle with their role and whether they may capture. */
    scopes: () => call({ method: 'GET', path: () => '/api/brain/scopes', parse: scopeListOf, what: 'circle', fields: ['scope'] }),
    summaryIn(scope) {
      const text = scopeText(scope);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain', parse: scoped(summaryOnly), params: [`scope=${text}`], what: 'circle', fields: ['scope'] });
    },
    categoriesIn(scope, page) {
      const text = scopeText(scope);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain/categories', parse: scoped(pageOf(categoryOf)), page, params: [`scope=${text}`], what: 'circle', fields: ['limit', 'cursor', 'scope'] });
    },
    categoryItemsIn(scope, id, page) {
      const text = scopeText(scope);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain/category', parse: scoped(categoryItemsOf), page, node: [id], params: [`scope=${text}`], what: 'category', fields: ['limit', 'cursor', 'id', 'scope'] });
    },
    itemIn(scope, id) {
      const text = scopeText(scope);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain/item', parse: scoped(itemDetailOf), node: [id], params: [`scope=${text}`], what: 'item', fields: ['id', 'scope'] });
    },
    mineSummary: () => call({ method: 'GET', path: () => '/api/brain', parse: mineSummaryOf, params: ['scope=mine'], what: 'circle', fields: ['scope'] }),
    mineCategories: (page) => call({ method: 'GET', path: () => '/api/brain/categories', parse: pageOf(tagged(categoryOf)), page, params: ['scope=mine'], what: 'circle', fields: ['limit', 'cursor', 'scope'] }),
    /** In My Brain a category is named by where it is (`source`: a scope) and its id. */
    mineCategoryItems(source, id, page) {
      const text = scopeText(source);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain/category', parse: mineCategoryItemsOf, page, node: [id], params: ['scope=mine', `source=${text}`], what: 'category', fields: ['limit', 'cursor', 'id', 'scope', 'source'] });
    },
    mineItem(source, id) {
      const text = scopeText(source);
      return text === undefined ? Promise.resolve(badScope()) : call({ method: 'GET', path: () => '/api/brain/item', parse: mineItemOf, node: [id], params: ['scope=mine', `source=${text}`], what: 'item', fields: ['id', 'scope', 'source'] });
    },
  });
}
