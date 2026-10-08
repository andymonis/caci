import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAccountRoutes, createApiServer, createCaptureRoutes, createCircleRoutes, createInvitationRoutes, createReadRoutes, createWebRoutes } from '../api/index.js';
import { createController } from '../app/index.js';
import { createCaciController } from '../caci/index.js';
import { createCircleController } from '../circles/index.js';
import { createSqliteCircleStore } from '../circles/sqlite/index.js';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { createDemoModelClient, createLlm, type ModelClient } from '../llm/index.js';
import { createUserController } from '../users/index.js';
import { createSqliteSessionStore, createSqliteUserStore } from '../users/sqlite/index.js';
import type { ServiceConfig } from './config.js';
import { defaultWebDir, WEB_FILE_SPECS } from './web-app.js';
import { loadWebFiles } from './web-files.js';

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
  /** The Anthropic API key, needed when `config.llm` is `anthropic` (the caller reads it from the environment; it is held by the client and goes nowhere else). */
  readonly apiKey?: string;
  /** For tests: how the real client talks to the provider, so that a stand-in provider can answer. */
  readonly anthropic?: { readonly fetch?: typeof fetch };
  /** For tests: a model client to use instead of the demo or the Anthropic one. */
  readonly llmClient?: ModelClient;
  /** For tests: the folder to read the web app's files from, instead of `web/` beside the code. */
  readonly webDir?: string;
}

/** The model that files notes: the one given, the free demo one, or (only when asked for, so the provider's SDK is not needed otherwise) the real one. */
async function modelFor(config: ServiceConfig, options: ServiceOptions): Promise<ModelClient> {
  if (options.llmClient !== undefined) return options.llmClient;
  if (config.llm === 'demo') return createDemoModelClient();
  if (options.apiKey === undefined) throw new Error('the real model needs its API key (ANTHROPIC_API_KEY)');
  const { createAnthropicClient } = await import('../llm/anthropic/index.js');
  return createAnthropicClient({ apiKey: options.apiKey, ...(options.anthropic?.fetch === undefined ? {} : { fetch: options.anthropic.fetch }) });
}

/**
 * Starts the service: opens (creating, owner-only) the two databases (`users.db` holds the accounts, the sessions and the circles) in the data folder, builds the
 * stores, the controller and the HTTP server, and listens. If anything fails part-way everything
 * already opened is closed again, and the error says what was wrong.
 */
export async function startService(config: ServiceConfig, options: ServiceOptions = {}): Promise<RunningService> {
  const client = await modelFor(config, options); // first, before any folder or file is made: a missing key must leave nothing behind
  const webFiles = loadWebFiles(options.webDir ?? defaultWebDir(), WEB_FILE_SPECS); // also before any file is made: a missing web file must leave nothing behind
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
    const circleStore = createSqliteCircleStore({ path: join(dataDir, 'users.db') }); // circles live beside the accounts, so deleting an account can remove its places in the same transaction
    closers.push(() => circleStore.close());

    const controller = createUserController({ users, sessions, graphAdapter: graphs, config: { allowRegistration: config.allowRegistration } });
    const capture = createController({ adapter: graphs, llm: createLlm({ client }) });
    const caci = createCaciController({
      users: controller,
      capture,
      graphAdapter: graphs,
      mode: config.llm,
      limits: { maxPendingPerUser: config.maxPendingPerUser, proposalsPerHour: config.proposalsPerHour },
    });
    const circles = createCircleController({
      users: controller,
      directory: users,
      store: circleStore,
      limits: { maxCirclesPerUser: config.maxCirclesPerUser, maxMembersPerCircle: config.maxMembersPerCircle, invitationDays: config.invitationDays },
    });
    const routes = [
      ...createAccountRoutes({ controller, secureCookies: config.cookieSecure }),
      ...createCaptureRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createReadRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createCircleRoutes({ circles, secureCookies: config.cookieSecure }),
      ...createInvitationRoutes({ circles, secureCookies: config.cookieSecure }),
      ...createWebRoutes({ files: webFiles }),
    ];
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
