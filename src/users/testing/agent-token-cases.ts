import assert from 'node:assert/strict';
import { MAX_AGENT_TOKEN_LIFETIME_MS, MAX_AGENT_TOKEN_NAME, MAX_AGENT_TOKEN_SCOPES, MAX_AGENT_TOKENS_PER_USER, type AgentTokenInput, type AgentTokenStore } from '../agent-tokens.js';

export interface AgentTokenCase {
  readonly name: string;
  /** `make` gives a further fresh store that shares nothing with the first. */
  readonly run: (store: AgentTokenStore, make: () => Promise<AgentTokenStore>) => Promise<void>;
}

const T0 = 1_000_000_000_000;
const DAY = 86_400_000;
const CIRCLE_A = 'circle:cabcdefghij012345';
const CIRCLE_B = 'circle:c0123456789abcdef';
const input = (extra: Partial<AgentTokenInput> = {}): AgentTokenInput => ({ userId: 'u0000000000000001', name: 'My agent', scopes: ['personal'], checks: false, expiresAt: T0 + 90 * DAY, ...extra });

async function made(store: AgentTokenStore, extra: Partial<AgentTokenInput> = {}, now = T0) {
  const r = await store.create(input(extra), now);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

export function agentTokenCases(): readonly AgentTokenCase[] {
  return [
    {
      name: 'create gives a cpat_ token of 43 more base64url characters, and 500 tokens are all different',
      run: async (store) => {
        const tokens = new Set<string>();
        for (let i = 0; i < 500; i++) {
          const { token } = await made(store, { userId: `u${String(i % 50).padStart(16, '0')}` });
          tokens.add(token);
          if (i % 9 === 8) await store.revokeAllFor(`u${String(i % 50).padStart(16, '0')}`); // stay under the per-person limit
        }
        assert.equal(tokens.size, 500);
        for (const token of tokens) assert.match(token, /^cpat_[A-Za-z0-9_-]{43}$/);
      },
    },
    {
      name: 'the info says what was asked and never holds the token',
      run: async (store) => {
        const { token, info } = await made(store, { name: '  Tidy name  ', scopes: ['personal', CIRCLE_A], checks: true });
        assert.match(info.id, /^t[a-z0-9]{16}$/);
        assert.equal(info.userId, 'u0000000000000001');
        assert.equal(info.name, 'Tidy name');
        assert.deepEqual([...info.scopes], ['personal', CIRCLE_A]);
        assert.equal(info.checks, true);
        assert.equal(info.createdAt, T0);
        assert.equal(info.expiresAt, T0 + 90 * DAY);
        assert.equal(info.lastUsedAt, null);
        assert.equal(JSON.stringify(info).includes(token), false);
        assert.equal(JSON.stringify(info).includes(token.slice(5)), false);
      },
    },
    {
      name: 'a token resolves to its person, scopes and checks flag',
      run: async (store) => {
        const a = await made(store, { scopes: ['personal'], checks: false });
        const b = await made(store, { userId: 'u0000000000000002', scopes: [CIRCLE_A, CIRCLE_B], checks: true });
        assert.deepEqual(await store.resolve(a.token, T0 + 1), { tokenId: a.info.id, userId: 'u0000000000000001', scopes: ['personal'], checks: false });
        assert.deepEqual(await store.resolve(b.token, T0 + 1), { tokenId: b.info.id, userId: 'u0000000000000002', scopes: [CIRCLE_A, CIRCLE_B], checks: true });
      },
    },
    {
      name: 'unknown and malformed tokens resolve to nothing and never throw',
      run: async (store) => {
        const { token } = await made(store);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const twin = token.slice(0, -1) + (alphabet[alphabet.indexOf(token.at(-1) as string) ^ 1] as string);
        const odd: unknown[] = ['cpat_' + 'A'.repeat(43), '', 'cpat_', 'cpat_short', token.slice(0, -1), token + 'A', token.toUpperCase(), 'CPAT_' + token.slice(5), token.slice(5), twin, ` ${token}`, `${token} `, null, undefined, 5, {}, [token], "cpat_' OR 1=1 --", 'cpat_' + 'A'.repeat(10_000), 'cpat_' + '\u0000'.repeat(43)];
        for (const t of odd) assert.equal(await store.resolve(t as string, T0 + 1), undefined);
        assert.notEqual(await store.resolve(token, T0 + 1), undefined);
      },
    },
    {
      name: 'a session-shaped token (43 characters, no prefix) is not an agent token',
      run: async (store) => {
        const { token } = await made(store);
        assert.equal(await store.resolve(token.slice('cpat_'.length), T0 + 1), undefined);
      },
    },
    {
      name: 'a token works until its expiry time and is then gone for good',
      run: async (store) => {
        const { token } = await made(store, { expiresAt: T0 + 1000 });
        assert.notEqual(await store.resolve(token, T0 + 999), undefined);
        assert.equal(await store.resolve(token, T0 + 1000), undefined);
        assert.equal(await store.resolve(token, T0 + 5), undefined); // removed on the failed use: it does not come back at an earlier time
        assert.deepEqual(await store.list('u0000000000000001', T0 + 5), []);
      },
    },
    {
      name: 'a clock that steps backwards neither breaks nor extends a token',
      run: async (store) => {
        const { token } = await made(store, { expiresAt: T0 + 1000 }, T0 + 500);
        assert.notEqual(await store.resolve(token, T0), undefined);
        assert.equal(await store.resolve(token, T0 + 1000), undefined);
      },
    },
    {
      name: 'names are trimmed and must be 1 to 60 characters without control characters',
      run: async (store) => {
        const refused = async (name: unknown): Promise<void> => {
          const r = await store.create(input({ name: name as string }), T0);
          assert.equal(r.ok, false, String(name));
          if (!r.ok) {
            assert.equal(r.error.code, 'INVALID_INPUT');
            assert.equal(r.error.field, 'name');
          }
        };
        for (const bad of ['', '   ', 'x'.repeat(MAX_AGENT_TOKEN_NAME + 1), 'a\nb', 'a\u0000b', `a${String.fromCharCode(0x2028)}b`, 5, null, undefined]) await refused(bad);
        await made(store, { name: 'x'.repeat(MAX_AGENT_TOKEN_NAME) });
        await made(store, { name: '😀'.repeat(MAX_AGENT_TOKEN_NAME) }); // counted by character, not by UTF-16 unit
        const r = await store.create(input({ name: '😀'.repeat(MAX_AGENT_TOKEN_NAME + 1) }), T0);
        assert.equal(r.ok, false);
      },
    },
    {
      name: 'scopes are 1 to 20 distinct values, each personal or circle: and a circle id',
      run: async (store) => {
        const refused = async (scopes: unknown): Promise<void> => {
          const r = await store.create(input({ scopes: scopes as string[] }), T0);
          assert.equal(r.ok, false, JSON.stringify(scopes));
          if (!r.ok) assert.equal(r.error.field, 'scopes');
        };
        const many = Array.from({ length: MAX_AGENT_TOKEN_SCOPES + 1 }, (_, i) => `circle:c${String(i).padStart(16, '0')}`);
        for (const bad of [[], 'personal', null, ['mine'], ['Personal'], ['circle:'], ['circle:abc'], ['circle:cABCDEFGHIJ0123456'], ['circle:c0123'], ['circle:c0123456789abcdefg'], [`${CIRCLE_A}!`], [`${CIRCLE_A}\n`], [` ${CIRCLE_A}`], [CIRCLE_A, CIRCLE_A], ['personal', 'personal'], [5], [{}], many]) await refused(bad);
        await made(store, { userId: 'u0000000000000003', scopes: many.slice(0, MAX_AGENT_TOKEN_SCOPES) });
      },
    },
    {
      name: 'the checks flag must be true or false, and the expiry must be in the future and at most 365 days away',
      run: async (store) => {
        const field = async (extra: Partial<AgentTokenInput>, expected: string): Promise<void> => {
          const r = await store.create(input(extra), T0);
          assert.equal(r.ok, false, JSON.stringify(extra));
          if (!r.ok) {
            assert.equal(r.error.code, 'INVALID_INPUT');
            assert.equal(r.error.field, expected);
          }
        };
        await field({ checks: 'yes' as unknown as boolean }, 'checks');
        for (const expiresAt of [T0, T0 - 1, 0, -5, 1.5, Number.NaN, T0 + MAX_AGENT_TOKEN_LIFETIME_MS + 1, Number.POSITIVE_INFINITY, '9' as unknown as number]) await field({ expiresAt }, 'expiresAt');
        await made(store, { expiresAt: T0 + 1 });
        await made(store, { userId: 'u0000000000000004', expiresAt: T0 + MAX_AGENT_TOKEN_LIFETIME_MS }); // exactly 365 days is allowed
      },
    },
    {
      name: 'a person has at most 10 live tokens: the 11th is refused, expired and revoked ones do not count, other people are unaffected',
      run: async (store) => {
        const ids: string[] = [];
        for (let i = 0; i < MAX_AGENT_TOKENS_PER_USER; i++) ids.push((await made(store, { name: `t${i}`, expiresAt: i < 9 ? T0 + 1000 + i : T0 + 90 * DAY })).info.id);
        const eleventh = await store.create(input({ name: 'one too many' }), T0);
        assert.equal(eleventh.ok, false);
        if (!eleventh.ok) assert.equal(eleventh.error.code, 'CONFLICT');
        await made(store, { userId: 'u0000000000000009' }); // someone else is unaffected
        // by T0 + 1004 the five that expire at 1000..1004 are over, so they no longer count
        for (let i = 0; i < 5; i++) await made(store, { name: `after expiry ${i}`, expiresAt: T0 + 90 * DAY }, T0 + 1004);
        assert.equal((await store.list('u0000000000000001', T0 + 1004)).length, MAX_AGENT_TOKENS_PER_USER);
        assert.equal((await store.create(input({ name: 'full again', expiresAt: T0 + 90 * DAY }), T0 + 1004)).ok, false);
        assert.equal(await store.revoke('u0000000000000001', ids[9] as string), true); // revoking frees a place
        await made(store, { name: 'room again', expiresAt: T0 + 90 * DAY }, T0 + 1004);
      },
    },
    {
      name: 'list shows only that person\'s live tokens, newest first, as copies, and never the token',
      run: async (store) => {
        const a = await made(store, { name: 'first' }, T0);
        const b = await made(store, { name: 'second' }, T0 + 10);
        await made(store, { userId: 'u0000000000000002', name: 'not mine' }, T0 + 20);
        await made(store, { name: 'short lived', expiresAt: T0 + 50 }, T0 + 20);
        const list = await store.list('u0000000000000001', T0 + 100);
        assert.deepEqual(list.map((i) => i.name), ['second', 'first']);
        assert.equal(JSON.stringify(list).includes(a.token), false);
        assert.equal(JSON.stringify(list).includes(b.token), false);
        assert.deepEqual(await store.list('nobody', T0 + 100), []);
        try {
          (list[0] as { name: string }).name = 'changed';
        } catch {
          // frozen: fine
        }
        try {
          (list[0]?.scopes as string[]).push('circle:cxxxxxxxxxxxxxxxx');
        } catch {
          // frozen: fine
        }
        const again = await store.list('u0000000000000001', T0 + 100);
        assert.equal(again[0]?.name, 'second');
        assert.deepEqual([...(again[0]?.scopes ?? [])], ['personal']);
      },
    },
    {
      name: 'scopes handed to create are copied, not shared',
      run: async (store) => {
        const scopes = ['personal'];
        const { token } = await made(store, { scopes });
        scopes.push(CIRCLE_A);
        assert.deepEqual([...((await store.resolve(token, T0 + 1))?.scopes ?? [])], ['personal']);
      },
    },
    {
      name: 'use sets the last-used time, and renews it at most once a minute',
      run: async (store) => {
        const { token } = await made(store);
        const used = async (): Promise<number | null | undefined> => (await store.list('u0000000000000001', T0 + 10_000_000))[0]?.lastUsedAt;
        assert.equal(await used(), null);
        await store.resolve(token, T0 + 1000);
        assert.equal(await used(), T0 + 1000);
        await store.resolve(token, T0 + 1000 + 59_999); // under a minute: not renewed
        assert.equal(await used(), T0 + 1000);
        await store.resolve(token, T0 + 1000 + 60_000);
        assert.equal(await used(), T0 + 61_000);
      },
    },
    {
      name: 'revoke ends one token of that person, once; another person cannot end it',
      run: async (store) => {
        const a = await made(store);
        const b = await made(store);
        assert.equal(await store.revoke('u0000000000000002', a.info.id), false); // not theirs
        assert.notEqual(await store.resolve(a.token, T0 + 1), undefined);
        assert.equal(await store.revoke('u0000000000000001', a.info.id), true);
        assert.equal(await store.revoke('u0000000000000001', a.info.id), false);
        assert.equal(await store.resolve(a.token, T0 + 2), undefined);
        assert.notEqual(await store.resolve(b.token, T0 + 2), undefined);
        for (const odd of ['', 'x', 'T0000000000000000', 5, null, undefined, "t' OR 1=1"]) assert.equal(await store.revoke('u0000000000000001', odd as string), false);
      },
    },
    {
      name: 'revokeAllFor ends every token of that person only, and counts them',
      run: async (store) => {
        const mine = [await made(store), await made(store), await made(store)];
        const other = await made(store, { userId: 'u0000000000000002' });
        assert.equal(await store.revokeAllFor('u0000000000000001'), 3);
        for (const m of mine) assert.equal(await store.resolve(m.token, T0 + 1), undefined);
        assert.notEqual(await store.resolve(other.token, T0 + 1), undefined);
        assert.equal(await store.revokeAllFor('u0000000000000001'), 0);
        assert.equal(await store.revokeAllFor('nobody'), 0);
      },
    },
    {
      name: 'purgeExpired removes only the expired tokens, and counts them',
      run: async (store) => {
        const soon = await made(store, { expiresAt: T0 + 100 });
        const soonToo = await made(store, { userId: 'u0000000000000002', expiresAt: T0 + 100 });
        const later = await made(store, { expiresAt: T0 + 90 * DAY });
        assert.equal(await store.purgeExpired(T0 + 99), 0);
        assert.equal(await store.purgeExpired(T0 + 100), 2);
        assert.equal(await store.resolve(soon.token, T0 + 1), undefined);
        assert.equal(await store.resolve(soonToo.token, T0 + 1), undefined);
        assert.notEqual(await store.resolve(later.token, T0 + 1), undefined);
        assert.equal(await store.purgeExpired(T0 + 100), 0);
      },
    },
    {
      name: 'fifteen simultaneous creates for one person make exactly ten tokens',
      run: async (store) => {
        const results = await Promise.all(Array.from({ length: 15 }, (_, i) => store.create(input({ name: `n${i}` }), T0)));
        assert.equal(results.filter((r) => r.ok).length, MAX_AGENT_TOKENS_PER_USER);
        assert.equal((await store.list('u0000000000000001', T0)).length, MAX_AGENT_TOKENS_PER_USER);
        for (const r of results) if (!r.ok) assert.equal(r.error.code, 'CONFLICT');
      },
    },
    {
      name: 'two stores share nothing',
      run: async (store, make) => {
        const other = await make();
        const { token } = await made(store);
        assert.equal(await other.resolve(token, T0 + 1), undefined);
        assert.deepEqual(await other.list('u0000000000000001', T0 + 1), []);
        await made(other, { userId: 'u0000000000000007' });
        assert.deepEqual(await store.list('u0000000000000007', T0 + 1), []);
      },
    },
  ];
}
