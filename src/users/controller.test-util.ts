import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { listGraphs, type StorageAdapter } from '../graph_store/index.js';
import { createUserController, type UserController } from './controller.js';
import { createMemorySessionStore } from './memory-session-store.js';
import { createMemoryUserStore } from './memory-store.js';
import { createPasswordHasher, type Derive } from './password.js';
import type { SessionStore } from './session-store.js';
import type { UserStore } from './store.js';
import { createLoginThrottle, createRegistrationThrottle } from './throttle.js';

export const PW = 'correct horse 7 staple';
export const CTX = { clientKey: 'client-1' };
export const T0 = 1_700_000_000_000;

export interface World {
  users: UserStore;
  sessions: SessionStore;
  graphs: StorageAdapter;
  controller: UserController;
  now: { value: number };
  derived: string[];
}

export function world(extra: { users?: UserStore; graphs?: StorageAdapter; config?: { allowRegistration?: boolean }; hasherParams?: { N: number; r: number; p: number }; reuse?: Pick<World, 'users' | 'sessions' | 'graphs'> } = {}): World {
  const users = extra.reuse?.users ?? extra.users ?? createMemoryUserStore();
  const sessions = extra.reuse?.sessions ?? createMemorySessionStore();
  const graphs = extra.reuse?.graphs ?? extra.graphs ?? createMemoryAdapter();
  const now = { value: T0 };
  const derived: string[] = [];
  const derive: Derive = async (password, salt, params, bytes) => {
    derived.push(`${params.N}`);
    return Buffer.alloc(bytes, (password.length + params.N) % 251);
  };
  let n = 0;
  const controller = createUserController({
    users,
    sessions,
    graphAdapter: graphs,
    hasher: createPasswordHasher({ params: extra.hasherParams ?? { N: 16, r: 1, p: 1 }, derive, randomBytes: (len) => new Uint8Array(len).fill(++n % 250) }),
    loginThrottle: createLoginThrottle(),
    registrationThrottle: createRegistrationThrottle(),
    clock: () => now.value,
    ...(extra.config === undefined ? {} : { config: extra.config }),
    newUserId: (() => {
      let id = 0;
      return () => `u${String(++id).padStart(16, '0')}`;
    })(),
  });
  return { users, sessions, graphs, controller, now, derived };
}
export const reg = (controller: UserController, name: string, extra: object = {}, ctx = CTX) => controller.register({ username: name, displayName: `Display ${name}`, password: PW, ...extra }, ctx);
export const must = async <T>(promise: Promise<{ ok: boolean; value?: T; error?: unknown }>): Promise<T> => {
  const r = await promise;
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
export const graphIds = async (graphs: StorageAdapter): Promise<string[]> => {
  const r = await listGraphs(graphs);
  return r.ok ? [...r.value.items] : [];
};

