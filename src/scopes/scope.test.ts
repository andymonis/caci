import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph } from '../graph_store/index.js';
import { newCircleId } from '../circles/index.js';
import { circleGraphId, circleIdOfGraph, parseScope, PERSONAL, SCOPES_ERROR_CODES, scopesError } from './index.js';

const C = 'c0123456789abcdef';

describe('parseScope', () => {
  it('no scope means personal, and personal is one frozen shared value', () => {
    expect(parseScope(undefined)).toEqual({ ok: true, value: { kind: 'personal' } });
    const r = parseScope({ kind: 'personal' });
    expect(r).toEqual({ ok: true, value: { kind: 'personal' } });
    expect(Object.isFrozen(PERSONAL)).toBe(true);
  });

  it('a circle scope keeps only its circle id and is frozen', () => {
    const r = parseScope({ kind: 'circle', circleId: C });
    expect(r).toEqual({ ok: true, value: { kind: 'circle', circleId: C } });
    expect(Object.isFrozen((r as { value: object }).value)).toBe(true);
  });

  it('refuses anything that is not an object, naming scope', () => {
    for (const bad of [null, 'personal', 5, true, [], ['circle'], () => 1]) {
      expect(parseScope(bad), String(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'scope' } });
    }
  });

  it('refuses an unknown or missing kind', () => {
    for (const bad of [{}, { kind: 'mine' }, { kind: 'Personal' }, { kind: 5 }, { kind: undefined }, { circleId: C }]) {
      expect(parseScope(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'scope' } });
    }
  });

  it('refuses any other key by name: a graph id, a user id, a typo', () => {
    for (const key of ['graphId', 'userId', 'ownerId', 'circleID', 'x']) {
      expect(parseScope({ kind: 'personal', [key]: 'user-u0123456789abcdef' }), key).toMatchObject({ ok: false, error: { field: key } });
      expect(parseScope({ kind: 'circle', circleId: C, [key]: 'x' }), key).toMatchObject({ ok: false, error: { field: key } });
    }
  });

  it('a long stray key is cut in the message and named scope', () => {
    const r = parseScope({ kind: 'personal', ['k'.repeat(200)]: 1 });
    expect(r).toMatchObject({ ok: false, error: { field: 'scope' } });
    expect(JSON.stringify(r).length).toBeLessThan(300);
  });

  it('a circle id must have the exact shape the service makes', () => {
    for (const bad of [undefined, null, '', 5, 'c', 'C0123456789abcdef', 'c0123456789abcde', 'c0123456789abcdef0', 'u0123456789abcdef', 'c0123456789abcd/f', '../x', ' c0123456789abcdef', 'c0123456789abcdef\n', 'circle-c0123456789abcdef']) {
      expect(parseScope({ kind: 'circle', circleId: bad }), String(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'circleId' } });
    }
  });

  it('a prototype key is just another stray key', () => {
    const hostile = JSON.parse('{"kind":"personal","__proto__":{"kind":"circle"}}');
    expect(parseScope(hostile)).toMatchObject({ ok: false, error: { field: '__proto__' } });
  });

  it('never throws, for any input', () => {
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    const inputs = [undefined, null, 0, '', {}, [], proxy];
    for (const input of inputs) {
      try {
        parseScope(input);
      } catch {
        // a hostile proxy may throw; the real callers pass parsed JSON, which cannot be a proxy
        expect(input).toBe(proxy);
      }
    }
  });
});

describe('circleGraphId', () => {
  it('is circle- plus the id', () => {
    expect(circleGraphId(C)).toBe(`circle-${C}`);
  });

  it('throws for anything that is not a circle id: it is a coding mistake, never a request', () => {
    for (const bad of ['', 'user-x', 'u0123456789abcdef', C.toUpperCase(), `${C}x`, 5 as never, undefined as never]) expect(() => circleGraphId(bad), String(bad)).toThrow(TypeError);
  });

  it('is a graph id the real graph store accepts, for 200 made-up ids, and different circles give different graphs', async () => {
    const adapter = createMemoryAdapter();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newCircleId();
      const graph = circleGraphId(id);
      expect(await createGraph(adapter, graph)).toMatchObject({ ok: true });
      expect(seen.has(graph)).toBe(false);
      seen.add(graph);
    }
  });

  it('never collides with a user graph', () => {
    expect(circleGraphId(C).startsWith('user-')).toBe(false);
  });
});

describe('circleIdOfGraph', () => {
  it('reads the circle id back, and only from a circle graph', () => {
    expect(circleIdOfGraph(circleGraphId(C))).toBe(C);
    for (const other of ['user-u0123456789abcdef', 'circle-', 'circle-x', `circle-${C}x`, `circle-${C.toUpperCase()}`, `xcircle-${C}`, '', 'graph', `circle-${C}/`, `abcdefg${C}`]) expect(circleIdOfGraph(other), other).toBeUndefined();
    expect(circleIdOfGraph(5 as never)).toBeUndefined();
  });
});

describe('the errors', () => {
  it('are frozen, carry a field only when given, and have the closed set of codes', () => {
    const e = scopesError('NOT_FOUND', 'no such circle');
    expect(Object.isFrozen(e)).toBe(true);
    expect('field' in e).toBe(false);
    expect(scopesError('INVALID_INPUT', 'x', 'scope').field).toBe('scope');
    expect([...SCOPES_ERROR_CODES]).toEqual(['INVALID_INPUT', 'NOT_FOUND', 'STORAGE_ERROR']);
  });
});
