import { createSqliteCircleStore, type SqliteCircleStore } from '../circles/sqlite/index.js';
import { createMemoryCircleStore, type CircleRole, type CircleStore } from '../circles/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type StorageAdapter } from '../graph_store/index.js';
import { createSharing, type Sharing, type SharingInit } from './index.js';

export const T0 = 1_700_000_000_000;
export const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
const NAMES = ['ann', 'bob', 'cat', 'dan', 'eve', 'fay'];

export interface World {
  sharing: Sharing;
  store: CircleStore;
  graphs: StorageAdapter;
  now: { value: number };
  token(name: string): string;
  id(name: string): string;
  /** A person's own graph id. */
  graphOf(name: string): string;
  /** Removes a person's account: their session stops working. */
  forget(name: string): void;
  /** Makes a circle owned by `owner`, with the others joining in the given roles; returns its id. */
  circle(n: number, owner: string, others?: ReadonlyArray<readonly [string, CircleRole]>): Promise<string>;
  /** Puts categories (and items filed under them) into a person's own graph. */
  seed(name: string, spec: { categories?: Record<string, string | undefined>; items?: Array<{ id: string; title?: string; under: ReadonlyArray<string | readonly [string, number]> }> }): Promise<void>;
  /** Every operation the graph adapter was asked to perform that writes. */
  writes: string[];
  dispose(): void;
}

export const cid = (n: number | string): string => `c${String(n).padStart(16, '0')}`;
const uid = (n: number): string => `u${String(n).padStart(16, '0')}`;

/** A world with six people, real stores (memory or a SQLite file), a memory graph per person, and a recording graph adapter. */
export async function world(kind: 'memory' | 'sqlite' = 'memory', extra: { limits?: SharingInit['limits']; people?: readonly string[]; store?: CircleStore } = {}): Promise<World> {
  let sqlite: SqliteCircleStore | undefined;
  let store: CircleStore;
  if (extra.store !== undefined) store = extra.store;
  else if (kind === 'sqlite') {
    sqlite = createSqliteCircleStore(); // a private in-memory database
    store = sqlite;
  } else store = createMemoryCircleStore();
  const inner = createMemoryAdapter();
  const writes: string[] = [];
  const graphs: StorageAdapter = {
    ...inner,
    graphs: inner.graphs,
    transaction: (graphId, body) => inner.transaction(graphId, (tx) => body(new Proxy(tx, { get: (target, prop) => { const v = (target as unknown as Record<string, unknown>)[prop as string]; if (typeof v === 'function' && /^(put|delete)/.test(String(prop))) return (...a: unknown[]) => (writes.push(`${String(prop)} ${graphId}`), (v as (...x: unknown[]) => unknown).apply(target, a)); return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v; } }))),
  };
  const now = { value: T0 };
  const people = new Map<string, { id: string; username: string; displayName: string }>();
  for (const [index, name] of (extra.people ?? NAMES).entries()) people.set(name, { id: uid(index + 1), username: name, displayName: `Display ${name}` });
  for (const p of people.values()) await createGraph(inner, `user-${p.id}`);
  const sharing = createSharing({
    users: {
      resolve: async (token: unknown) => {
        const name = typeof token === 'string' && token.startsWith('tok-') ? token.slice(4) : undefined;
        const person = name === undefined ? undefined : people.get(name);
        if (person === undefined) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } as never;
        return { ok: true, value: { user: { ...person, role: 'user', createdAt: 1, updatedAt: 1 }, graphId: `user-${person.id}` } } as never;
      },
    },
    directory: {
      get: async (id: string) => {
        const person = [...people.values()].find((p) => p.id === id);
        return person === undefined ? undefined : ({ ...person, role: 'user', createdAt: 1, updatedAt: 1 } as never);
      },
    },
    store,
    graphAdapter: graphs,
    ...(extra.limits === undefined ? {} : { limits: extra.limits }),
    clock: () => now.value,
  });
  let invitations = 0;
  const w: World = {
    sharing,
    store,
    graphs,
    now,
    token: (name) => `tok-${name}`,
    id: (name) => (people.get(name) as { id: string }).id,
    graphOf: (name) => `user-${(people.get(name) as { id: string }).id}`,
    forget: (name) => void people.delete(name),
    writes,
    circle: async (n, owner, others = []) => {
      await store.createCircle({ id: cid(n), name: `Circle ${n}`, createdAt: T0 }, w.id(owner), LIMITS);
      for (const [name, role] of others) {
        const inviteId = `i${String(++invitations).padStart(16, '0')}`;
        await store.createInvitation({ id: inviteId, circleId: cid(n), username: name, role, invitedBy: w.id(owner), createdAt: T0, expiresAt: T0 + 1e9 }, LIMITS, T0);
        await store.acceptInvitation(inviteId, w.id(name), name, T0 + 1, LIMITS);
      }
      return cid(n);
    },
    seed: async (name, spec) => {
      const ops: unknown[] = [];
      for (const [id, label] of Object.entries(spec.categories ?? {})) ops.push({ op: 'upsertNode', partition: 'category', id, ...(label === undefined ? {} : { data: { name: label } }) });
      for (const item of spec.items ?? []) {
        ops.push({ op: 'upsertNode', partition: 'item', id: item.id, data: { title: item.title ?? `Title of ${item.id}`, summary: `Summary of ${item.id}` } });
        for (const under of item.under) {
          const [category, weight] = typeof under === 'string' ? [under, undefined] : under;
          ops.push({ op: 'link', item: item.id, category, ...(weight === undefined ? {} : { weight }) });
        }
      }
      const r = await write(inner, { version: 1, kind: 'mutation', graphId: w.graphOf(name), ops } as never);
      if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
    },
    dispose: () => {
      sqlite?.close();
    },
  };
  return w;
}
