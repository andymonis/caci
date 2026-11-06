import { describe, expect, it } from 'vitest';
import { createAgentTokensClient } from './agent-tokens-client.js';

const TOKEN = `cpat_${'A'.repeat(43)}`;
const ID = 't0000000000000001';
const C1 = 'c0000000000000001';
const view = (extra = {}) => ({ id: ID, name: 'Desk agent', scopes: ['personal', `circle:${C1}`], checks: false, createdAt: 1_700_000_000_000, expiresAt: 1_707_776_000_000, lastUsedAt: null, ...extra });

function fake(reply) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    const r = typeof reply === 'function' ? reply(path, init) : reply;
    if (r === 'throw') throw new Error('offline');
    return { status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { calls, client: createAgentTokensClient({ fetchFn }) };
}

describe('list', () => {
  it('reads the keys, cut down and frozen', async () => {
    const { client, calls } = fake({ status: 200, body: { items: [view(), view({ id: 't0000000000000002', name: 'Second', scopes: ['personal'], checks: true, lastUsedAt: 1_700_000_100_000, extra: 'ignored' })] } });
    const r = await client.list();
    expect(r.ok && r.value.items).toHaveLength(2);
    expect(r.ok && r.value.items[1]).toEqual({ id: 't0000000000000002', name: 'Second', scopes: ['personal'], checks: true, createdAt: 1_700_000_000_000, expiresAt: 1_707_776_000_000, lastUsedAt: 1_700_000_100_000 });
    expect(Object.isFrozen(r.ok && r.value.items)).toBe(true);
    expect(calls[0]).toMatchObject({ path: '/api/me/agent-tokens', init: { method: 'GET', credentials: 'same-origin' } });
    expect(calls[0].init.body).toBeUndefined();
  });

  it('refuses a page with anything wrongly shaped, as a server problem', async () => {
    const bad = [{ items: 'x' }, { items: [view({ id: 'x' })] }, { items: [view({ name: '' })] }, { items: [view({ scopes: [] })] }, { items: [view({ scopes: ['mine'] })] }, { items: [view({ scopes: ['circle:abc'] })] }, { items: [view({ checks: 'no' })] }, { items: [view({ createdAt: -1 })] }, { items: [view({ lastUsedAt: undefined })] }, { items: [null] }, []];
    for (const body of bad) expect(await fake({ status: 200, body }).client.list(), JSON.stringify(body)).toMatchObject({ ok: false, error: { kind: 'server' } });
  });

  it('says unavailable for a service with agent access off, and signed-out for 401, and never throws', async () => {
    expect(await fake({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } }).client.list()).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(await fake({ status: 401, body: {} }).client.list()).toMatchObject({ ok: false, error: { kind: 'signed-out' } });
    expect(await fake({ status: 500, body: { error: { message: 'secret path /var' } } }).client.list()).toMatchObject({ ok: false, error: { kind: 'server', message: expect.not.stringContaining('secret') } });
    expect(await fake('throw').client.list()).toMatchObject({ ok: false, error: { kind: 'network' } });
    expect(await fake({ status: 200, body: 'not json' }).client.list()).toMatchObject({ ok: false, error: { kind: 'server' } });
  });
});

describe('create', () => {
  const made = { status: 201, body: { token: TOKEN, agentToken: view() } };

  it('sends only the four fields, trimmed, and gives the key once with its view', async () => {
    const { client, calls } = fake(made);
    const r = await client.create({ name: '  Desk agent  ', scopes: ['personal', `circle:${C1}`], checks: true, days: 90, extra: 'x', userId: 'u1' });
    expect(r.ok && r.value.token).toBe(TOKEN);
    expect(r.ok && r.value.agentToken.name).toBe('Desk agent');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'Desk agent', scopes: ['personal', `circle:${C1}`], checks: true, days: 90 });
    expect(calls[0].init.method).toBe('POST');
  });

  it('checks early, names the field, and sends nothing when something is wrong', async () => {
    const cases = [
      [{ name: '', scopes: ['personal'], checks: false, days: 90 }, 'name'],
      [{ name: '   ', scopes: ['personal'], checks: false, days: 90 }, 'name'],
      [{ name: 'x'.repeat(61), scopes: ['personal'], checks: false, days: 90 }, 'name'],
      [{ name: 5, scopes: ['personal'], checks: false, days: 90 }, 'name'],
      [{ name: 'a', scopes: [], checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: 'personal', checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: ['mine'], checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: ['circle:../x'], checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: ['personal', 'personal'], checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: Array.from({ length: 21 }, (_, i) => `circle:c${String(i).padStart(16, '0')}`), checks: false, days: 90 }, 'scopes'],
      [{ name: 'a', scopes: ['personal'], checks: 'yes', days: 90 }, 'checks'],
      [{ name: 'a', scopes: ['personal'], checks: false, days: 0 }, 'days'],
      [{ name: 'a', scopes: ['personal'], checks: false, days: 366 }, 'days'],
      [{ name: 'a', scopes: ['personal'], checks: false, days: 1.5 }, 'days'],
      [{ name: 'a', scopes: ['personal'], checks: false, days: '30' }, 'days'],
      [null, 'name'],
      ['x', 'name'],
      [undefined, 'name'],
    ];
    for (const [input, field] of cases) {
      const { client, calls } = fake(made);
      const r = await client.create(input);
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, error: { kind: 'invalid', field } });
      expect(calls, JSON.stringify(input)).toHaveLength(0);
    }
    const ok = fake(made);
    expect((await ok.client.create({ name: 'x'.repeat(60), scopes: ['personal'], checks: false, days: 365 })).ok).toBe(true);
    expect((await fake(made).client.create({ name: 'a', scopes: ['personal'], checks: false, days: 1 })).ok).toBe(true);
  });

  it('refuses an answer whose key is not shaped like one, or whose view is wrong', async () => {
    for (const body of [{ token: 'cpat_short', agentToken: view() }, { token: TOKEN.toUpperCase(), agentToken: view() }, { token: TOKEN, agentToken: view({ id: 'x' }) }, { token: `${TOKEN} `, agentToken: view() }, { agentToken: view() }, { token: 5, agentToken: view() }]) {
      expect(await fake({ status: 201, body }).client.create({ name: 'a', scopes: ['personal'], checks: false, days: 90 }), JSON.stringify(body)).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });

  it('turns the service\'s refusals into words: a full list, a field problem (only for a field of this call), a wait', async () => {
    const input = { name: 'a', scopes: ['personal'], checks: false, days: 90 };
    expect(await fake({ status: 409, body: { error: { code: 'CONFLICT', message: 'you already have the most agent tokens allowed (10): revoke one first' } } }).client.create(input)).toMatchObject({ ok: false, error: { kind: 'limit', message: expect.stringContaining('most agent tokens') } });
    expect(await fake({ status: 422, body: { error: { code: 'INVALID_INPUT', message: 'the name must be 1 to 60 characters', field: 'name' } } }).client.create(input)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'name' } });
    const stray = await fake({ status: 422, body: { error: { code: 'INVALID_INPUT', message: 'x', field: 'userId' } } }).client.create(input);
    expect(stray).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stray.ok === false && 'field' in stray.error).toBe(false);
    expect(await fake({ status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'slow down' } } }).client.create(input)).toMatchObject({ ok: false, error: { kind: 'throttled', retryAfterSeconds: 30 } });
    expect(await fake({ status: 401, body: {} }).client.create(input)).toMatchObject({ ok: false, error: { kind: 'signed-out' } });
    expect(await fake({ status: 404, body: {} }).client.create(input)).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(await fake('throw').client.create(input)).toMatchObject({ ok: false, error: { kind: 'network' } });
  });
});

describe('revoke', () => {
  it('stops a key by its id: 204 is success', async () => {
    const { client, calls } = fake({ status: 204 });
    expect(await client.revoke(ID)).toEqual({ ok: true, value: true });
    expect(calls[0]).toMatchObject({ path: `/api/me/agent-tokens/${ID}`, init: { method: 'DELETE' } });
  });

  it('sends nothing for an id that is not shaped like one, and says it no longer exists for a 404', async () => {
    for (const bad of ['', 'x', '../x', 't000', 'T0000000000000001', `${ID}/x`, `${ID}?a=b`, '%2e%2e', 5, null, undefined]) {
      const { client, calls } = fake({ status: 204 });
      expect(await client.revoke(bad), String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'That access key no longer exists.' } });
      expect(calls).toHaveLength(0);
    }
    expect(await fake({ status: 404, body: {} }).client.revoke(ID)).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect(await fake({ status: 401, body: {} }).client.revoke(ID)).toMatchObject({ ok: false, error: { kind: 'signed-out' } });
    expect(await fake({ status: 500, body: {} }).client.revoke(ID)).toMatchObject({ ok: false, error: { kind: 'server' } });
  });
});

it('needs a fetch function', () => {
  expect(() => createAgentTokensClient({ fetchFn: undefined })).toThrow(TypeError);
});
