import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAccountRoutes, createApiServer } from '../api/index.js';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { createUserController } from '../users/index.js';
import { createSqliteSessionStore, createSqliteUserStore } from '../users/sqlite/index.js';
import type { ServiceConfig } from './config.js';

export interface RunningService {
  /** The port actually listening (useful when 0 was asked for). */
  readonly port: number;
  readonly host: string;
  /** The absolute folder holding `graphs.db` and `users.db`. */
  readonly dataDir: string;
  /** Stops listening, then closes both databases. Safe to call twice. */
  close(): Promise<void>;
}

export interface ServiceOptions {
  /** Called after every request with method, path (no query), status and time. */
  readonly log?: (event: { readonly method: string; readonly path: string; readonly status: number; readonly ms: number }) => void;
}

/**
 * Starts the service: opens (creating, owner-only) the two databases in the data folder, builds the
 * stores, the controller and the HTTP server, and listens. If anything fails part-way everything
 * already opened is closed again, and the error says what was wrong.
 */
export async function startService(config: ServiceConfig, options: ServiceOptions = {}): Promise<RunningService> {
  const dataDir = resolve(config.dataDir);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!statSync(dataDir).isDirectory()) throw new Error('is not a folder');
  } catch (cause) {
    throw new Error(`cannot use the data folder "${dataDir}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  const closers: Array<() => Promise<void> | void> = [];
  const closeAll = async (): Promise<void> => {
    for (const close of closers.splice(0).reverse()) await close();
  };
  try {
    const graphs = createSqliteAdapter({ path: join(dataDir, 'graphs.db') });
    closers.push(() => graphs.close());
    const users = createSqliteUserStore({ path: join(dataDir, 'users.db') });
    closers.push(() => users.close());
    const sessions = createSqliteSessionStore({ path: join(dataDir, 'users.db') });
    closers.push(() => sessions.close());

    const controller = createUserController({ users, sessions, graphAdapter: graphs, config: { allowRegistration: config.allowRegistration } });
    const routes = createAccountRoutes({ controller, secureCookies: config.cookieSecure });
    const api = createApiServer({
      routes,
      host: config.bind,
      trustedProxies: config.trustedProxies,
      ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    const port = await api.listen(config.port).catch((cause: unknown) => {
      const code = (cause as { code?: string }).code;
      throw new Error(code === 'EADDRINUSE' ? `port ${config.port} on ${config.bind} is already in use` : `cannot listen on ${config.bind}:${config.port}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    });
    closers.push(() => api.close());

    let closing: Promise<void> | undefined;
    return { port, host: config.bind, dataDir, close: () => (closing ??= closeAll()) };
  } catch (cause) {
    await closeAll();
    throw cause;
  }
}
