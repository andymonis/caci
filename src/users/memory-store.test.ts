import { describe, expect, it } from 'vitest';
import { createMemoryUserStore } from './memory-store.js';
import { runUserStoreConformance } from './testing/index.js';

runUserStoreConformance(() => createMemoryUserStore(), { describe, it });

describe('memory user store: behaviour specific to this implementation', () => {
  it('refuses a second spelling of a cursor it did give', async () => {
    const store = createMemoryUserStore();
    for (const n of ['a', 'b', 'c']) await store.create({ id: `u000000000000000${n}`, username: `users-${n}`, displayName: n, role: 'user', passwordHash: 'h', createdAt: 1 });
    const page = await store.list({ limit: 1, cursor: null });
    const cursor = page.nextCursor as string;
    expect((await store.list({ limit: 5, cursor })).items.map((u) => u.username)).toEqual(["users-b", "users-c"]);
    // the last character of a base64 cursor can carry bits that decoding ignores: same bytes, different text
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1) as string) ^ 1];
    expect(Buffer.from(twin.slice(1), 'base64url').equals(Buffer.from(cursor.slice(1), 'base64url'))).toBe(true);
    await expect(store.list({ limit: 5, cursor: twin })).rejects.toThrow(RangeError);
  });

  it('is a plain object of async methods', () => {
    const store = createMemoryUserStore();
    for (const method of ['create', 'get', 'getByUsername', 'credentialOf', 'credentialByUsername', 'update', 'delete', 'list', 'count'] as const) {
      expect(typeof store[method]).toBe('function');
    }
  });
});
