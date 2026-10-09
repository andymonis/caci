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
const NOT_FOUND = Object.freeze({ proposal: GONE_PROPOSAL, category: 'Not found: it may have been removed.', item: 'Not found: it may have been removed.' });
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
  const operations = [];
  for (const raw of p.operations) {
    const op = operationOf(raw);
    if (op === undefined) return undefined;
    operations.push(op);
  }
  return Object.freeze({ id: p.id, createdAt: p.createdAt, expiresAt: p.expiresAt, mode: p.mode, text: p.text, summary, operations: Object.freeze(operations), ...(p.rationale === undefined || p.rationale === '' ? {} : { rationale: p.rationale }) });
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

const pageOf = (itemParser, extra) => (json) => {
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

const categoryOf = (raw) => {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || !optionalName(raw.name) || !whole(raw.itemCount) || !(raw.itemCountCapped === undefined || raw.itemCountCapped === true)) return undefined;
  return Object.freeze({ id: raw.id, ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}), itemCount: raw.itemCount, ...(raw.itemCountCapped === true ? { itemCountCapped: true } : {}) });
};

const categoryItemsOf = pageOf(itemOf, (json) => {
  const c = json.category;
  if (!isObject(c) || typeof c.id !== 'string' || c.id === '' || !optionalName(c.name)) return undefined;
  return { category: Object.freeze({ id: c.id, ...(typeof c.name === 'string' && c.name !== '' ? { name: c.name } : {}) }) };
});

function itemDetailOf(json) {
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
  if (status === 404) return { kind: 'not-found', what, message: NOT_FOUND[what] };
  if (status === 410) return { kind: 'expired', what: 'proposal', message: GONE_PROPOSAL };
  if (status === 409) return { kind: 'refused', message: cleanMessage(error.message, 'This proposal can no longer be applied.') };
  if (status === 422) {
    const field = fields.includes(error.field) ? error.field : undefined;
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
function query(page, extra = []) {
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

export function createNotesClient({ fetchFn }) {
  const send = createRequester(fetchFn);

  /** `proposal` and `node` are `[id]` when the call takes one (so a missing id is a bad id, not no id). */
  async function call({ method, path, body, parse, what = 'proposal', fields = [], page, proposal, node }) {
    const proposalId = proposal?.[0];
    if (proposal !== undefined && !isProposalId(proposalId)) return fail({ kind: 'not-found', what: 'proposal', message: NOT_FOUND.proposal });
    const extra = [];
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
    propose(text) {
      const note = typeof text === 'string' ? text.trim() : '';
      if (note === '') return Promise.resolve(fail({ kind: 'invalid', field: 'text', message: 'Write a note first.' }));
      if ([...note].length > NOTE_MAX) return Promise.resolve(fail({ kind: 'invalid', field: 'text', message: `A note is at most 8,000 characters.` }));
      return call({ method: 'POST', path: () => '/api/capture/propose', body: { text: note }, parse: proposalOf, fields: ['text'] });
    },
    getProposal: (id) => call({ method: 'GET', proposal: [id], path: (p) => `/api/capture/proposals/${p}`, parse: proposalOf }),
    approve: (id) => call({ method: 'POST', proposal: [id], path: (p) => `/api/capture/proposals/${p}/approve`, parse: writtenOf }),
    reject: (id) => call({ method: 'POST', proposal: [id], path: (p) => `/api/capture/proposals/${p}/reject`, parse: () => true }),
    categories: (page) => call({ method: 'GET', path: () => '/api/graph/categories', parse: pageOf(categoryOf), page, what: 'category', fields: ['limit', 'cursor'] }),
    categoryItems: (id, page) => call({ method: 'GET', path: () => '/api/graph/category', parse: categoryItemsOf, page, node: [id], what: 'category', fields: ['limit', 'cursor', 'id'] }),
    item: (id) => call({ method: 'GET', path: () => '/api/graph/item', parse: itemDetailOf, node: [id], what: 'item', fields: ['id'] }),
  });
}
