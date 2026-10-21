import { describe, expect, it } from 'vitest';
import { createLedgerClient } from './ledger-client.js';

const C = 'cabcdefghij012345';
function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createLedgerClient({ fetchFn }) };
}
const ENTRY = { id: 'l1', at: 1700000000000, action: 'removed', kind: 'item', subject: 'note-0', title: 'Tablet A', summary: '2 x daily', by: { username: 'ann', displayName: 'Ann A' } };
const page = (items = [ENTRY], extra = {}) => ({ status: 200, body: { items, nextCursor: null, ...extra } });

describe('the ledger client', () => {
  it('asks for the personal log by default, with a page size, and sends nothing else', async () => {
    const { client, calls } = fake(page());
    const r = await client.list(undefined, { limit: 20 });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/ledger?scope=personal&limit=20');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('asks for a circle by id and passes a cursor encoded; the circle name is never sent', async () => {
    const { client, calls } = fake(page());
    await client.list({ kind: 'circle', circleId: C, circleName: 'Secret name' }, { cursor: 'abc_-1' });
    expect(calls[0].path).toBe(`/api/ledger?scope=circle:${C}&cursor=abc_-1`);
  });

  it('refuses a bad scope, "mine", a bad limit or a bad cursor before sending anything', async () => {
    const { client, calls } = fake(page());
    for (const scope of ['mine', 'x', 5, { kind: 'circle', circleId: '../x' }, { kind: 'circle' }]) expect((await client.list(scope)).error, String(scope)).toMatchObject({ kind: 'invalid', field: 'scope' });
    expect((await client.list(undefined, { limit: 0 })).error).toMatchObject({ kind: 'invalid', field: 'limit' });
    expect((await client.list(undefined, { limit: 101 })).error).toMatchObject({ kind: 'invalid', field: 'limit' });
    expect((await client.list(undefined, { cursor: 'a b&c=d' })).error).toMatchObject({ kind: 'invalid', field: 'cursor' });
    expect(calls).toEqual([]);
  });

  it('cuts an answer down to the fields it uses, frozen all the way down', async () => {
    const { client } = fake(page([{ ...ENTRY, graphId: 'user-u1', extra: 1, by: { username: 'ann', displayName: 'Ann A', email: 'a@b.c' } }, { id: 'l2', at: 5, action: 'added', kind: 'category', subject: 'health', title: '', summary: '' }], { scope: { kind: 'circle', circleId: C, circleName: 'Club' } }));
    const r = await client.list({ kind: 'circle', circleId: C });
    expect(r.value.items[0]).toEqual(ENTRY);
    expect(r.value.items[1]).toEqual({ id: 'l2', at: 5, action: 'added', kind: 'category', subject: 'health' });
    expect(r.value.scope).toEqual({ kind: 'circle', circleId: C, circleName: 'Club' });
    expect(r.value.nextCursor).toBeNull();
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.items) && Object.isFrozen(r.value.items[0]) && Object.isFrozen(r.value.items[0].by) && Object.isFrozen(r.value.scope)).toBe(true);
    expect('scope' in (await fake(page()).client.list()).value).toBe(false);
  });

  it('text in an entry stays text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = await fake(page([{ ...ENTRY, title: evil, summary: evil, by: { username: 'ann', displayName: evil } }])).client.list();
    expect(r.value.items[0].title).toBe(evil);
    expect(r.value.items[0].by.displayName).toBe(evil);
  });

  it('an answer that is not shaped right is a server problem, never a crash', async () => {
    const bad = [
      {}, { items: 'x', nextCursor: null }, { items: [], nextCursor: 5 }, { items: [], nextCursor: undefined },
      { items: [null], nextCursor: null }, { items: [{ ...ENTRY, id: '' }], nextCursor: null }, { items: [{ ...ENTRY, at: -1 }], nextCursor: null }, { items: [{ ...ENTRY, at: 1.5 }], nextCursor: null },
      { items: [{ ...ENTRY, action: 'deleted' }], nextCursor: null }, { items: [{ ...ENTRY, kind: 'node' }], nextCursor: null }, { items: [{ ...ENTRY, subject: 5 }], nextCursor: null },
      { items: [{ ...ENTRY, title: 5 }], nextCursor: null }, { items: [{ ...ENTRY, summary: 5 }], nextCursor: null }, { items: [{ ...ENTRY, by: 'ann' }], nextCursor: null },
      { items: [{ ...ENTRY, by: { username: 'a' } }], nextCursor: null }, { items: [], nextCursor: null, scope: { kind: 'x' } },
    ];
    for (const body of bad) expect((await fake({ status: 200, body }).client.list()).error?.kind, JSON.stringify(body).slice(0, 70)).toBe('server');
    expect((await fake({ status: 200, raw: 'not json' }).client.list()).error.kind).toBe('server');
    expect((await fake(new Error('down')).client.list()).error.kind).toBe('network');
  });

  it('refusals become kinds and words, with the same words for every missing circle', async () => {
    const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });
    expect((await fake(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' })).client.list()).error).toEqual({ kind: 'signed-out', message: 'Your session has ended. Sign in again.' });
    expect((await fake(err(404, { code: 'NOT_FOUND', message: 'no such circle' })).client.list({ kind: 'circle', circleId: C })).error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    expect((await fake(err(422, { code: 'INVALID_INPUT', message: 'scope is wrong', field: 'scope.circleId' })).client.list()).error).toMatchObject({ kind: 'invalid', field: 'scope', message: 'scope is wrong' });
    expect((await fake(err(422, { code: 'INVALID_INPUT', message: 'm', field: 'password' })).client.list()).error.field).toBeUndefined();
    expect((await fake(err(429, { code: 'THROTTLED', message: 'slow down' }, { 'retry-after': '7' })).client.list()).error).toEqual({ kind: 'limit', message: 'slow down', retryAfterSeconds: 7 });
    const server = await fake(err(500, { code: 'STORAGE_ERROR', message: 'secret /var/db path' })).client.list();
    expect(server.error.kind).toBe('server');
    expect(server.error.message).not.toContain('secret');
  });
});

describe('inputs, the words of an update (R-017)', () => {
  const INPUT = { id: 'l2', at: 1700000000001, action: 'added', kind: 'input', text: 'Mum now takes 1 tablet 😀 <b>daily</b>\nsecond line', by: { username: 'ann', displayName: 'Ann A' } };

  it('keeps an input with its exact text and no subject, frozen, next to ordinary entries', async () => {
    const { client } = fake(page([INPUT, ENTRY]));
    const r = await client.list(undefined);
    expect(r.ok).toBe(true);
    expect(r.value.items[0]).toEqual({ id: 'l2', at: 1700000000001, action: 'added', kind: 'input', text: INPUT.text, by: { username: 'ann', displayName: 'Ann A' } });
    expect('subject' in r.value.items[0]).toBe(false);
    expect(Object.isFrozen(r.value.items[0])).toBe(true);
    expect(r.value.items[1].subject).toBe('note-0');
  });

  it('refuses a wrongly shaped input or text on another kind as a server problem', async () => {
    const bad = [{ ...INPUT, text: undefined }, { ...INPUT, text: '' }, { ...INPUT, text: 5 }, { ...INPUT, text: 'x'.repeat(8001) }, { ...INPUT, action: 'removed' }, { ...ENTRY, text: 'stray' }, { ...ENTRY, subject: undefined }];
    for (const entry of bad) expect((await fake(page([entry])).client.list(undefined)).error, JSON.stringify(entry).slice(0, 60)).toMatchObject({ kind: 'server' });
    expect((await fake(page([{ ...INPUT, text: '😀'.repeat(8000) }])).client.list(undefined)).ok).toBe(true);
  });
});

