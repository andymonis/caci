import { describe, expect, it } from 'vitest';
import { createNotesClient, isNodeId, isProposalId, NOTE_MAX } from './notes-client.js';

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
    expect(r.value).toEqual({ id: P, applied: 3, summary: SUMMARY });
    for (const body of [{}, { written: { id: P, applied: -1, summary: SUMMARY } }, { written: { id: 'x', applied: 1, summary: SUMMARY } }, { written: { id: P, applied: 1, summary: {} } }]) expect((await fake({ status: 200, body }).client.approve(P)).error.kind).toBe('server');
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
