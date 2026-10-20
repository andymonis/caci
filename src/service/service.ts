import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAccountRoutes, createApiServer, createBrainRoutes, createCaptureRoutes, createCircleRoutes, createInvitationRoutes, createLedgerRoutes, createReadRoutes, createSharingRoutes, createStatusRoutes, createWebRoutes } from '../api/index.js';
import { createController } from '../app/index.js';
import { createCaciController, MAX_NOTE_CHARS, MAX_STATUS_REQUEST_CHARS } from '../caci/index.js';
import { createCircleController } from '../circles/index.js';
import { createSqliteLedgerStore } from '../ledger/sqlite/index.js';
import { afterAccountDeletion, createScopeResolver, reconcileCircleGraphs, withCircleGraphs, type ReconcileReport, type ScopesResult } from '../scopes/index.js';
import { createSharing } from '../sharing/index.js';
import { createSqliteCircleStore } from '../circles/sqlite/index.js';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { createDemoModelClient, createLlm, type ModelClient } from '../llm/index.js';
import { createUserController } from '../users/index.js';
import { createSqliteSessionStore, createSqliteUserStore } from '../users/sqlite/index.js';
import type { ServiceConfig } from './config.js';
import { defaultControlsDir, loadControlsFolder, loadPulseText } from './controls-files.js';
import { defaultWebDir, WEB_FILE_SPECS } from './web-app.js';
import { loadWebFiles } from './web-files.js';

export interface RunningService {
  /** The port actually listening (useful when 0 was asked for). */
  readonly port: number;
  readonly host: string;
  /** The absolute folder holding `graphs.db` and `users.db`. */
  readonly dataDir: string;
  /** The folder the LLM controls were read from (R-012). */
  readonly controlsDir: string;
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
  /** For tests: the folder to read the LLM controls from (R-012), instead of `controls/` beside the code. */
  readonly controlsDir?: string;
  /** For tests: the folder to read the web app's files from, instead of `web/` beside the code. */
  readonly webDir?: string;
  /**
   * Told, with a fixed sentence and no notes or ids, when something that must not fail a request did: recording a change in the
   * change log, or tidying a category. `serve` prints these as warnings.
   */
  readonly onWarning?: (message: string) => void;
  /** For tests: the clock, in milliseconds, used for the change log's time and its retention. */
  readonly clock?: () => number;
  /** Told the outcome of every reconcile of circle records and circle graphs: at start-up and after each account deletion. */
  readonly onReconcile?: (result: ScopesResult<ReconcileReport>) => void;
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
  const controlsDir = options.controlsDir ?? defaultControlsDir();
  const controls = loadControlsFolder(controlsDir); // first of all: a bad controls file must stop the start, naming the file, and leave nothing behind
  if (!controls.ok) throw new Error(`the LLM controls in ${controlsDir} are not valid:\n${controls.error.map((p) => `  - ${p}`).join('\n')}`);
  // the pulse text (R-016 D21) is read here too: a bad or missing file stops the start, naming it
  const pulse = loadPulseText(controlsDir);
  if (!pulse.ok) throw new Error(`the pulse text in ${controlsDir} is not valid:\n${pulse.error.map((p) => `  - ${p}`).join('\n')}`);
  // the controls must allow at least what the API itself accepts, or a valid request would fail inside the LLM component (R-012 D12)
  const { categorise, status } = controls.value;
  const tooLow = [
    ...(categorise.settings.maxTextChars < MAX_NOTE_CHARS ? [`categorise/settings.json: "maxTextChars" is ${categorise.settings.maxTextChars}, below the ${MAX_NOTE_CHARS} characters the service accepts for a note`] : []),
    ...(status.settings.maxRequestChars < MAX_STATUS_REQUEST_CHARS ? [`status/settings.json: "maxRequestChars" is ${status.settings.maxRequestChars}, below the ${MAX_STATUS_REQUEST_CHARS} characters the service accepts for a status request`] : []),
  ];
  if (tooLow.length > 0) throw new Error(`the LLM controls in ${controlsDir} are not valid:\n${tooLow.map((p) => `  - ${p}`).join('\n')}`);
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

    const ledger = createSqliteLedgerStore({ path: join(dataDir, 'users.db') }); // the change log (R-014) lives beside the accounts and circles
    closers.push(() => ledger.close());
    const clock = options.clock ?? Date.now;
    const warn = (message: string): void => {
      try {
        options.onWarning?.(message);
      } catch {
        // an observer must not stop the service
      }
    };
    const DAY = 86_400_000;
    const purge = (): void => void ledger.purgeBefore(clock() - config.ledgerDays * DAY).catch(() => warn('could not remove old entries from the change log'));
    purge(); // at start-up, and once a day
    const purging = setInterval(purge, DAY);
    purging.unref();
    closers.push(() => clearInterval(purging));

    const reconcile = async (): Promise<void> => {
      const result = await reconcileCircleGraphs({ circles: circleStore, graphAdapter: graphs });
      try {
        options.onReconcile?.(result);
      } catch {
        // an observer must not stop the service
      }
    };
    const baseUsers = createUserController({ users, sessions, graphAdapter: graphs, config: { allowRegistration: config.allowRegistration } });
    const controller = afterAccountDeletion(baseUsers, reconcile); // deleting an account can dissolve a circle, which leaves its graph behind
    const llm = createLlm({ client, controls: controls.value }); // one model component for filing notes and for status updates
    const capture = createController({ adapter: graphs, llm, now: clock, onWarning: warn, candidates: controls.value.categorise.settings.maxReplaces > 0 ? {} : false });
    const caci = createCaciController({
      users: controller,
      capture,
      graphAdapter: graphs,
      scopes: createScopeResolver({ users: controller, store: circleStore, maxScopes: config.maxBrainScopes }),
      mode: config.llm,
      llm,
      pulseText: pulse.value,
      limits: { maxPendingPerUser: config.maxPendingPerUser, proposalsPerHour: config.proposalsPerHour, statusPerHour: config.statusPerHour },
      ledger,
      directory: users,
      clock,
      onLedgerFailure: warn,
    });
    const circles = withCircleGraphs(createCircleController({
      users: controller,
      directory: users,
      store: circleStore,
      limits: { maxCirclesPerUser: config.maxCirclesPerUser, maxMembersPerCircle: config.maxMembersPerCircle, invitationDays: config.invitationDays },
    }), graphs);
    await reconcile(); // circles made before circle graphs existed get theirs, and graphs of circles that are gone are dropped
    const sharing = createSharing({ users: controller, directory: users, store: circleStore, graphAdapter: graphs });
    const routes = [
      ...createAccountRoutes({ controller, secureCookies: config.cookieSecure }),
      ...createCaptureRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createReadRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createBrainRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createLedgerRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createStatusRoutes({ caci, secureCookies: config.cookieSecure }),
      ...createCircleRoutes({ circles, secureCookies: config.cookieSecure }),
      ...createInvitationRoutes({ circles, secureCookies: config.cookieSecure }),
      ...createSharingRoutes({ sharing, secureCookies: config.cookieSecure }),
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
    return { port, host: config.bind, dataDir, controlsDir, close: () => (closing ??= closeAll()) };
  } catch (cause) {
    await closeAll();
    throw cause;
  }
}
