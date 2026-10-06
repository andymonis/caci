import { describe, expect, it } from 'vitest';
import { createGraph, describeGraph } from '../graph_store/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { isUserId, newUserId, USER_ID_PATTERN, userGraphId } from './ids.js';

const fixed = (bytes: number[]) => {
  let at = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => bytes[at++ % bytes.length] as number);
};

describe('user ids', () => {
  it('are u and 16 lowercase letters or digits', () => {
    for (let i = 0; i < 1000; i++) expect(newUserId()).toMatch(/^u[a-z0-9]{16}$/);
  });

  it('are not repeated across 10,000 draws', () => {
    expect(new Set(Array.from({ length: 10_000 }, () => newUserId())).size).toBe(10_000);
  });

  it('turn random bytes into characters by position in 0-9a-z, and are the same for the same bytes', () => {
    expect(newUserId(fixed([0, 1, 2, 9, 10, 11, 35, 36, 37, 71, 72, 73, 100, 150, 200, 251]))).toBe('u0129abz01z01s6kz');
    expect(newUserId(fixed([5]))).toBe(newUserId(fixed([5])));
  });

  it('skips bytes of 252 and above, so every character is equally likely', () => {
    expect(newUserId(fixed([252, 253, 254, 255, 0]))).toBe('u' + '0'.repeat(16));
    const all = Array.from({ length: 252 }, (_, i) => i);
    // a full pass over 0..251 gives each of the 36 characters exactly 7 times
    const seen: Record<string, number> = {};
    for (const byte of all) seen['0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36] as string] = (seen['0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36] as string] ?? 0) + 1;
    expect(new Set(Object.values(seen))).toEqual(new Set([7]));
  });

  it('keeps asking for bytes until it has enough', () => {
    let calls = 0;
    const id = newUserId(() => {
      calls++;
      return new Uint8Array([255, 255, 3]); // one usable byte per call
    });
    expect(id).toBe('u' + '3'.repeat(16));
    expect(calls).toBe(16);
  });

  it('are recognised by isUserId, and nothing else is', () => {
    expect(isUserId(newUserId())).toBe(true);
    expect(isUserId('u3k9d2x7q0m5a1bz7')).toBe(true);
    for (const bad of ['', 'u', 'U3k9d2x7q0m5a1bz', 'u3k9d2x7q0m5a1b', 'u3k9d2x7q0m5a1bz7z', 'x3k9d2x7q0m5a1bz', 'u3k9d2x7q0m5a1bz-', 'u3k9d2x7q0m5a1bz\n', 5, null, undefined, {}]) expect(isUserId(bad)).toBe(false);
    expect(USER_ID_PATTERN.test('u0000000000000000')).toBe(true);
  });
});

describe('the graph of a user', () => {
  it('is user- plus the user id, the same every time', () => {
    expect(userGraphId('u3k9d2x7q0m5a1bz7')).toBe('user-u3k9d2x7q0m5a1bz7');
    expect(userGraphId('u3k9d2x7q0m5a1bz7')).toBe(userGraphId('u3k9d2x7q0m5a1bz7'));
  });

  it('is different for different users', () => {
    expect(userGraphId(newUserId())).not.toBe(userGraphId(newUserId()));
  });

  it('is accepted by the graph store as a graph id, for 10,000 random users', async () => {
    const adapter = createMemoryAdapter();
    for (let i = 0; i < 10_000; i++) {
      const graphId = userGraphId(newUserId());
      expect(graphId).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
      if (i < 200) expect(await createGraph(adapter, graphId)).toMatchObject({ ok: true }); // the real validator agrees
    }
    expect(await describeGraph(adapter, userGraphId('u0000000000000000'))).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('throws for something that is not a user id', () => {
    for (const bad of ['', 'x', '../etc', 'u3k9d2x7q0m5a1bz7/../x', 'U3K9D2X7Q0M5A1BZ', 5 as unknown as string]) expect(() => userGraphId(bad)).toThrow(TypeError);
  });
});
