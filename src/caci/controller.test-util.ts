import { createController } from '../app/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, type StorageAdapter } from '../graph_store/index.js';
import { createDemoModelClient, createLlm, type ModelClient, type ModelRequest } from '../llm/index.js';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController, type UserController } from '../users/index.js';
import { createMemoryCircleStore, type CircleRole, type CircleStore } from '../circles/index.js';
import { circleGraphId, createScopeResolver } from '../scopes/index.js';
import type { LedgerStore } from '../ledger/index.js';
import { createCaciController, type BrainLimits, type CaciController, type CaciLimits, type StatusContextLimits } from './index.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

export const PW = 'correct horse 7 staple';
export const T0 = 1_700_000_000_000;

export interface World {
  caci: CaciController;
  users: UserController;
  graphs: StorageAdapter;
  now: { value: number };
  skew: { value: number };
  modelCalls: ModelRequest[];
  tokens: Record<string, string>;
  graphIds: Record<string, string>;
  /** The circle store behind the scope resolver. */
  circleStore: CircleStore;
  /** Makes a circle (and its graph) owned by `owner`, the others joining in the given roles; returns its id. */
  circle(n: number, owner: string, others?: ReadonlyArray<readonly [string, CircleRole]>): Promise<string>;
}

export async function world(extra: { limits?: CaciLimits & BrainLimits & { status?: StatusContextLimits }; maxScopes?: number; browseAdapter?: (adapter: StorageAdapter) => StorageAdapter; client?: ModelClient; capturePending?: number; mode?: 'demo' | 'anthropic'; people?: string[]; captureAdapter?: (adapter: StorageAdapter) => StorageAdapter; ttlMs?: number; noStatus?: boolean; ledger?: LedgerStore; directory?: boolean | { get(id: string): Promise<{ username: string; displayName: string } | undefined> }; noScopes?: boolean; onLedgerFailure?: (message: string) => void; pulseText?: string } = {}): Promise<World> {
  const now = { value: T0 };
  const graphs = createMemoryAdapter();
  const userStore = createMemoryUserStore();
  const users = createUserController({
    users: userStore,
    sessions: createMemorySessionStore(),
    graphAdapter: graphs,
    hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
    loginThrottle: createLoginThrottle(),
    registrationThrottle: createRegistrationThrottle({ max: 1000 }),
    clock: () => now.value,
  });
  /** Added to the capture controller's clock only, to make it see a proposal as stale before the CaCi controller does. */
  const skew = { value: 0 };
  const modelCalls: ModelRequest[] = [];
  const inner = extra.client ?? createDemoModelClient();
  const client: ModelClient = { complete: (request) => (modelCalls.push(request), inner.complete(request)) };
  const llm = createLlm({ controls: SHIPPED_CONTROLS, client, now: () => now.value });
  const capture = createController({ adapter: extra.captureAdapter?.(graphs) ?? graphs, llm, now: () => now.value + skew.value, ...(extra.capturePending === undefined ? {} : { maxPending: extra.capturePending }), ...(extra.ttlMs === undefined ? {} : { ttlMs: extra.ttlMs }) });
  const circleStore = createMemoryCircleStore();
  const scopes = createScopeResolver({ users, store: circleStore, ...(extra.maxScopes === undefined ? {} : { maxScopes: extra.maxScopes }) });
  const caci = createCaciController({ users, capture, graphAdapter: extra.browseAdapter?.(graphs) ?? graphs, ...(extra.noScopes === true ? {} : { scopes }), ...(extra.noStatus === true ? {} : { llm }), ...(extra.ledger === undefined ? {} : { ledger: extra.ledger }), ...(typeof extra.directory === 'object' ? { directory: extra.directory } : extra.directory === true ? { directory: { get: async (id: string) => { const u = await userStore.get(id); return u === undefined ? undefined : { username: u.username, displayName: u.displayName }; } } } : {}), ...(extra.onLedgerFailure === undefined ? {} : { onLedgerFailure: extra.onLedgerFailure }), ...(extra.pulseText === undefined ? {} : { pulseText: extra.pulseText }), clock: () => now.value, ...(extra.limits === undefined ? {} : { limits: extra.limits }), ...(extra.mode === undefined ? {} : { mode: extra.mode }) });
  const tokens: Record<string, string> = {};
  const graphIds: Record<string, string> = {};
  for (const name of extra.people ?? ['ann', 'bob']) {
    await users.register({ username: name, displayName: name, password: PW }, { clientKey: name });
    const login = await users.login({ username: name, password: PW }, { clientKey: name });
    if (!login.ok) throw new Error('login failed');
    tokens[name] = login.value.token;
    graphIds[name] = login.value.graphId;
  }
  const limits = { maxCirclesPerUser: 100, maxMembersPerCircle: 100, maxOpenInvitationsPerCircle: 100 };
  const uid = (name: string): string => (graphIds[name] as string).slice('user-'.length);
  let invitations = 0;
  const circle: World['circle'] = async (n, owner, others = []) => {
    const id = `c${String(n).padStart(16, '0')}`;
    await circleStore.createCircle({ id, name: `Circle ${n}`, createdAt: T0 }, uid(owner), limits);
    await createGraph(graphs, circleGraphId(id));
    for (const [name, role] of others) {
      const inviteId = `i${String(++invitations).padStart(16, '0')}`;
      await circleStore.createInvitation({ id: inviteId, circleId: id, username: name, role, invitedBy: uid(owner), createdAt: T0, expiresAt: T0 + 1e9 }, limits, T0);
      await circleStore.acceptInvitation(inviteId, uid(name), name, T0 + 1, limits);
    }
    return id;
  };
  return { caci, users, graphs, now, skew, modelCalls, tokens, graphIds, circleStore, circle };
}
export const ownErrorOf = (r: { ok: boolean; error?: unknown }): { code: string; field?: string; retryAfterMs?: number } | undefined => {
  const e = r.error as { source: string; error: { code: string } } | undefined;
  return e?.source === 'caci' ? (e.error as { code: string }) : undefined;
};

