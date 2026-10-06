import { describe, expect, it } from 'vitest';
import { createMemorySessionStore } from './memory-session-store.js';
import { DEFAULT_SESSION_OPTIONS, resolveSessionOptions } from './session-store.js';
import { runSessionStoreConformance } from './testing/index.js';
import { hashToken, isWellFormedToken, newSessionToken } from './tokens.js';

runSessionStoreConformance((options) => createMemorySessionStore(options), { describe, it });

describe('tokens', () => {
  it('are 256 random bits as 43 characters, from the random source given', () => {
    const token = newSessionToken(() => new Uint8Array(32).fill(255));
    expect(token).toBe('_'.repeat(42) + '8');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(isWellFormedToken(token)).toBe(true);
    expect(newSessionToken(() => new Uint8Array(32))).toBe('A'.repeat(43));
  });

  it('refuse a random source that gives the wrong amount', () => {
    expect(() => newSessionToken(() => new Uint8Array(16))).toThrow();
  });

  it('are different every time with the real source', () => {
    expect(new Set(Array.from({ length: 1000 }, () => newSessionToken())).size).toBe(1000);
  });

  it('are well formed only when exactly 43 base64url characters in their one canonical spelling', () => {
    const token = newSessionToken();
    expect(isWellFormedToken(token)).toBe(true);
    for (const bad of [token.slice(1), token + 'A', '', ' ' + token.slice(1), token.slice(0, -1) + '+', token.slice(0, -1) + '=', 5, null, undefined]) expect(isWellFormedToken(bad)).toBe(false);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = token.slice(0, -1) + (alphabet[alphabet.indexOf(token.at(-1) as string) ^ 1] as string);
    expect(isWellFormedToken(twin)).toBe(false);
  });

  it('hash to 64 hex characters, always the same for the same token, and not to the token', () => {
    const token = newSessionToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(newSessionToken()));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); // SHA-256 of "abc"
  });
});

describe('session settings', () => {
  it('have the documented defaults', () => {
    expect(DEFAULT_SESSION_OPTIONS).toEqual({ idleMs: 1_800_000, absoluteMs: 604_800_000, renewEveryMs: 60_000, maxPerUser: 20 });
    expect(resolveSessionOptions()).toMatchObject(DEFAULT_SESSION_OPTIONS);
  });

  it.each([
    [{ idleMs: 0 }],
    [{ idleMs: 1.5 }],
    [{ absoluteMs: -1 }],
    [{ renewEveryMs: Number.NaN }],
    [{ maxPerUser: 0 }],
    [{ renewEveryMs: 2_000_000 }],
    [{ idleMs: 700_000_000 }],
  ])('refuse %j', (options) => {
    expect(() => resolveSessionOptions(options)).toThrow(TypeError);
  });
});

describe('memory session store: behaviour specific to this implementation', () => {
  it('uses the random source it is given, so tokens can be made repeatable', async () => {
    const store = createMemorySessionStore({ randomBytes: (n) => new Uint8Array(n).fill(7) });
    expect(await store.create('ann', 0)).toBe(Buffer.alloc(32, 7).toString('base64url'));
  });

  it('refuses nonsense settings when it is made', () => {
    expect(() => createMemorySessionStore({ idleMs: 0 })).toThrow(TypeError);
  });
});
