import { createController } from '../app/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import type { StorageAdapter } from '../graph_store/index.js';
import { createDemoModelClient, createLlm, type ModelClient, type ModelRequest } from '../llm/index.js';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController, type UserController } from '../users/index.js';
import { createCaciController, type CaciController, type CaciLimits } from './index.js';

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
}

export async function world(extra: { limits?: CaciLimits; client?: ModelClient; capturePending?: number; mode?: 'demo' | 'anthropic'; people?: string[]; captureAdapter?: (adapter: StorageAdapter) => StorageAdapter; ttlMs?: number } = {}): Promise<World> {
  const now = { value: T0 };
  const graphs = createMemoryAdapter();
  const users = createUserController({
    users: createMemoryUserStore(),
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
  const capture = createController({ adapter: extra.captureAdapter?.(graphs) ?? graphs, llm: createLlm({ client }), now: () => now.value + skew.value, ...(extra.capturePending === undefined ? {} : { maxPending: extra.capturePending }), ...(extra.ttlMs === undefined ? {} : { ttlMs: extra.ttlMs }) });
  const caci = createCaciController({ users, capture, clock: () => now.value, ...(extra.limits === undefined ? {} : { limits: extra.limits }), ...(extra.mode === undefined ? {} : { mode: extra.mode }) });
  const tokens: Record<string, string> = {};
  const graphIds: Record<string, string> = {};
  for (const name of extra.people ?? ['ann', 'bob']) {
    await users.register({ username: name, displayName: name, password: PW }, { clientKey: name });
    const login = await users.login({ username: name, password: PW }, { clientKey: name });
    if (!login.ok) throw new Error('login failed');
    tokens[name] = login.value.token;
    graphIds[name] = login.value.graphId;
  }
  return { caci, users, graphs, now, skew, modelCalls, tokens, graphIds };
}
export const ownErrorOf = (r: { ok: boolean; error?: unknown }): { code: string; field?: string; retryAfterMs?: number } | undefined => {
  const e = r.error as { source: string; error: { code: string } } | undefined;
  return e?.source === 'caci' ? (e.error as { code: string }) : undefined;
};

