import { describe, expect, it } from 'vitest';
import { createNotesClient, isCircleId, isNodeId, isProposalId, NOTE_MAX, provenanceOf, scopeText, STATUS_MAX } from './notes-client.js';

it('the note limit is 8,000 characters', () => expect(NOTE_MAX).toBe(8000));

const P = 'prop-0abc12345-00-abcdef';
const SUMMARY = { newItems: ['note-1'], updatedItems: [], newCategories: ['health'], updatedCategories: [], reusedCategories: ['people'], newLinks: [{ item: 'note-1', category: 'health' }], problems: [], notes: ['a note'] };
const OPS = [{ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'T', summary: 'S' } }, { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health' } }, { op: 'link', item: 'note-1', category: 'health', weight: 0.9 }];
const PROPOSAL = { id: P, createdAt: 10, expiresAt: 20, mode: 'demo', text: 'New items…', summary: SUMMARY, operations: OPS, rationale: 'because' };

function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createNotesClient({ fetchFn }) };
}
const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });

describe('the ids', () => {
  it('a proposal id has the shape the service makes and nothing else', () => {
    expect(isProposalId(P)).toBe(true);
    for (const bad of ['', 'prop-', 'prop-A', 'prop_x', 'x-prop-1', `${P}/x`, `${P}?x=1`, '../x', `${P} `, 'prop-' + 'a'.repeat(61), 5, null, undefined, {}]) expect(isProposalId(bad), String(bad)).toBe(false);
  });
  it('a category or item id is any non-empty text of at most 256 characters, not a lone surrogate', () => {
    for (const good of ['a', ' spaces ', 'Capitals', '<b>', 'a/b?c=d&e#f', '..', '😀', '日本語', 'x'.repeat(256)]) expect(isNodeId(good), good).toBe(true);
    for (const bad of ['', 'x'.repeat(257), String.fromCharCode(0xd800), 'a' + String.fromCharCode(0xdc00), 5, null, undefined, {}]) expect(isNodeId(bad), String(bad)).toBe(false);
    expect(isNodeId('😀'.repeat(256))).toBe(true);
    expect(isNodeId('😀'.repeat(257))).toBe(false);
  });
});

describe('what is sent', () => {
  it('each call goes to its route by path only, with the same settings as every other request', async () => {
    const { calls, client } = fake({ status: 200, body: { mode: 'demo', proposal: PROPOSAL, written: { id: P, applied: 3, summary: SUMMARY }, items: [], nextCursor: null, category: { id: 'c' }, item: { id: 'i', data: {} }, categories: [] } });
    await client.mode();
    await client.propose('a note');
    await client.getProposal(P);
    await client.approve(P);
    await client.reject(P);
    await client.categories();
    await client.categoryItems('health');
    await client.item('note-1');
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      'GET /api/capture/mode',
      'POST /api/capture/propose',
      `GET /api/capture/proposals/${P}`,
      `POST /api/capture/proposals/${P}/approve`,
      `POST /api/capture/proposals/${P}/reject`,
      'GET /api/graph/categories',
      'GET /api/graph/category?id=health',
      'GET /api/graph/item?id=note-1',
    ]);
    for (const c of calls) {
      expect(c.init.credentials).toBe('same-origin');
      expect(c.init.cache).toBe('no-store');
      expect(c.init.redirect).toBe('error');
      expect(Object.keys(c.init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    }
  });

  it('only a trimmed note is sent in propose, and nothing else', async () => {
    const { calls, client } = fake({ status: 201, body: { proposal: PROPOSAL } });
    await client.propose('  my note  ');
    expect(calls[0].body).toEqual({ text: 'my note' });
  });

  it('a note is checked first: blank, not text, or over 8,000 characters is refused naming text, and nothing is sent', async () => {
    const { calls, client } = fake({ status: 201, body: { proposal: PROPOSAL } });
    for (const bad of ['', '   ', '\n\t', undefined, null, 5, {}]) expect((await client.propose(bad)).error, String(bad)).toMatchObject({ kind: 'invalid', field: 'text' });
    const long = await client.propose('x'.repeat(8001));
    expect(long.error).toMatchObject({ kind: 'invalid', field: 'text', message: 'A note is at most 8,000 characters.' });
    expect((await client.propose('😀'.repeat(8000))).ok).toBe(true);
    expect((await client.propose('😀'.repeat(8001))).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a bad proposal id is "gone" and nothing is sent', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of ['', '../x', `${P}/approve`, 'prop-A', undefined, 5]) {
      for (const call of [client.getProposal, client.approve, client.reject]) expect((await call(bad)).error, String(bad)).toEqual({ kind: 'not-found', what: 'proposal', message: 'That proposal is gone or has expired. Make it again.' });
    }
    expect(calls).toHaveLength(0);
  });

  it('category and item ids go only in the query string, encoded; a bad one is "not found" and nothing is sent', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null, category: { id: 'x' }, item: { id: 'x', data: {} }, categories: [] } });
    const awkward = 'a/b?c=d&e#f %é😀<b>..';
    await client.categoryItems(awkward);
    await client.item(awkward);
    expect(calls[0].path).toBe(`/api/graph/category?id=${encodeURIComponent(awkward)}`);
    expect(calls[1].path).toBe(`/api/graph/item?id=${encodeURIComponent(awkward)}`);
    for (const c of calls) expect(new URL(c.path, 'http://x').searchParams.get('id')).toBe(awkward);
    const before = calls.length;
    for (const bad of ['', 'x'.repeat(257), String.fromCharCode(0xd800), undefined, 5]) {
      expect((await client.categoryItems(bad)).error).toMatchObject({ kind: 'not-found', what: 'category' });
      expect((await client.item(bad)).error).toEqual({ kind: 'not-found', what: 'item', message: 'Not found: it may have been removed.' });
    }
    expect(calls).toHaveLength(before);
  });

  it('limit and cursor go in the query string, only when given, and bad ones are refused naming the field', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null, category: { id: 'x' } } });
    await client.categories({ limit: 10, cursor: 'abc_-.~' });
    await client.categoryItems('c', { limit: 5 });
    expect(calls[0].path).toBe('/api/graph/categories?limit=10&cursor=abc_-.~');
    expect(calls[1].path).toBe('/api/graph/category?id=c&limit=5');
    for (const page of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }]) expect((await client.categories(page)).error).toMatchObject({ kind: 'invalid', field: 'limit' });
    for (const page of [{ cursor: '' }, { cursor: 'a b' }, { cursor: 'a&b=c' }, { cursor: 5 }, { cursor: 'x'.repeat(2049) }]) expect((await client.categories(page)).error, JSON.stringify(page).slice(0, 30)).toMatchObject({ kind: 'invalid', field: 'cursor' });
    expect((await client.categories(5)).error.kind).toBe('invalid');
    expect(calls).toHaveLength(2);
  });

  it('calls without a body send none, and no content type', async () => {
    const { calls, client } = fake({ status: 200, body: { mode: 'demo' } });
    await client.mode();
    expect(calls[0].init.body).toBeUndefined();
    expect(Object.keys(calls[0].init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });
});

describe('what comes back', () => {
  it('the mode is demo or anthropic and nothing else is kept', async () => {
    for (const mode of ['demo', 'anthropic']) expect((await fake({ status: 200, body: { mode, extra: 1 } }).client.mode()).value).toEqual({ mode });
    for (const body of [{ mode: 'other' }, { mode: 5 }, {}, { mode: 'DEMO' }]) expect((await fake({ status: 200, body }).client.mode()).error.kind, JSON.stringify(body)).toBe('server');
  });

  it('a proposal keeps only its own fields, frozen, with the rationale only when there is one', async () => {
    const { client } = fake({ status: 201, body: { proposal: { ...PROPOSAL, graphId: 'user-u1', usage: { inputTokens: 5 }, model: 'x', systemPrompt: 'y', operations: [{ ...OPS[0], extra: 1 }, OPS[1], OPS[2]] } } });
    const r = await client.propose('a note');
    expect(Object.keys(r.value).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'mode', 'operations', 'rationale', 'summary', 'text']);
    expect(r.value.operations[0]).toEqual({ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'T', summary: 'S' } });
    expect(r.value.operations[2]).toEqual({ op: 'link', item: 'note-1', category: 'health', weight: 0.9 });
    expect(r.value.summary.newLinks).toEqual([{ item: 'note-1', category: 'health' }]);
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.summary) && Object.isFrozen(r.value.operations) && Object.isFrozen(r.value.operations[0]) && Object.isFrozen(r.value.operations[0].data) && Object.isFrozen(r.value.summary.newItems)).toBe(true);
    const none = await fake({ status: 201, body: { proposal: { ...PROPOSAL, rationale: undefined } } }).client.propose('x');
    expect('rationale' in none.value).toBe(false);
    const empty = await fake({ status: 201, body: { proposal: { ...PROPOSAL, rationale: '' } } }).client.propose('x');
    expect('rationale' in empty.value).toBe(false);
  });

  it('an answer that is not shaped right is a server problem, never a crash', async () => {
    const bad = [
      {}, { proposal: null }, { proposal: { ...PROPOSAL, id: 'nope' } }, { proposal: { ...PROPOSAL, mode: 'x' } }, { proposal: { ...PROPOSAL, createdAt: -1 } }, { proposal: { ...PROPOSAL, expiresAt: 1.5 } },
      { proposal: { ...PROPOSAL, text: 5 } }, { proposal: { ...PROPOSAL, rationale: 5 } }, { proposal: { ...PROPOSAL, operations: 'x' } }, { proposal: { ...PROPOSAL, operations: [{ op: 'deleteNode', id: 'x' }] } },
      { proposal: { ...PROPOSAL, operations: [{ op: 'upsertNode', partition: 'other', id: 'x' }] } }, { proposal: { ...PROPOSAL, operations: [{ op: 'link', item: 'a' }] } }, { proposal: { ...PROPOSAL, operations: [{ op: 'link', item: 'a', category: 'b', weight: '1' }] } },
      { proposal: { ...PROPOSAL, summary: null } }, { proposal: { ...PROPOSAL, summary: { ...SUMMARY, newItems: [1] } } }, { proposal: { ...PROPOSAL, summary: { ...SUMMARY, newLinks: [{ item: 'a' }] } } }, { proposal: { ...PROPOSAL, summary: { ...SUMMARY, notes: undefined } } },
    ];
    for (const body of bad) expect((await fake({ status: 201, body }).client.propose('a note')).error?.kind, JSON.stringify(body).slice(0, 60)).toBe('server');
    expect((await fake({ status: 200, raw: 'not json' }).client.mode()).error.kind).toBe('server');
    expect((await fake({ status: 200, raw: '' }).client.mode()).error.kind).toBe('server');
  });

  it('approve gives which proposal, how many operations were written and what they were', async () => {
    const { client } = fake({ status: 200, body: { written: { id: P, applied: 3, summary: SUMMARY, graphId: 'user-u1' } } });
    const r = await client.approve(P);
    expect(r.value).toEqual({ id: P, applied: 3, summary: { ...SUMMARY, facts: [], removed: [] }, tidied: [] });
    for (const body of [{}, { written: { id: P, applied: -1, summary: SUMMARY } }, { written: { id: 'x', applied: 1, summary: SUMMARY } }, { written: { id: P, applied: 1, summary: {} } }]) expect((await fake({ status: 200, body }).client.approve(P)).error.kind).toBe('server');
  });

  it('a replacement: deleteNode operations, the notes removed and the categories tidied are kept, cut down and frozen (R-014)', async () => {
    const removed = [{ id: 'note-0', title: 'Tablet A 2 x daily', summary: 'twice', extra: 'x' }];
    const ops = [{ op: 'deleteNode', partition: 'item', id: 'note-0', junk: 1 }, ...PROPOSAL.operations];
    const r = await fake({ status: 201, body: { proposal: { ...PROPOSAL, operations: ops, summary: { ...SUMMARY, removed } } } }).client.propose('x');
    expect(r.value.operations[0]).toEqual({ op: 'deleteNode', partition: 'item', id: 'note-0' });
    expect(r.value.summary.removed).toEqual([{ id: 'note-0', title: 'Tablet A 2 x daily', summary: 'twice' }]);
    expect(Object.isFrozen(r.value.summary.removed) && Object.isFrozen(r.value.summary.removed[0]) && Object.isFrozen(r.value.operations[0])).toBe(true);
    expect((await fake({ status: 201, body: { proposal: PROPOSAL } }).client.propose('x')).value.summary.removed).toEqual([]);
    const a = await fake({ status: 200, body: { written: { id: P, applied: 4, summary: SUMMARY, tidied: [{ id: 'old', name: 'Old', x: 1 }, { id: 'bare' }] } } }).client.approve(P);
    expect(a.value.tidied).toEqual([{ id: 'old', name: 'Old' }, { id: 'bare' }]);
    expect(Object.isFrozen(a.value.tidied) && Object.isFrozen(a.value.tidied[0])).toBe(true);
    for (const bad of [{ ...SUMMARY, removed: 'x' }, { ...SUMMARY, removed: [{ id: 'a', title: 'T' }] }, { ...SUMMARY, removed: [null] }]) expect((await fake({ status: 201, body: { proposal: { ...PROPOSAL, summary: bad } } }).client.propose('x')).error.kind).toBe('server');
    for (const tidied of ['x', [{ name: 'n' }], [{ id: 'a', name: 5 }]]) expect((await fake({ status: 200, body: { written: { id: P, applied: 1, summary: SUMMARY, tidied } } }).client.approve(P)).error.kind).toBe('server');
    expect((await fake({ status: 200, body: { written: { id: P, applied: 1, summary: SUMMARY } } }).client.approve(P)).value.tidied).toEqual([]);
    expect((await fake({ status: 201, body: { proposal: { ...PROPOSAL, operations: [{ op: 'deleteNode', partition: 'other', id: 'x' }] } } }).client.propose('x')).error.kind).toBe('server');
  });

  it('facts (R-015): the new items with title and summary are kept, cut down and frozen; absent means none; a bad one is a server problem', async () => {
    const facts = [{ id: 'note-1', title: 'Mum: phone', summary: '0770', key: 'x', junk: 1 }, { id: 'note-1-2', title: 'Mum: email', summary: 'a@b.c' }];
    const r = await fake({ status: 201, body: { proposal: { ...PROPOSAL, summary: { ...SUMMARY, facts } } } }).client.propose('x');
    expect(r.value.summary.facts).toEqual([{ id: 'note-1', title: 'Mum: phone', summary: '0770' }, { id: 'note-1-2', title: 'Mum: email', summary: 'a@b.c' }]);
    expect(Object.isFrozen(r.value.summary.facts) && Object.isFrozen(r.value.summary.facts[0])).toBe(true);
    expect((await fake({ status: 201, body: { proposal: PROPOSAL } }).client.propose('x')).value.summary.facts).toEqual([]);
    for (const bad of ['x', [null], [{ id: 'a', title: 'T' }], [{ id: 5, title: 'T', summary: 'S' }], [{ id: 'a', title: 5, summary: 'S' }]]) {
      expect((await fake({ status: 201, body: { proposal: { ...PROPOSAL, summary: { ...SUMMARY, facts: bad } } } }).client.propose('x')).error.kind, JSON.stringify(bad)).toBe('server');
    }
  });

  it('reject is true on 204', async () => {
    expect(await fake({ status: 204 }).client.reject(P)).toEqual({ ok: true, value: true });
  });

  it('categories: id, name when there is one, count, capped only when true; a page is frozen with its cursor', async () => {
    const { client } = fake({ status: 200, body: { items: [{ id: 'a', name: 'Health', itemCount: 3 }, { id: 'b', itemCount: 9999, itemCountCapped: true }, { id: 'c', name: '', itemCount: 0 }], nextCursor: 'abc' } });
    const r = await client.categories();
    expect(r.value.items).toEqual([{ id: 'a', name: 'Health', itemCount: 3 }, { id: 'b', itemCount: 9999, itemCountCapped: true }, { id: 'c', itemCount: 0 }]);
    expect(r.value.nextCursor).toBe('abc');
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.items) && Object.isFrozen(r.value.items[0])).toBe(true);
    const withData = await fake({ status: 200, body: { category: { id: 'a' }, items: [{ id: 'i', data: { t: 1 } }], nextCursor: null } }).client.categoryItems('a');
    expect(Object.isFrozen(withData.value.items[0]) && Object.isFrozen(withData.value.items[0].data)).toBe(true);
    for (const body of [{ items: [{ id: 'a' }], nextCursor: null }, { items: [{ id: '', itemCount: 1 }], nextCursor: null }, { items: [{ id: 'a', itemCount: -1 }], nextCursor: null }, { items: [{ id: 'a', itemCount: 1, itemCountCapped: false }], nextCursor: null }, { items: [], nextCursor: '' }, { items: [], nextCursor: 'a b' }, { items: [], nextCursor: 5 }, { items: 'x', nextCursor: null }, {}]) {
      expect((await fake({ status: 200, body }).client.categories()).error?.kind, JSON.stringify(body)).toBe('server');
    }
  });

  it('a category\'s items: the category, each item\'s id and data, marked when shortened', async () => {
    const { client } = fake({ status: 200, body: { category: { id: 'a', name: 'Health', x: 1 }, items: [{ id: 'i1', data: { title: 'T' } }, { id: 'i2', data: {}, dataTruncated: true }], nextCursor: null } });
    const r = await client.categoryItems('a');
    expect(r.value.category).toEqual({ id: 'a', name: 'Health' });
    expect(r.value.items).toEqual([{ id: 'i1', data: { title: 'T' } }, { id: 'i2', data: {}, dataTruncated: true }]);
    for (const body of [{ category: null, items: [], nextCursor: null }, { category: { id: '' }, items: [], nextCursor: null }, { category: { id: 'a' }, items: [{ id: 'i', data: [] }], nextCursor: null }, { category: { id: 'a' }, items: [{ id: 'i', data: {}, dataTruncated: false }], nextCursor: null }]) {
      expect((await fake({ status: 200, body }).client.categoryItems('a')).error?.kind, JSON.stringify(body)).toBe('server');
    }
  });

  it('one item: its data, its categories with weights, and the "more" flag only when true', async () => {
    const { client } = fake({ status: 200, body: { item: { id: 'i', data: { title: 'T' } }, categories: [{ id: 'a', name: 'Health', weight: 0.9 }, { id: 'b', weight: 1 }], moreCategories: true, graphId: 'user-u1' } });
    const r = await client.item('i');
    expect(r.value).toEqual({ item: { id: 'i', data: { title: 'T' } }, categories: [{ id: 'a', name: 'Health', weight: 0.9 }, { id: 'b', weight: 1 }], moreCategories: true });
    for (const body of [{ item: null, categories: [] }, { item: { id: 'i', data: {} }, categories: [{ id: 'a' }] }, { item: { id: 'i', data: {} }, categories: [{ id: 'a', weight: '1' }] }, { item: { id: 'i', data: {} }, categories: [], moreCategories: false }, { item: { id: 'i', data: {} } }]) {
      expect((await fake({ status: 200, body }).client.item('i')).error?.kind, JSON.stringify(body)).toBe('server');
    }
    expect('moreCategories' in (await fake({ status: 200, body: { item: { id: 'i', data: {} }, categories: [] } }).client.item('i')).value).toBe(false);
  });
});

describe('refusals', () => {
  it('401 is signed-out on every call', async () => {
    const { client } = fake(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' }));
    for (const r of [await client.mode(), await client.propose('x'), await client.getProposal(P), await client.approve(P), await client.reject(P), await client.categories(), await client.categoryItems('c'), await client.item('i')]) {
      expect(r.error).toEqual({ kind: 'signed-out', message: 'Your session has ended. Sign in again.' });
    }
  });

  it('404 says what was not found, in our words, and 410 is an expired proposal', async () => {
    const nf = fake(err(404, { code: 'NOT_FOUND', message: 'provider detail' }));
    expect((await nf.client.getProposal(P)).error).toEqual({ kind: 'not-found', what: 'proposal', message: 'That proposal is gone or has expired. Make it again.' });
    expect((await nf.client.categoryItems('c')).error).toEqual({ kind: 'not-found', what: 'category', message: 'Not found: it may have been removed.' });
    expect((await nf.client.item('i')).error).toEqual({ kind: 'not-found', what: 'item', message: 'Not found: it may have been removed.' });
    const gone = fake(err(410, { code: 'EXPIRED', message: 'that proposal has expired: make it again' }));
    for (const r of [await gone.client.getProposal(P), await gone.client.approve(P), await gone.client.reject(P)]) expect(r.error).toEqual({ kind: 'expired', what: 'proposal', message: 'That proposal is gone or has expired. Make it again.' });
  });

  it('409 on approve is a refused write, in the service\'s words, cleaned', async () => {
    const { client } = fake(err(409, { code: 'WRITE_REFUSED', message: 'this proposal can no longer be applied: it would not fit your notes as they are now\n<b>x</b>' }));
    const r = await client.approve(P);
    expect(r.error.kind).toBe('refused');
    expect(r.error.message).toBe('this proposal can no longer be applied: it would not fit your notes as they are now <b>x</b>');
    expect((await fake(err(409, {})).client.approve(P)).error.message).toBe('This proposal can no longer be applied.');
  });

  it('422 shows the message and names the field only when the call has that field', async () => {
    const { client } = fake(err(422, { code: 'INVALID_INPUT', message: 'the note could not be used', field: 'text' }));
    expect((await client.propose('x')).error).toEqual({ kind: 'invalid', message: 'the note could not be used', field: 'text' });
    const odd = fake(err(422, { code: 'INVALID_INPUT', message: 'x', field: 'graphId' }));
    expect((await odd.client.propose('x')).error).toEqual({ kind: 'invalid', message: 'x' });
    const lim = fake(err(422, { code: 'INVALID_INPUT', message: 'limit must be 1 to 100', field: 'limit' }));
    expect((await lim.client.categories()).error).toMatchObject({ kind: 'invalid', field: 'limit' });
    expect((await lim.client.propose('x')).error.field).toBeUndefined(); // propose has no limit field
  });

  it('429 is a limit in the service\'s words, with the wait when it says one', async () => {
    const { client } = fake(err(429, { code: 'THROTTLED', message: 'you have made the most proposals allowed in an hour' }, { 'retry-after': '1800' }));
    expect((await client.propose('x')).error).toEqual({ kind: 'limit', message: 'you have made the most proposals allowed in an hour', retryAfterSeconds: 1800 });
    const none = fake(err(429, { code: 'TOO_MANY_PENDING', message: 'you have too many proposals waiting: approve or reject one first' }));
    expect((await none.client.propose('x')).error).toEqual({ kind: 'limit', message: 'you have too many proposals waiting: approve or reject one first' });
    expect((await fake(err(429, {}, { 'retry-after': 'soon' })).client.propose('x')).error).toEqual({ kind: 'limit', message: 'A limit has been reached. Try again later.' });
  });

  it('the model\'s failures are kind model with a reason and the service\'s fixed words', async () => {
    const cases = [
      [502, 'MODEL_TIMEOUT', 'the model took too long: try again', 'timeout'],
      [502, 'MODEL_REFUSED', 'the model declined to file this note', 'refused'],
      [502, 'MODEL_ERROR', 'the model could not file this note: try again', 'error'],
      [503, 'MODEL_BUSY', 'the model is busy: try again shortly', 'busy'],
    ];
    for (const [status, code, message, reason] of cases) {
      const r = await fake(err(status, { code, message }, status === 503 ? { 'retry-after': '30' } : undefined)).client.propose('x');
      expect(r.error, code).toEqual({ kind: 'model', reason, message, ...(status === 503 ? { retryAfterSeconds: 30 } : {}) });
    }
    expect((await fake(err(502, { code: 'WHATEVER', message: '' })).client.propose('x')).error).toMatchObject({ kind: 'model', reason: 'error', message: 'The model could not file this note: try again.' });
  });

  it('anything else, an unreachable service and a broken answer are server or network, with nothing from inside', async () => {
    const r = await fake(err(500, { code: 'INTERNAL_ERROR', message: 'internal error at /var/x' })).client.mode();
    expect(r.error.kind).toBe('server');
    expect(JSON.stringify(r.error)).not.toContain('/var/x');
    expect((await fake(new TypeError('Failed to fetch')).client.mode()).error.kind).toBe('network');
    expect((await fake(err(418, {})).client.mode()).error.kind).toBe('server');
  });

  it('the service\'s words are cleaned: controls become spaces, long text is cut, markup stays text', async () => {
    const r = await fake(err(429, { code: 'THROTTLED', message: `a${String.fromCharCode(7)}b${String.fromCharCode(0x2028)}c ${'x'.repeat(400)}` })).client.propose('x');
    expect(r.error.message.startsWith('a b c ')).toBe(true);
    expect(r.error.message.length).toBeLessThanOrEqual(300);
  });

  it('never throws, whatever fetch gives back; errors are frozen; a client needs a fetch', async () => {
    for (const answer of [undefined, null, 5, {}, { status: 'x' }]) {
      const client = createNotesClient({ fetchFn: async () => answer });
      await expect(client.mode()).resolves.toMatchObject({ ok: false });
    }
    expect(Object.isFrozen((await fake(err(401, {})).client.mode()).error)).toBe(true);
    expect(() => createNotesClient({})).toThrow(TypeError);
  });
});

// R-009: scopes and My Brain
const CIRCLE = 'c0123456789abcdef';
const CIRCLE2 = 'cabcdefghij012345';
const ME = { kind: 'personal' };
const IN1 = { kind: 'circle', circleId: CIRCLE, circleName: 'Parent' };
const IN2 = { kind: 'circle', circleId: CIRCLE2, circleName: 'In-law' };
const CAT = { id: 'shared', name: 'Shared', itemCount: 2 };
const ITEM = { id: 'i1', data: { title: 'T' } };

describe('which scope, and how it is written', () => {
  it('a circle id has the shape the service makes', () => {
    expect(isCircleId(CIRCLE)).toBe(true);
    for (const bad of ['', 'c', 'C0123456789abcdef', 'c0123456789abcde', 'c0123456789abcdef0', 'u0123456789abcdef', 'c0123456789abcd/f', '../x', 5, null, undefined]) expect(isCircleId(bad), String(bad)).toBe(false);
  });
  it('provenance is personal, or a circle with an id and a name, and nothing else', () => {
    expect(provenanceOf(ME)).toEqual(ME);
    expect(provenanceOf(IN1)).toEqual(IN1);
    expect(Object.isFrozen(provenanceOf(IN1))).toBe(true);
    expect(provenanceOf({ ...IN1, extra: 1 })).toEqual(IN1); // only its own fields are kept
    for (const bad of [undefined, null, 'personal', {}, { kind: 'circle' }, { kind: 'circle', circleId: 'x', circleName: 'N' }, { kind: 'circle', circleId: CIRCLE }, { kind: 'circle', circleId: CIRCLE, circleName: 5 }, { kind: 'other' }]) expect(provenanceOf(bad), JSON.stringify(bad)).toBeUndefined();
  });
  it('a scope is written personal, circle:<id> or mine, and only where mine is allowed', () => {
    expect(scopeText(undefined)).toBe('personal');
    expect(scopeText(ME)).toBe('personal');
    expect(scopeText(IN1)).toBe(`circle:${CIRCLE}`); // the name a scope was shown with is allowed and is never sent
    expect(scopeText({ kind: 'circle', circleId: CIRCLE })).toBe(`circle:${CIRCLE}`);
    expect(scopeText('mine')).toBeUndefined();
    expect(scopeText('mine', true)).toBe('mine');
    for (const bad of [null, 'personal', 'circle', {}, { kind: 'circle' }, { kind: 'circle', circleId: 'x' }, { kind: 'personal', extra: 1 }, { kind: 'circle', circleId: CIRCLE, graphId: 'x' }, 5, []]) expect(scopeText(bad, true), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('capturing into a scope', () => {
  it('a circle scope is sent with the note; the personal scope and no scope send the note alone', async () => {
    const { calls, client } = fake({ status: 201, body: { proposal: { ...PROPOSAL, scope: IN1 } } });
    const r = await client.propose('a note', { kind: 'circle', circleId: CIRCLE });
    expect(calls[0].body).toEqual({ text: 'a note', scope: { kind: 'circle', circleId: CIRCLE } });
    expect(r.ok && r.value.scope).toEqual(IN1);
    await client.propose('a note', ME);
    await client.propose('a note');
    expect(calls[1].body).toEqual({ text: 'a note' });
    expect(calls[2].body).toEqual({ text: 'a note' });
    expect('scope' in fake({ status: 201, body: { proposal: PROPOSAL } }).client).toBe(false);
  });

  it('only the circle id is sent, whatever else the scope carried; a bad scope is refused before sending', async () => {
    const { calls, client } = fake({ status: 201, body: { proposal: PROPOSAL } });
    for (const bad of ['mine', 'circle', { kind: 'circle', circleId: 'x' }, { kind: 'circle', circleId: CIRCLE, graphId: 'user-u1' }, { kind: 'other' }, null, 5]) {
      expect(await client.propose('a note', bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'scope' } });
    }
    expect(calls).toHaveLength(0);
    await client.propose('x', { kind: 'circle', circleId: CIRCLE });
    expect(Object.keys(calls[0].body.scope).sort()).toEqual(['circleId', 'kind']);
    await client.propose('x', IN1); // a scope as it was shown, with its name
    expect(calls[1].body.scope).toEqual({ kind: 'circle', circleId: CIRCLE });
  });

  it('a proposal without a scope has none; one with a malformed scope is a server problem', async () => {
    const plain = await fake({ status: 201, body: { proposal: PROPOSAL } }).client.propose('x');
    expect(plain.ok && 'scope' in plain.value).toBe(false);
    for (const scope of [{ kind: 'circle' }, 'circle', { kind: 'circle', circleId: 'x', circleName: 'N' }]) {
      expect(await fake({ status: 201, body: { proposal: { ...PROPOSAL, scope } } }).client.propose('x')).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });

  it('the service\'s refusals: no such circle in our words, a malformed scope naming scope', async () => {
    const gone = await fake(err(404, { code: 'NOT_FOUND', message: 'no such circle' })).client.propose('x', { kind: 'circle', circleId: CIRCLE });
    expect(gone.error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    const field = await fake(err(422, { code: 'INVALID_INPUT', message: 'x', field: 'scope.circleId' })).client.propose('x', { kind: 'circle', circleId: CIRCLE });
    expect(field.error).toMatchObject({ kind: 'invalid', field: 'scope' });
    const text = await fake(err(422, { code: 'INVALID_INPUT', message: 'x', field: 'text' })).client.propose('x');
    expect(text.error.field).toBe('text');
  });
});

describe('browsing one scope', () => {
  it('goes to the brain routes with the scope in the query, and the plain answers still have no scope', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [CAT], nextCursor: null, category: { id: 'shared' }, item: ITEM, categories: [], summary: { itemCount: 1, categoryCount: 2, edgeCount: 3 } } });
    await client.summaryIn(ME);
    await client.categoriesIn(IN1, { limit: 5, cursor: 'sAbC' });
    await client.categoryItemsIn({ kind: 'circle', circleId: CIRCLE }, 'a b/c', { limit: 2 });
    await client.itemIn(undefined, 'i1');
    expect(calls.map((c) => c.path)).toEqual(['/api/brain?scope=personal', `/api/brain/categories?scope=circle:${CIRCLE}&limit=5&cursor=sAbC`, `/api/brain/category?scope=circle:${CIRCLE}&id=a%20b%2Fc&limit=2`, '/api/brain/item?scope=personal&id=i1']);
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true);
  });

  it('a circle answer carries where it came from, and the plain one does not', async () => {
    const withScope = fake({ status: 200, body: { items: [CAT], nextCursor: null, scope: IN1 } });
    const a = await withScope.client.categoriesIn(IN1);
    expect(a.value).toEqual({ items: [CAT], nextCursor: null, scope: IN1 });
    const without = await fake({ status: 200, body: { items: [CAT], nextCursor: null } }).client.categoriesIn(ME);
    expect('scope' in without.value).toBe(false);
    const sum = await fake({ status: 200, body: { summary: { itemCount: 1, categoryCount: 2, edgeCount: 3, scope: IN1 } } }).client.summaryIn(IN1);
    expect(sum.value).toEqual({ itemCount: 1, categoryCount: 2, edgeCount: 3, scope: IN1 });
    const items = await fake({ status: 200, body: { category: { id: 'shared' }, items: [ITEM], nextCursor: null, scope: IN1 } }).client.categoryItemsIn(IN1, 'shared');
    expect(items.value.scope).toEqual(IN1);
    const detail = await fake({ status: 200, body: { item: ITEM, categories: [{ id: 'shared', weight: 1 }], scope: IN1 } }).client.itemIn(IN1, 'i1');
    expect(detail.value.scope).toEqual(IN1);
    expect(await fake({ status: 200, body: { items: [CAT], nextCursor: null, scope: { kind: 'circle' } } }).client.categoriesIn(IN1)).toMatchObject({ ok: false, error: { kind: 'server' } });
  });

  it('refuses mine here, bad scopes, and bad ids, before sending', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of ['mine', { kind: 'circle', circleId: 'x' }, null]) {
      for (const run of [() => client.summaryIn(bad), () => client.categoriesIn(bad), () => client.categoryItemsIn(bad, 'x'), () => client.itemIn(bad, 'x')]) expect(await run(), JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'scope' } });
    }
    expect(await client.categoryItemsIn(IN1, '')).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'category' } });
    expect(await client.itemIn(IN1, 'x'.repeat(257))).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'item' } });
    expect(calls).toHaveLength(0);
  });

  it('the service\'s 404s: a missing circle in our words, a missing category or item as before', async () => {
    const c = fake(err(404, { code: 'NOT_FOUND', message: 'no such circle' })).client;
    expect((await c.categoriesIn(IN1)).error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    const k = fake(err(404, { code: 'NOT_FOUND', message: 'no such category' })).client;
    expect((await k.categoryItemsIn(IN1, 'x')).error).toMatchObject({ kind: 'not-found', what: 'category', message: 'Not found: it may have been removed.' });
    expect((await fake(err(404, { code: 'NOT_FOUND', message: 'no such item' })).client.itemIn(IN1, 'x')).error).toMatchObject({ what: 'item' });
  });
});

describe('the scopes a person may use', () => {
  it('lists them with roles and whether they may capture', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [{ scope: ME, canCapture: true }, { scope: IN1, role: 'observer', canCapture: false }] } });
    const r = await client.scopes();
    expect(calls[0].path).toBe('/api/brain/scopes');
    expect(r.value).toEqual({ items: [{ scope: ME, canCapture: true }, { scope: IN1, role: 'observer', canCapture: false }] });
    expect(Object.isFrozen(r.value.items[1])).toBe(true);
  });
  it('a list that is not shaped right is a server problem', async () => {
    for (const items of [[{ scope: ME }], [{ scope: ME, canCapture: 'yes' }], [{ scope: { kind: 'circle' }, canCapture: true }], [{ scope: ME, canCapture: true, role: 'boss' }], 'x']) {
      expect(await fake({ status: 200, body: { items } }).client.scopes(), JSON.stringify(items)).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });
  it('too many circles is the service\'s own words, on scope', async () => {
    const r = await fake(err(422, { code: 'INVALID_INPUT', message: 'you are in more circles than can be combined in one view (at most 24): choose one circle', field: 'scope' })).client.scopes();
    expect(r.error).toMatchObject({ kind: 'invalid', field: 'scope', message: expect.stringContaining('choose one circle') });
  });
});

describe('My Brain', () => {
  it('the summary: totals and each scope on its own', async () => {
    const { calls, client } = fake({ status: 200, body: { summary: { itemCount: 3, categoryCount: 4, edgeCount: 5, scopes: [{ itemCount: 1, categoryCount: 2, edgeCount: 3, scope: ME }, { itemCount: 2, categoryCount: 2, edgeCount: 2, scope: IN1 }] } } });
    const r = await client.mineSummary();
    expect(calls[0].path).toBe('/api/brain?scope=mine');
    expect(r.value).toEqual({ itemCount: 3, categoryCount: 4, edgeCount: 5, scopes: [{ itemCount: 1, categoryCount: 2, edgeCount: 3, scope: ME }, { itemCount: 2, categoryCount: 2, edgeCount: 2, scope: IN1 }] });
    for (const summary of [{ itemCount: 1 }, { itemCount: 1, categoryCount: 1, edgeCount: 1, scopes: [{ itemCount: 1, categoryCount: 1, edgeCount: 1 }] }, { itemCount: 1, categoryCount: 1, edgeCount: 1, scopes: 'x' }]) {
      expect(await fake({ status: 200, body: { summary } }).client.mineSummary()).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });

  it('categories come with the scope of each, in the order given, and page', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [{ ...CAT, scope: ME }, { ...CAT, scope: IN1 }, { ...CAT, scope: IN2 }], nextCursor: 'sNext' } });
    const r = await client.mineCategories({ limit: 3, cursor: 'sPrev' });
    expect(calls[0].path).toBe('/api/brain/categories?scope=mine&limit=3&cursor=sPrev');
    expect(r.value.items.map((c) => [c.id, c.scope.kind, c.scope.circleName])).toEqual([['shared', 'personal', undefined], ['shared', 'circle', 'Parent'], ['shared', 'circle', 'In-law']]);
    expect(r.value.nextCursor).toBe('sNext');
    expect(await fake({ status: 200, body: { items: [CAT], nextCursor: null } }).client.mineCategories()).toMatchObject({ ok: false, error: { kind: 'server' } });
  });

  it('a category or an item is named by its source and its id, both in the query', async () => {
    const items = fake({ status: 200, body: { scope: IN1, category: { id: 'shared', name: 'Shared' }, items: [{ ...ITEM, scope: IN1 }], nextCursor: null } });
    const a = await items.client.mineCategoryItems({ kind: 'circle', circleId: CIRCLE }, 'a b', { limit: 4 });
    expect(items.calls[0].path).toBe(`/api/brain/category?scope=mine&source=circle:${CIRCLE}&id=a%20b&limit=4`);
    expect(a.value.items[0].scope).toEqual(IN1);
    expect(a.value.scope).toEqual(IN1);
    const detail = fake({ status: 200, body: { scope: ME, item: { ...ITEM, scope: ME }, categories: [{ id: 'shared', weight: 1, scope: ME }] } });
    const d = await detail.client.mineItem(ME, 'i1');
    expect(detail.calls[0].path).toBe('/api/brain/item?scope=mine&source=personal&id=i1');
    expect(d.value.categories[0].scope).toEqual(ME);
    expect(d.value.item.scope).toEqual(ME);
  });

  it('rows without a scope are a server problem, and a bad source or id is refused before sending', async () => {
    expect(await fake({ status: 200, body: { scope: IN1, category: { id: 'x' }, items: [ITEM], nextCursor: null } }).client.mineCategoryItems(IN1, 'x')).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(await fake({ status: 200, body: { item: { ...ITEM, scope: ME }, categories: [], scope: ME } }).client.mineItem(ME, 'x')).toMatchObject({ ok: true });
    expect(await fake({ status: 200, body: { scope: ME, item: ITEM, categories: [] } }).client.mineItem(ME, 'x')).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(await fake({ status: 200, body: { scope: ME, item: { ...ITEM, scope: ME }, categories: [{ id: 'c', weight: 1 }] } }).client.mineItem(ME, 'x')).toMatchObject({ ok: false, error: { kind: 'server' } });
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of [undefined, 'mine', { kind: 'circle', circleId: 'x' }, { kind: 'circle' }]) {
      if (bad === undefined) continue; // an omitted source means personal for the single-scope calls, but here it is the personal source
      expect(await client.mineItem(bad, 'x'), JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'scope' } });
      expect(await client.mineCategoryItems(bad, 'x'), JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'scope' } });
    }
    expect(await client.mineItem(ME, '')).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'item' } });
    expect(await client.mineCategoryItems(ME, 'x'.repeat(257))).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'category' } });
    expect(calls).toHaveLength(0);
  });

  it('a source naming nothing readable is the circle 404; a source problem is named', async () => {
    const gone = await fake(err(404, { code: 'NOT_FOUND', message: 'no such circle' })).client.mineItem(IN1, 'x');
    expect(gone.error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    const src = await fake(err(422, { code: 'INVALID_INPUT', message: 'say where it is', field: 'source' })).client.mineItem(ME, 'x');
    expect(src.error).toMatchObject({ kind: 'invalid', field: 'source' });
  });
});


describe('status updates (R-011)', () => {
  const CIRCLE = 'c0123456789abcdef';
  const VIEW = { headline: 'A quiet morning.', points: [{ text: 'Mum has new tablets.', sources: [{ kind: 'circle', circleId: CIRCLE, circleName: 'Parent care' }, { kind: 'personal' }], facts: [{ scope: { kind: 'circle', circleId: CIRCLE, circleName: 'Parent care' }, id: 'note-1' }, { scope: { kind: 'personal' }, id: 'a/b?c' }] }], nothing: false, generatedAt: 5, mode: 'demo', entriesUsed: 3, entriesLeftOut: 1 };
  const answer = { status: 200, body: { status: VIEW } };

  it('the limit is 500 characters', () => expect(STATUS_MAX).toBe(500));

  it('sends only a trimmed text and the time zone, to the one route, by POST', async () => {
    const { calls, client } = fake(answer);
    await client.status('  Give me a morning status check  ', 'Europe/London');
    await client.status('no zone');
    await client.status('bad zone type', 5);
    await client.status('empty zone', '');
    await client.status('long zone', 'Z'.repeat(65));
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual(Array(5).fill('POST /api/status'));
    expect(calls.map((c) => c.body)).toEqual([{ text: 'Give me a morning status check', timeZone: 'Europe/London' }, { text: 'no zone' }, { text: 'bad zone type' }, { text: 'empty zone' }, { text: 'long zone' }]);
    for (const c of calls) {
      expect(c.init.credentials).toBe('same-origin');
      expect(Object.keys(c.init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    }
  });

  it('a circle scope narrows a status: only its kind and id are sent, a bad scope is refused before sending, and the circle 404 is the circle words', async () => {
    const { calls, client } = fake(answer);
    await client.status('status', 'UTC', { kind: 'circle', circleId: CIRCLE, circleName: 'ignored' });
    await client.status('own only', 'UTC', undefined);
    expect(calls.map((c) => c.body)).toEqual([{ text: 'status', timeZone: 'UTC', scope: { kind: 'circle', circleId: CIRCLE } }, { text: 'own only', timeZone: 'UTC' }]);
    for (const bad of [{ kind: 'personal' }, 'mine', 'circle', { kind: 'circle', circleId: '../x' }, { kind: 'circle', circleId: CIRCLE, graphId: 'x' }, null, 5]) expect((await client.status('x', 'UTC', bad)).error, JSON.stringify(bad)).toMatchObject({ kind: 'invalid', field: 'scope' });
    expect(calls).toHaveLength(2);
    const gone = await fake(err(404, { code: 'NOT_FOUND', message: 'no such circle' })).client.status('x', 'UTC', { kind: 'circle', circleId: CIRCLE });
    expect(gone.error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
  });

  it('the pulse sends only pulse, the circle and the time zone, never words, and needs a circle', async () => {
    const { calls, client } = fake(answer);
    const ok = await client.pulse({ kind: 'circle', circleId: CIRCLE, circleName: 'ignored' }, 'Europe/London');
    expect(ok.ok).toBe(true);
    await client.pulse({ kind: 'circle', circleId: CIRCLE }, 5);
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual(['POST /api/status', 'POST /api/status']);
    expect(calls.map((c) => c.body)).toEqual([{ pulse: true, scope: { kind: 'circle', circleId: CIRCLE }, timeZone: 'Europe/London' }, { pulse: true, scope: { kind: 'circle', circleId: CIRCLE } }]);
    for (const bad of [undefined, { kind: 'personal' }, 'mine', { kind: 'circle', circleId: 'nope' }]) expect((await client.pulse(bad)).error, JSON.stringify(bad)).toMatchObject({ kind: 'invalid', field: 'scope' });
    expect(calls).toHaveLength(2);
    const refused = await fake(err(422, { code: 'INVALID_INPUT', message: 'a pulse takes no text', field: 'text' })).client.pulse({ kind: 'circle', circleId: CIRCLE });
    expect(refused.error.kind).toBe('invalid');
    expect(refused.error.field).toBeUndefined(); // 'text' is not a field of a pulse call
  });

  it('checks the text first: blank, not text, or over 500 characters is refused naming text, and nothing is sent', async () => {
    const { calls, client } = fake(answer);
    for (const bad of ['', '   ', 5, null, undefined, 'x'.repeat(501)]) expect((await client.status(bad)).error, String(bad)).toMatchObject({ kind: 'invalid', field: 'text' });
    expect((await client.status('x'.repeat(500))).ok).toBe(true);
    expect((await client.status('😀'.repeat(500))).ok).toBe(true);
    expect((await client.status('😀'.repeat(501))).ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('keeps each point\'s facts (scope and id, frozen); an answer without them has none; a wrong shape is a server problem', async () => {
    const r = await fake(answer).client.status('x');
    expect(r.value.points[0].facts).toEqual(VIEW.points[0].facts);
    expect(Object.isFrozen(r.value.points[0].facts) && Object.isFrozen(r.value.points[0].facts[0]) && Object.isFrozen(r.value.points[0].facts[0].scope)).toBe(true);
    const bare = { ...VIEW, points: [{ text: 't', sources: [] }] };
    expect((await fake({ status: 200, body: { status: bare } }).client.status('x')).value.points[0].facts).toEqual([]);
    const bad = (facts) => ({ status: 200, body: { status: { ...VIEW, points: [{ text: 't', sources: [], facts }] } } });
    for (const facts of ['x', [{ scope: { kind: 'personal' }, id: '' }], [{ scope: { kind: 'personal' } }], [{ scope: { kind: 'other' }, id: 'a' }], [{ id: 'a' }], [{ scope: { kind: 'personal' }, id: 'a'.repeat(257) }], Array.from({ length: 6 }, (_, i) => ({ scope: { kind: 'personal' }, id: `a${i}` }))]) {
      expect((await fake(bad(facts)).client.status('x')).error, JSON.stringify(facts).slice(0, 40)).toMatchObject({ kind: 'server' });
    }
  });

  it('cuts the answer down to the view, frozen all the way down', async () => {
    const { client } = fake({ status: 200, body: { status: { ...VIEW, graphId: 'user-x', usage: { inputTokens: 1 }, model: 'm' } } });
    const r = await client.status('x');
    expect(r.value).toEqual(VIEW);
    expect(Object.keys(r.value).sort()).toEqual(['entriesLeftOut', 'entriesUsed', 'generatedAt', 'headline', 'mode', 'nothing', 'points']);
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.points) && Object.isFrozen(r.value.points[0]) && Object.isFrozen(r.value.points[0].sources) && Object.isFrozen(r.value.points[0].sources[0])).toBe(true);
  });

  it.each([
    ['no status', {}],
    ['empty headline', { headline: '' }],
    ['nothing not a boolean', { nothing: 'no' }],
    ['bad mode', { mode: 'other' }],
    ['negative count', { entriesUsed: -1 }],
    ['left-out count missing', { entriesLeftOut: undefined }],
    ['fractional time', { generatedAt: 1.5 }],
    ['six points', { points: Array(6).fill({ text: 't', sources: [] }) }],
    ['empty point text', { points: [{ text: '', sources: [] }] }],
    ['point without sources', { points: [{ text: 't' }] }],
    ['six sources', { points: [{ text: 't', sources: Array(6).fill({ kind: 'personal' }) }] }],
    ['a source not shaped right', { points: [{ text: 't', sources: [{ kind: 'circle', circleId: 'x', circleName: 'n' }] }] }],
    ['a non-object point', { points: ['t'] }],
  ])('an answer that is not shaped right is a server problem: %s', async (_name, change) => {
    const body = _name === 'no status' ? {} : { status: { ...VIEW, ...change } };
    const r = await fake({ status: 200, body }).client.status('x');
    expect(r.error).toEqual({ kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
  });

  it('turns refusals into kinds and words', async () => {
    const run = (status, error, headers) => fake(err(status, error, headers)).client.status('x', 'Europe/London').then((r) => r.error);
    expect(await run(401, { code: 'UNAUTHENTICATED', message: 'not signed in' })).toEqual({ kind: 'signed-out', message: 'Your session has ended. Sign in again.' });
    expect(await run(404, { code: 'NOT_FOUND', message: 'status updates are not available' })).toEqual({ kind: 'not-found', what: 'status', message: 'Status updates are not available here.' });
    expect(await run(422, { code: 'INVALID_INPUT', message: 'text is too long', field: 'text' })).toEqual({ kind: 'invalid', field: 'text', message: 'text is too long' });
    expect(await run(422, { code: 'INVALID_INPUT', message: 'unknown zone', field: 'timeZone' })).toMatchObject({ kind: 'invalid', field: 'timeZone' });
    expect(await run(422, { code: 'INVALID_INPUT', message: 'odd', field: 'graphId' })).toEqual({ kind: 'invalid', message: 'odd' });
    expect(await run(429, { code: 'THROTTLED', message: 'you have asked for the most statuses allowed in an hour (20)' }, { 'retry-after': '120' })).toEqual({ kind: 'limit', message: 'you have asked for the most statuses allowed in an hour (20)', retryAfterSeconds: 120 });
    expect(await run(502, { code: 'MODEL_TIMEOUT', message: 'the model took too long: try again' })).toEqual({ kind: 'model', reason: 'timeout', message: 'the model took too long: try again' });
    expect(await run(502, { code: 'MODEL_REFUSED', message: 'the model declined to answer' })).toMatchObject({ kind: 'model', reason: 'refused' });
    expect(await run(503, { code: 'MODEL_BUSY', message: 'the model is busy: try again shortly' }, { 'retry-after': '30' })).toMatchObject({ kind: 'model', reason: 'busy', retryAfterSeconds: 30 });
    expect(await run(502, { code: 'MODEL_ERROR', message: '' })).toEqual({ kind: 'model', reason: 'error', message: 'The model could not make your status: try again.' });
    expect(await run(500, { code: 'INTERNAL_ERROR', message: 'secret detail' })).toEqual({ kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
  });

  it('a network failure is a network problem and never throws', async () => {
    const r = await fake(new Error('offline')).client.status('x');
    expect(r.error.kind).toBe('network');
  });
});
