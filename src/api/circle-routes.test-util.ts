import { request as httpRequest } from 'node:http';
import { createCircleController, createMemoryCircleStore, type CircleController, type CircleStore } from '../circles/index.js';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController } from '../users/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createCircleRoutes } from './circle-routes.js';
import { createAccountRoutes } from './routes.js';
import { createApiServer, type ApiServer } from './server.js';
import type { Route } from './router.js';

export const PW = 'correct horse 7 staple';
export const COOKIE = 'caci_session';
export const T0 = 1_700_000_000_000;
/** Every response body of the circle routes, for the final scan. */
export const seen: string[] = [];
/** Things that must never appear in a response: passwords and session tokens. */
export const secrets = new Set<string>([PW]);

export interface CircleApp {
  api: ApiServer;
  port: number;
  now: { value: number };
  store: CircleStore;
  circles: CircleController;
  /** user ids by username, filled by `signIn`. */
  ids: Record<string, string>;
}

export async function startCircleApp(extra: { store?: CircleStore; limits?: Parameters<typeof createCircleController>[0]['limits']; secure?: boolean; more?: (app: { circles: CircleController; now: { value: number } }) => readonly Route[] } = {}): Promise<CircleApp> {
  const now = { value: T0 };
  const userStore = createMemoryUserStore();
  const users = createUserController({
    users: userStore,
    sessions: createMemorySessionStore(),
    graphAdapter: createMemoryAdapter(),
    hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
    loginThrottle: createLoginThrottle(),
    registrationThrottle: createRegistrationThrottle({ max: 1000 }),
    clock: () => now.value,
  });
  const store = extra.store ?? createMemoryCircleStore();
  const circles = createCircleController({ users, directory: userStore, store, clock: () => now.value, ...(extra.limits === undefined ? {} : { limits: extra.limits }) });
  const secureCookies = extra.secure ?? false;
  const api = createApiServer({ routes: [...createAccountRoutes({ controller: users, secureCookies }), ...createCircleRoutes({ circles, secureCookies }), ...(extra.more?.({ circles, now }) ?? [])] });
  const port = await api.listen(0);
  return { api, port, now, store, circles, ids: {} };
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string | undefined;
}

export function call(port: number, method: string, path: string, { body, token, headers = {} }: { body?: unknown; token?: string | undefined; headers?: Record<string, string> } = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const sent: Record<string, string> = { ...headers };
  if (payload !== undefined) {
    sent['content-type'] ??= 'application/json';
    sent['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token !== undefined) sent.cookie = `${COOKIE}=${token}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (path.startsWith('/api/circles')) seen.push(text);
        const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE}=`));
        const value = setCookie?.split(';')[0]?.slice(COOKIE.length + 1);
        if (value) secrets.add(value);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: text === '' ? undefined : JSON.parse(text), cookie: setCookie });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Registers and signs in over HTTP; returns the session token and remembers the user id. */
export async function signIn(app: CircleApp, name: string): Promise<string> {
  const registered = await call(app.port, 'POST', '/api/register', { body: { username: name, displayName: `Display ${name}`, password: PW } });
  app.ids[name] = registered.json.user.id;
  const login = await call(app.port, 'POST', '/api/login', { body: { username: name, password: PW } });
  return login.cookie?.split(';')[0]?.slice(COOKIE.length + 1) as string;
}

let counter = 0;
/** Puts a person into a circle through the store (the invitation routes have their own tests). */
export async function addMember(app: CircleApp, circleId: string, name: string, role: 'owner' | 'manager' | 'member' | 'observer'): Promise<void> {
  const id = `i${String(++counter).padStart(16, '0')}`;
  const limits = { maxCirclesPerUser: 1000, maxMembersPerCircle: 1000, maxOpenInvitationsPerCircle: 1000 };
  const made = await app.store.createInvitation({ id, circleId, username: name, role, invitedBy: app.ids.ann ?? 'x', createdAt: T0, expiresAt: T0 + 1e9 }, limits, T0);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const joined = await app.store.acceptInvitation(id, app.ids[name] as string, name, T0, limits);
  if (!joined.ok) throw new Error(JSON.stringify(joined.error));
}
