import { describe, expect, it } from 'vitest';
import { createFactsClient, factOf, FORBIDDEN_REMOVE, NO_FACT, scopeOf } from './facts-client.js';

const C = 'cabcdefghij012345';
function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createFactsClient({ fetchFn }) };
}
const FACT = { scope: { kind: 'circle', circleId: C }, id: 'yoga-1' };
const resolved = (extra = {}) => ({ status: 200, body: { resolved: { fact: FACT, verb: 'pay', effect: 'clear', result: 'hidden', ...extra } } });

describe('the shapes it accepts', () => {
  it('scopeOf keeps exactly a kind and a circle id of the right shape', () => {
    expect(scopeOf({ kind: 'personal', circleName: 'x' })).toEqual({ kind: 'personal' });
    expect(scopeOf({ kind: 'circle', circleId: C, circleName: 'Secret' })).toEqual({ kind: 'circle', circleId: C });
    for (const bad of [undefined, null, 'personal', [], { kind: 'circle' }, { kind: 'circle', circleId: '../x' }, { kind: 'circle', circleId: `${C}x` }, { kind: 'group' }]) expect(scopeOf(bad), JSON.stringify(bad)).toBeUndefined();
  });
  it('factOf takes a missing scope as your own brain and refuses a bad id', () => {
    expect(factOf({ id: 'a' })).toEqual({ scope: { kind: 'personal' }, id: 'a' });
    expect(factOf({ scope: { kind: 'circle', circleId: C, circleName: 'n' }, id: '😀'.repeat(256) })).toEqual({ scope: { kind: 'circle', circleId: C }, id: '😀'.repeat(256) });
    for (const bad of [null, {}, { id: '' }, { id: 5 }, { id: 'a'.repeat(257) }, { id: `a${String.fromCharCode(0xd800)}` }, { id: 'a', scope: { kind: 'circle' } }]) expect(factOf(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('resolve', () => {
  it('sends the exact reference and the verb, only that, and returns the cut-down answer', async () => {
    const { client, calls } = fake(resolved());
    const r = await client.resolve({ ...FACT, scope: { ...FACT.scope, circleName: 'Yoga' }, extra: 'x', title: 'Pay for yoga' }, 'pay');
    expect(r).toEqual({ ok: true, value: { fact: FACT, verb: 'pay', effect: 'clear', result: 'hidden' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/facts/resolve');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ scope: { kind: 'circle', circleId: C }, id: 'yoga-1', verb: 'pay' });
    expect(calls[0].init.credentials).toBe('same-origin');
  });

  it('refuses a bad reference or verb before sending anything', async () => {
    const { client, calls } = fake(resolved());
    for (const fact of [null, {}, { id: '' }, { scope: { kind: 'circle', circleId: 'x' }, id: 'a' }]) expect((await client.resolve(fact, 'pay')).error, JSON.stringify(fact)).toEqual({ kind: 'not-found', what: 'fact', message: NO_FACT });
    for (const verb of [undefined, '', 'Pay', '/pay', 'a b', 'a'.repeat(21), 5]) expect((await client.resolve(FACT, verb)).error, String(verb)).toMatchObject({ kind: 'invalid', field: 'verb' });
    expect(calls).toEqual([]);
  });

  it('maps every status to a kind and fixed words', async () => {
    const cases = [
      [401, undefined, { kind: 'signed-out' }],
      [403, { error: { code: 'FORBIDDEN', message: 'whatever the server said' } }, { kind: 'forbidden', message: FORBIDDEN_REMOVE }],
      [404, { error: { code: 'NOT_FOUND', message: 'no such fact' } }, { kind: 'not-found', what: 'fact', message: NO_FACT }],
      [404, { error: { code: 'NOT_FOUND', message: 'no such circle' } }, { kind: 'not-found', what: 'circle' }],
      [422, { error: { code: 'INVALID_INPUT', message: 'no such verb: the verbs are clear, pay, remove', field: 'verb' } }, { kind: 'invalid', field: 'verb' }],
      [429, { error: { code: 'LIMIT_REACHED', message: 'you have resolved the most facts allowed: take one back first' } }, { kind: 'limit' }],
      [500, { error: { message: 'SECRET sql' } }, { kind: 'server' }],
      [502, undefined, { kind: 'server' }],
    ];
    for (const [status, body, want] of cases) {
      const { client } = fake({ status, body });
      const r = await client.resolve(FACT, 'pay');
      expect(r.ok).toBe(false);
      expect(r.error, String(status)).toMatchObject(want);
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });

  it('a limit with a wait carries the seconds, and a network failure or a bad answer never throws', async () => {
    expect((await fake({ status: 429, body: { error: { message: 'x' } }, headers: { 'retry-after': '12' } }).client.resolve(FACT, 'pay')).error).toMatchObject({ kind: 'limit', retryAfterSeconds: 12 });
    expect((await fake(new Error('offline')).client.resolve(FACT, 'pay')).error.kind).toBe('network');
    for (const body of [{ resolved: { ...resolved().body.resolved, verb: 'Pay' } }, { resolved: { ...resolved().body.resolved, effect: 'zap' } }, { resolved: { ...resolved().body.resolved, result: 'maybe' } }, { resolved: { verb: 'pay' } }, { resolved: 5 }, {}, []]) {
      expect((await fake({ status: 200, body }).client.resolve(FACT, 'pay')).error.kind, JSON.stringify(body)).toBe('server');
    }
    expect((await fake({ status: 200, raw: 'not json' }).client.resolve(FACT, 'pay')).error.kind).toBe('server');
  });
});

describe('unresolve', () => {
  it('sends the reference only and returns the fact', async () => {
    const { client, calls } = fake({ status: 200, body: { unresolved: { fact: FACT } } });
    expect(await client.unresolve({ ...FACT, verb: 'pay' })).toEqual({ ok: true, value: { fact: FACT } });
    expect(JSON.parse(calls[0].init.body)).toEqual({ scope: { kind: 'circle', circleId: C }, id: 'yoga-1' });
    expect(calls[0].path).toBe('/api/facts/unresolve');
  });
  it('refuses a bad reference without sending, and a bad answer is a server problem', async () => {
    const { client, calls } = fake({ status: 200, body: { unresolved: { fact: FACT } } });
    expect((await client.unresolve({ id: '' })).error.kind).toBe('not-found');
    expect(calls).toEqual([]);
    expect((await fake({ status: 200, body: { unresolved: {} } }).client.unresolve(FACT)).error.kind).toBe('server');
  });
});

describe('list', () => {
  const page = (items, next = null) => ({ status: 200, body: { items, next } });
  const item = { fact: FACT, verb: 'pay', at: 1700000000000 };
  it('asks for a page and continues from the next of the page before, encoded', async () => {
    const { client, calls } = fake(page([item], { scope: { kind: 'circle', circleId: C }, id: 'a b&c' }));
    const first = await client.list({ limit: 20 });
    expect(first).toEqual({ ok: true, value: { items: [item], next: { scope: { kind: 'circle', circleId: C }, id: 'a b&c' } } });
    expect(calls[0].path).toBe('/api/facts/resolutions?limit=20');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    await client.list({ after: first.value.next });
    expect(calls[1].path).toBe(`/api/facts/resolutions?after_scope=circle:${C}&after_id=a%20b%26c`);
    await client.list({ after: { scope: { kind: 'personal' }, id: 'p' } });
    expect(calls[2].path).toBe('/api/facts/resolutions?after_scope=personal&after_id=p');
    await client.list();
    expect(calls[3].path).toBe('/api/facts/resolutions');
  });
  it('refuses a bad limit or position before sending, and a misshapen answer is a server problem', async () => {
    const { client, calls } = fake(page([item]));
    for (const limit of [0, 101, 1.5, '5']) expect((await client.list({ limit })).error, String(limit)).toMatchObject({ kind: 'invalid', field: 'limit' });
    for (const after of [{}, { id: 'x' }, { scope: { kind: 'circle' }, id: 'x' }, 'x']) expect((await client.list({ after })).error, JSON.stringify(after)).toMatchObject({ kind: 'invalid', field: 'after' });
    expect((await client.list(null)).error.kind).toBe('invalid');
    expect(calls).toEqual([]);
    for (const body of [{ items: [{ fact: FACT, verb: 'pay' }], next: null }, { items: [{ fact: FACT, verb: 'Pay', at: 1 }], next: null }, { items: [], next: 'x' }, { items: 'x', next: null }, { items: [] }]) {
      expect((await fake({ status: 200, body }).client.list()).error.kind, JSON.stringify(body)).toBe('server');
    }
  });
  it('never carries words: a stray field in an item is cut', async () => {
    const r = await fake(page([{ ...item, title: 'Pay for yoga', fact: { ...FACT, title: 'x' } }])).client.list();
    expect(JSON.stringify(r)).not.toContain('Pay for yoga');
    expect(Object.keys(r.value.items[0]).sort()).toEqual(['at', 'fact', 'verb']);
  });
});

describe('verbs', () => {
  const VERBS = { items: [{ name: 'clear', effect: 'clear', help: 'Clear this for me.' }, { name: 'remove', effect: 'remove', help: 'Remove this fact for everyone.' }] };
  it('asks for the vocabulary and keeps name, effect and help only', async () => {
    const { client, calls } = fake({ status: 200, body: { items: [{ ...VERBS.items[0], secret: 'x' }, VERBS.items[1]] } });
    expect(await client.verbs()).toEqual({ ok: true, value: VERBS });
    expect(calls[0].path).toBe('/api/facts/verbs');
    expect(calls[0].init.method).toBe('GET');
  });
  it('a misshapen vocabulary is a server problem', async () => {
    for (const body of [{}, { items: 'x' }, { items: [{ name: 'Clear', effect: 'clear', help: 'x' }] }, { items: [{ name: 'a', effect: 'zap', help: 'x' }] }, { items: [{ name: 'a', effect: 'clear', help: '' }] }, { items: [{ name: 'a', effect: 'clear', help: 'x'.repeat(81) }] }, { items: Array.from({ length: 21 }, () => VERBS.items[0]) }]) {
      expect((await fake({ status: 200, body }).client.verbs()).error.kind, JSON.stringify(body).slice(0, 60)).toBe('server');
    }
    expect((await fake({ status: 401 }).client.verbs()).error.kind).toBe('signed-out');
  });
});
