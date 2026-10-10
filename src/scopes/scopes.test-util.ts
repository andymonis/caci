import { createSqliteCircleStore, type SqliteCircleStore } from '../circles/sqlite/index.js';
import { createMemoryCircleStore, type CircleRole, type CircleStore } from '../circles/index.js';

export const T0 = 1_700_000_000_000;
export const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
const NAMES = ['ann', 'bob', 'cat', 'dan', 'eve'];
export const cid = (n: number | string): string => `c${String(n).padStart(16, '0')}`;
const uid = (n: number): string => `u${String(n).padStart(16, '0')}`;

export interface World {
  store: CircleStore;
  /** A fake user controller: a token is `tok-<name>`, and `forget` makes the account stop working. */
  users: { resolve(token: unknown): Promise<never> };
  token(name: string): string;
  id(name: string): string;
  forget(name: string): void;
  /** Makes a circle owned by `owner` with the others joining in the given roles. */
  circle(n: number, owner: string, others?: ReadonlyArray<readonly [string, CircleRole]>): Promise<string>;
  /** Every call the store was asked to make. */
  calls: string[];
  dispose(): void;
}

/** Five people, a real circle store (memory or an in-memory SQLite database) that records its calls, and a fake session check. */
export function world(kind: 'memory' | 'sqlite' = 'memory'): World {
  let sqlite: SqliteCircleStore | undefined;
  let inner: CircleStore;
  if (kind === 'sqlite') {
    sqlite = createSqliteCircleStore();
    inner = sqlite;
  } else inner = createMemoryCircleStore();
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as CircleStore;
  const people = new Map<string, { id: string; username: string; displayName: string }>();
  NAMES.forEach((name, i) => people.set(name, { id: uid(i + 1), username: name, displayName: `Display ${name}` }));
  let invitations = 0;
  const users = {
    resolve: async (token: unknown) => {
      const name = typeof token === 'string' && token.startsWith('tok-') ? token.slice(4) : undefined;
      const person = name === undefined ? undefined : people.get(name);
      if (person === undefined) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } as never;
      return { ok: true, value: { user: { ...person, role: 'user', createdAt: 1, updatedAt: 1 }, graphId: `user-${person.id}` } } as never;
    },
  };
  const w: World = {
    store,
    users,
    token: (name) => `tok-${name}`,
    id: (name) => (people.get(name) as { id: string }).id,
    forget: (name) => void people.delete(name),
    calls,
    circle: async (n, owner, others = []) => {
      await inner.createCircle({ id: cid(n), name: `Circle ${n}`, createdAt: T0 }, w.id(owner), LIMITS);
      for (const [name, role] of others) {
        const inviteId = `i${String(++invitations).padStart(16, '0')}`;
        await inner.createInvitation({ id: inviteId, circleId: cid(n), username: name, role, invitedBy: w.id(owner), createdAt: T0, expiresAt: T0 + 1e9 }, LIMITS, T0);
        await inner.acceptInvitation(inviteId, w.id(name), name, T0 + 1, LIMITS);
      }
      return cid(n);
    },
    dispose: () => {
      sqlite?.close();
    },
  };
  return w;
}
