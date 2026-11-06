import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type StorageAdapter } from '../graph_store/index.js';
import { createMemoryCircleStore, type CircleRole, type CircleStore } from '../circles/index.js';
import { createMemoryLedgerStore, type LedgerStore } from '../ledger/index.js';
import { circleGraphId } from '../scopes/index.js';
import { createMemoryAgentTokenStore, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createUserController, type AgentTokenStore, type User, type UserController, type UserStore } from '../users/index.js';
import { createAgentView, type AgentView, type AgentViewInit } from './view.js';

export const T0 = 1_700_000_000_000;
export const DAY = 86_400_000;
export const PW = 'correct horse 7 staple';
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
export const cid = (n: number): string => `c${String(n).padStart(16, '0')}`;

export interface AgentWorld {
  users: UserStore;
  controller: UserController;
  graphs: StorageAdapter;
  circles: CircleStore;
  tokens: AgentTokenStore;
  ledger: LedgerStore;
  view: AgentView;
  now: { value: number };
  /** Every graph-store write primitive the view's reads ever called (there should be none). */
  writes: string[];
  register(name: string): Promise<User>;
  /** A circle with its graph, owned by `owner`, with the others joining in the given roles. */
  circle(n: number, owner: User, others?: ReadonlyArray<readonly [User, CircleRole]>): Promise<string>;
  /** A note (one item in one category) written straight into a graph. */
  note(graphId: string, itemId: string, title: string, category: string, categoryName?: string): Promise<void>;
  /** A token for a person, as the person would hold it: returns the bearer text. */
  bearer(user: User, scopes: readonly string[], checks?: boolean, days?: number): Promise<string>;
}

/** Real memory stores and a real user controller, a recording graph adapter, and an agent view over them. */
export function agentWorld(extra: Partial<AgentViewInit> = {}): AgentWorld {
  const inner = createMemoryAdapter();
  const writes: string[] = [];
  const WRITE = /^(?:put|delete)/;
  const graphs = new Proxy(inner, {
    get(target, prop) {
      if (prop !== 'transaction') return (target as unknown as Record<string | symbol, unknown>)[prop];
      return (graphId: string, fn: (tx: unknown) => Promise<unknown>) =>
        target.transaction(graphId, (tx) =>
          fn(
            new Proxy(tx, {
              get(t, p) {
                const v = (t as unknown as Record<string | symbol, unknown>)[p];
                return typeof v === 'function' && typeof p === 'string' && WRITE.test(p) ? (...a: unknown[]) => (writes.push(p), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
              },
            }),
          ),
        );
    },
  }) as StorageAdapter;
  const users = createMemoryUserStore();
  const circles = createMemoryCircleStore();
  const tokens = createMemoryAgentTokenStore();
  const now = { value: T0 };
  const controller = createUserController({ users, sessions: createMemorySessionStore(), agentTokens: tokens, graphAdapter: graphs, hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }), clock: () => now.value });
  const ledger = createMemoryLedgerStore();
  const view = createAgentView({ tokens, users, circles, graphAdapter: graphs, ledger, directory: { get: async (id) => { const u = await users.get(id); return u === undefined ? undefined : { username: u.username, displayName: u.displayName }; } }, mode: 'demo', clock: () => now.value, ...extra });
  let invitations = 0;
  const w: AgentWorld = {
    users,
    controller,
    graphs,
    circles,
    tokens,
    ledger,
    view,
    now,
    writes,
    register: async (name) => {
      const r = await controller.register({ username: name, displayName: `Display ${name}`, password: PW }, { clientKey: 'k' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    },
    circle: async (n, owner, others = []) => {
      await circles.createCircle({ id: cid(n), name: `Circle ${n}`, createdAt: T0 }, owner.id, LIMITS);
      await createGraph(graphs, circleGraphId(cid(n)));
      for (const [person, role] of others) {
        const inviteId = `i${String(++invitations).padStart(16, '0')}`;
        await circles.createInvitation({ id: inviteId, circleId: cid(n), username: person.username, role, invitedBy: owner.id, createdAt: T0, expiresAt: T0 + 1e9 }, LIMITS, T0);
        await circles.acceptInvitation(inviteId, person.id, person.username, T0 + 1, LIMITS);
      }
      return cid(n);
    },
    note: async (graphId, itemId, title, category, categoryName = category) => {
      const r = await write(inner, {
        version: 1,
        kind: 'mutation',
        graphId,
        ops: [
          { op: 'upsertNode', partition: 'category', id: category, data: { name: categoryName } },
          { op: 'upsertNode', partition: 'item', id: itemId, data: { title, summary: `${title} summary` } },
          { op: 'link', item: itemId, category },
        ],
      } as never);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    },
    bearer: async (user, scopes, checks = false, days = 90) => {
      const r = await tokens.create({ userId: user.id, name: 'test agent', scopes, checks, expiresAt: now.value + days * DAY }, now.value);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.token;
    },
  };
  return w;
}
