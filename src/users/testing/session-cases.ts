import assert from 'node:assert/strict';
import type { SessionOptions, SessionStore } from '../session-store.js';

/** The settings the suite asks every store for: small round numbers so the arithmetic is easy to follow. */
export const SUITE_OPTIONS: SessionOptions = Object.freeze({ idleMs: 100_000, absoluteMs: 1_000_000, renewEveryMs: 60_000, maxPerUser: 3 });

export interface SessionCase {
  readonly name: string;
  /** `make` gives a further fresh store with the settings the case wants (default: the suite's). */
  readonly run: (store: SessionStore, make: (options?: SessionOptions) => Promise<SessionStore>) => Promise<void>;
}

const T0 = 1_000_000_000_000;

export function sessionCases(): readonly SessionCase[] {
  return [
    {
      name: 'create gives a 43-character base64url token, and 1,000 tokens are all different',
      run: async (store) => {
        const tokens = new Set<string>();
        for (let i = 0; i < 1000; i++) tokens.add(await store.create(`user-${i % 7}`, T0));
        assert.equal(tokens.size, 1000);
        for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      },
    },
    {
      name: 'a token resolves to its user, and a user can have several sessions',
      run: async (store) => {
        const a = await store.create('ann', T0);
        const b = await store.create('ann', T0 + 1);
        const c = await store.create('bob', T0 + 2);
        assert.equal(await store.resolve(a, T0 + 10), 'ann');
        assert.equal(await store.resolve(b, T0 + 10), 'ann');
        assert.equal(await store.resolve(c, T0 + 10), 'bob');
      },
    },
    {
      name: 'unknown and malformed tokens resolve to nothing and never throw',
      run: async (store) => {
        await store.create('ann', T0);
        const unknown = 'A'.repeat(43);
        const odd: unknown[] = [unknown, '', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)}=`, ' '.repeat(43), 'é'.repeat(43), null, undefined, 5, {}, ['A'.repeat(43)], '\u0000'.repeat(43), "' OR 1=1 --", 'A'.repeat(10_000)];
        for (const token of odd) assert.equal(await store.resolve(token as string, T0 + 1), undefined);
        for (const token of odd) assert.equal(await store.revoke(token as string), false);
      },
    },
    {
      name: 'a token is not accepted in a second spelling (the spare bits of its last character)',
      run: async (store) => {
        const token = await store.create('ann', T0);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const twin = token.slice(0, -1) + (alphabet[alphabet.indexOf(token.at(-1) as string) ^ 1] as string);
        assert.equal(Buffer.from(twin, 'base64url').equals(Buffer.from(token, 'base64url')), true);
        assert.equal(await store.resolve(twin, T0 + 1), undefined);
        assert.equal(await store.resolve(token, T0 + 1), 'ann');
      },
    },
    {
      name: 'a session ends when it has been idle for the idle time, and is then gone for good',
      run: async (store) => {
        const token = await store.create('ann', T0);
        assert.equal(await store.resolve(token, T0 + 99_999), 'ann'); // just inside (this also renews it: 99,999 is over the renew interval)
        assert.equal(await store.resolve(token, T0 + 99_999 + 100_000 - 1), 'ann'); // idle again for just under the idle time
        assert.equal(await store.resolve(token, T0 + 99_999 + 99_999 + 100_000), undefined); // idle for the full time
        assert.equal(await store.resolve(token, T0 + 99_999 + 99_999 + 1), undefined); // and it does not come back at an earlier time
      },
    },
    {
      name: 'use renews the idle clock at most once per renew interval',
      run: async (store) => {
        const early = await store.create('ann', T0);
        assert.equal(await store.resolve(early, T0 + 50_000), 'ann'); // under 60 s since last use: not renewed
        assert.equal(await store.resolve(early, T0 + 100_000), undefined); // so it is idle for the full 100 s
        const renewed = await store.create('bob', T0);
        assert.equal(await store.resolve(renewed, T0 + 60_000), 'bob'); // 60 s: renewed
        assert.equal(await store.resolve(renewed, T0 + 150_000), 'bob'); // alive: only 90 s since the renewal
        assert.equal(await store.resolve(renewed, T0 + 250_000), undefined); // 100 s since the last renewal at 150 s
      },
    },
    {
      name: 'a session ends at the absolute lifetime however busy it is',
      run: async (store) => {
        const token = await store.create('ann', T0);
        for (let t = 60_000; t < 1_000_000; t += 60_000) assert.equal(await store.resolve(token, T0 + t), 'ann', `at ${t}`);
        assert.equal(await store.resolve(token, T0 + 999_999), 'ann');
        assert.equal(await store.resolve(token, T0 + 1_000_000), undefined);
      },
    },
    {
      name: 'a clock that steps backwards neither breaks nor extends a session',
      run: async (store) => {
        const token = await store.create('ann', T0 + 500_000);
        assert.equal(await store.resolve(token, T0), 'ann'); // earlier than the login: still treated as live, not an error
        assert.equal(await store.resolve(token, T0 + 500_000 + 100_000), undefined); // the real idle time still applies
      },
    },
    {
      name: 'revoke ends one session, once',
      run: async (store) => {
        const a = await store.create('ann', T0);
        const b = await store.create('ann', T0);
        assert.equal(await store.revoke(a), true);
        assert.equal(await store.revoke(a), false);
        assert.equal(await store.resolve(a, T0 + 1), undefined);
        assert.equal(await store.resolve(b, T0 + 1), 'ann');
      },
    },
    {
      name: 'revokeAllFor ends every session of that user only, and counts them',
      run: async (store) => {
        const ann = [await store.create('ann', T0), await store.create('ann', T0), await store.create('ann', T0)];
        const bob = await store.create('bob', T0);
        assert.equal(await store.revokeAllFor('ann'), 3);
        for (const token of ann) assert.equal(await store.resolve(token, T0 + 1), undefined);
        assert.equal(await store.resolve(bob, T0 + 1), 'bob');
        assert.equal(await store.revokeAllFor('ann'), 0);
        assert.equal(await store.revokeAllFor('nobody'), 0);
      },
    },
    {
      name: 'revokeAllFor can spare one token (the one a password change was made with)',
      run: async (store) => {
        const keep = await store.create('ann', T0);
        const other = await store.create('ann', T0);
        assert.equal(await store.revokeAllFor('ann', { except: keep }), 1);
        assert.equal(await store.resolve(keep, T0 + 1), 'ann');
        assert.equal(await store.resolve(other, T0 + 1), undefined);
        // an exception that is not a token, or belongs to someone else, spares nothing of ann's
        const bobs = await store.create('bob', T0);
        assert.equal(await store.revokeAllFor('ann', { except: bobs }), 1);
        assert.equal(await store.revokeAllFor('bob', { except: 'not a token' }), 1);
      },
    },
    {
      name: 'purgeExpired removes the idle sessions and the over-age ones, and counts them',
      run: async (store) => {
        const idle = await store.create('ann', T0); // never used again
        const busy = await store.create('bob', T0); // used every minute, so only its age ends it
        for (let t = 60_000; t < 1_000_000; t += 60_000) await store.resolve(busy, T0 + t);
        const fresh = await store.create('cat', T0 + 990_000); // created just now
        assert.equal(await store.purgeExpired(T0 + 1_000_000), 2); // idle (idle for 1,000 s) and busy (1,000 s old)
        assert.equal(await store.resolve(idle, T0 + 1_000_000), undefined);
        assert.equal(await store.resolve(busy, T0 + 1_000_000), undefined);
        assert.equal(await store.resolve(fresh, T0 + 1_000_000), 'cat');
      },
    },
    {
      name: 'purgeExpired keeps what is still valid',
      run: async (store) => {
        const a = await store.create('ann', T0);
        const b = await store.create('bob', T0 + 50_000);
        assert.equal(await store.purgeExpired(T0 + 99_999), 0);
        assert.equal(await store.purgeExpired(T0 + 100_000), 1); // a is idle for 100 s; b for 50 s
        assert.equal(await store.resolve(a, T0 + 100_000), undefined);
        assert.equal(await store.resolve(b, T0 + 100_000), 'bob');
        assert.equal(await store.purgeExpired(T0 + 100_000), 0);
      },
    },
    {
      name: 'a user keeps at most maxPerUser sessions: a new login ends the least recently used',
      run: async (store) => {
        const first = await store.create('ann', T0);
        const second = await store.create('ann', T0 + 10);
        const third = await store.create('ann', T0 + 20);
        await store.resolve(first, T0 + 70_000); // first is used again (renewed); second is now the least recently used
        const fourth = await store.create('ann', T0 + 80_000);
        assert.equal(await store.resolve(second, T0 + 80_001), undefined);
        for (const token of [first, third, fourth]) assert.equal(await store.resolve(token, T0 + 80_001), 'ann');
        const bob = await store.create('bob', T0); // other users are not affected by ann's limit
        assert.equal(await store.resolve(bob, T0 + 1), 'bob');
      },
    },
    {
      name: 'the stored data cannot be turned back into a token: resolving needs the token itself',
      run: async (store) => {
        const token = await store.create('ann', T0);
        const reversed = Buffer.from(token, 'base64url').reverse().toString('base64url');
        assert.equal(await store.resolve(reversed, T0 + 1), undefined);
        assert.equal(await store.resolve(token, T0 + 1), 'ann');
      },
    },
    {
      name: 'the settings are honoured: another store with other times behaves accordingly',
      run: async (_store, make) => {
        const quick = await make({ idleMs: 10, absoluteMs: 20, renewEveryMs: 5, maxPerUser: 1 });
        const token = await quick.create('ann', T0);
        assert.equal(await quick.resolve(token, T0 + 9), 'ann');
        assert.equal(await quick.resolve(token, T0 + 20), undefined); // 20 ms after login: over the absolute lifetime
        const one = await quick.create('bob', T0);
        const two = await quick.create('bob', T0 + 1); // maxPerUser 1: the first goes
        assert.equal(await quick.resolve(one, T0 + 2), undefined);
        assert.equal(await quick.resolve(two, T0 + 2), 'bob');
      },
    },
    {
      name: 'two stores from the same factory share nothing',
      run: async (store, make) => {
        const other = await make();
        const token = await store.create('ann', T0);
        assert.equal(await other.resolve(token, T0 + 1), undefined);
        assert.equal(await other.revokeAllFor('ann'), 0);
        assert.equal(await store.resolve(token, T0 + 1), 'ann');
      },
    },
  ];
}
