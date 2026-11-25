import type { Controller } from '../app/index.js';
import { createCaciController, type CaciController, type CaciControllerInit, type UsageRecorder, type Verbs } from '../caci/index.js';
import type { ResolutionStore } from '../resolutions/index.js';
import type { CircleStore } from '../circles/index.js';
import { err, ok, type Result, type StorageAdapter } from '../graph_store/index.js';
import type { Llm } from '../llm/index.js';
import type { LedgerStore } from '../ledger/index.js';
import { createScopeResolver, scopesError, type ResolvedScope, type Scope, type ScopeResolver } from '../scopes/index.js';
import type { Authenticated, AgentTokenAccess, AgentTokenStore, UserStore, UsersError } from '../users/index.js';
import { userGraphId } from '../users/index.js';

/**
 * The only methods of the CaCi controller an agent can reach (R-022 D7, D13): everything that reads, nothing that writes. `status`
 * (the model-using checks) is wrapped so that it is refused unless the token was made with the checks flag.
 */
export type AgentReadApi = Pick<CaciController, 'brainScopes' | 'mineSummary' | 'mineCategories' | 'mineCategoryItems' | 'mineItem' | 'summary' | 'categories' | 'categoryItems' | 'item' | 'ledger' | 'source' | 'searchFacts' | 'changes' | 'status'>;

/**
 * The only methods of the CaCi controller the verb tools reach (R-025 D13), and only for a token made with the resolve flag: they write the
 * person's own resolution record, or delete a fact in their own brain for the verb `clear`; nothing here edits a circle brain.
 */
export type AgentResolveApi = Pick<CaciController, 'verbs' | 'resolveFact' | 'unresolveFact' | 'resolutions'>;

export interface AgentViewInit {
  readonly tokens: Pick<AgentTokenStore, 'resolve'>;
  /** Only `get`: a token names a person by id, and this finds the account (a deleted one ends the token's use). */
  readonly users: Pick<UserStore, 'get'>;
  readonly circles: Pick<CircleStore, 'membershipOf' | 'getCircle' | 'listCirclesOf'>;
  readonly graphAdapter: StorageAdapter;
  readonly ledger?: LedgerStore;
  readonly directory?: CaciControllerInit['directory'];
  readonly llm?: Pick<Llm, 'status'>;
  readonly checkTexts?: CaciControllerInit['checkTexts'];
  readonly pulseText?: string;
  readonly mode?: 'demo' | 'anthropic';
  readonly limits?: CaciControllerInit['limits'];
  readonly maxScopes?: number;
  readonly clock?: () => number;
  /** Usage metering (R-024): an agent's pulse calls CaCi's model, so it is recorded as an `agent-check`, charged to the token's person. */
  readonly usage?: UsageRecorder;
  /** The verb vocabulary and the resolution store (R-025): without both, the verb tools answer "not available" even for a token with the flag. */
  readonly verbs?: Verbs;
  readonly resolutions?: ResolutionStore;
  /** Deletes a fact in a person's own graph (the capture controller's `remove`): the one write a `clear` can make for an agent, and only in the token's person's own brain. */
  readonly removeFact?: Controller['remove'];
}

export interface AgentView {
  /** What a live token stands for, or `undefined` for anything else (malformed, unknown, revoked, expired, or a person who is gone). */
  access(bearer: unknown): Promise<AgentTokenAccess | undefined>;
  /** The read tools. Every call takes the same bearer token. */
  readonly read: AgentReadApi;
  /** The verb tools (R-025 D13): each refuses unless the token was made with the resolve flag. */
  readonly resolve: AgentResolveApi;
}

/**
 * The one delete an agent can make (R-025 D13): `remove` of the capture controller, but only in a graph named `user-...` (a person's own brain).
 * A circle's graph is refused here whatever asks, so even a mistake higher up could not let an agent change a circle's notes.
 */
export function ownBrainOnly(removeFact: Controller['remove']): Controller['remove'] {
  return (graphId, id) => (typeof graphId === 'string' && graphId.startsWith('user-') ? removeFact(graphId, id) : Promise.reject(new Error('agent access cannot change a circle brain')));
}

const notSignedIn = (): UsersError => ({ code: 'UNAUTHENTICATED', message: 'not signed in' });
const keyOf = (scope: Scope): string => (scope.kind === 'personal' ? 'personal' : `circle:${scope.circleId}`);

/**
 * An agent's view of the brains: **the same CaCi controller** the app uses, built over a token-based user lookup and a resolver that
 * allows only the token's scopes and only reading. A call resolves the token to its person and then to a scope the token lists *and*
 * the person may still read now (membership and role are read afresh every call), so no read rule is new. Anything outside the
 * token is the same "no such circle" a stranger gets. Nothing here can write: there is no capture to call, and the resolver refuses
 * the capture action (R-022 D13).
 */
export function createAgentView(init: AgentViewInit): AgentView {
  if (typeof init?.tokens?.resolve !== 'function' || typeof init.users?.get !== 'function' || init.circles === undefined || init.graphAdapter === undefined) {
    throw new TypeError('createAgentView needs tokens (resolve), users (get), circles and a graph adapter');
  }
  const clock = init.clock ?? Date.now;
  const { tokens, users } = init;

  const accessOf = async (bearer: unknown): Promise<AgentTokenAccess | undefined> => {
    if (typeof bearer !== 'string') return undefined;
    const access = await tokens.resolve(bearer, clock());
    if (access === undefined) return undefined;
    return (await users.get(access.userId)) === undefined ? undefined : access; // the account is gone: so is the access
  };

  /** What `resolve` of the user controller gives the scope resolver and the controller: the person behind a token. */
  const agentUsers = {
    resolve: async (bearer: unknown): Promise<Result<Authenticated, UsersError>> => {
      const access = await accessOf(bearer);
      const user = access === undefined ? undefined : await users.get(access.userId);
      return user === undefined ? err(notSignedIn()) : ok({ user, graphId: userGraphId(user.id) });
    },
  };

  const inner = createScopeResolver({ users: agentUsers as never, store: init.circles, ...(init.maxScopes === undefined ? {} : { maxScopes: init.maxScopes }) });
  const allowed = async (bearer: unknown): Promise<ReadonlySet<string> | undefined> => {
    const access = await accessOf(bearer);
    return access === undefined ? undefined : new Set(access.scopes);
  };
  const restricted: ScopeResolver = {
    who: (bearer) => inner.who(bearer),
    resolve: async (bearer, scope, action) => {
      if (action !== 'read') return { ok: false, error: scopesError('NOT_FOUND', 'no such circle') }; // an agent never captures
      const set = await allowed(bearer);
      if (set === undefined) return inner.resolve(bearer, scope, action); // not a live token: the resolver says so in its own way
      if (!set.has(keyOf(scope))) return { ok: false, error: scopesError('NOT_FOUND', 'no such circle') };
      return inner.resolve(bearer, scope, 'read');
    },
    readable: async (bearer) => {
      const all = await inner.readable(bearer);
      if (!all.ok) return all;
      const set = await allowed(bearer);
      return set === undefined ? all : { ok: true, value: all.value.filter((r: ResolvedScope) => set.has(keyOf(r.scope))) };
    },
  };

  // The capture controller is required by the CaCi controller but is never reachable from here: no method that uses it is exposed, except that
  // `remove`, for the verb `clear` in the token's person's own brain, may delete one fact in a graph named `user-...` and nowhere else (R-025 D13).
  const noCapture = new Proxy({} as Controller, {
    get: (_target, prop) => (prop === 'remove' && init.removeFact !== undefined ? ownBrainOnly(init.removeFact) : () => {
      throw new Error('agent access is read-only');
    }),
  });
  const caci = createCaciController({
    users: agentUsers as never,
    graphAdapter: init.graphAdapter,
    capture: noCapture,
    scopes: restricted,
    ...(init.ledger === undefined ? {} : { ledger: init.ledger }),
    ...(init.directory === undefined ? {} : { directory: init.directory }),
    ...(init.llm === undefined ? {} : { llm: init.llm }),
    ...(init.checkTexts === undefined ? {} : { checkTexts: init.checkTexts }),
    ...(init.pulseText === undefined ? {} : { pulseText: init.pulseText }),
    ...(init.mode === undefined ? {} : { mode: init.mode }),
    ...(init.limits === undefined ? {} : { limits: init.limits }),
    ...(init.usage === undefined ? {} : { usage: init.usage, checkCapability: 'agent-check' as const }),
    ...(init.verbs === undefined || init.resolutions === undefined ? {} : { verbs: init.verbs, resolutions: init.resolutions }),
    clock,
  });

  // The CaCi controller serves an omitted or personal scope without asking the resolver (it is "my own brain", R-009), so the token's
  // own scope list is enforced here as well, before the call: a token that does not list `personal` cannot read the personal brain.
  const isPersonal = (scope: unknown): boolean => scope === undefined || (typeof scope === 'object' && scope !== null && (scope as { kind?: unknown }).kind === 'personal');
  const noCircle = { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } } } as const;
  /** True when this is a live token that lacks the personal scope and the request is about the personal brain. */
  const blocked = async (bearer: unknown, scope: unknown, undefinedMeansPersonal = true): Promise<boolean> => {
    if (scope === undefined && !undefinedMeansPersonal) return false;
    if (!isPersonal(scope)) return false;
    const access = await accessOf(bearer);
    return access !== undefined && !access.scopes.includes('personal');
  };
  const refScope = (ref: unknown): unknown => (typeof ref === 'object' && ref !== null ? (ref as { scope?: unknown }).scope : undefined);
  const inputScope = refScope;

  const read: AgentReadApi = Object.freeze({
    brainScopes: (t) => caci.brainScopes(t),
    mineSummary: (t) => caci.mineSummary(t),
    mineCategories: (t, page) => caci.mineCategories(t, page),
    mineCategoryItems: async (t, ref, page) => ((await blocked(t, refScope(ref), false)) ? noCircle : caci.mineCategoryItems(t, ref, page)),
    mineItem: async (t, ref) => ((await blocked(t, refScope(ref), false)) ? noCircle : caci.mineItem(t, ref)),
    summary: async (t, scope) => ((await blocked(t, scope)) ? noCircle : caci.summary(t, scope)),
    categories: async (t, page, scope) => ((await blocked(t, scope)) ? noCircle : caci.categories(t, page, scope)),
    categoryItems: async (t, id, page, scope) => ((await blocked(t, scope)) ? noCircle : caci.categoryItems(t, id, page, scope)),
    item: async (t, id, scope) => ((await blocked(t, scope)) ? noCircle : caci.item(t, id, scope)),
    ledger: async (t, scope, page) => ((await blocked(t, scope)) ? noCircle : caci.ledger(t, scope, page)),
    source: async (t, ref) => ((await blocked(t, refScope(ref))) ? noCircle : caci.source(t, ref)),
    searchFacts: async (t, input) => ((await blocked(t, inputScope(input))) ? noCircle : caci.searchFacts(t, input)),
    changes: async (t, input) => ((await blocked(t, inputScope(input))) ? noCircle : caci.changes(t, input)),
    status: async (t, input) => {
      const access = await accessOf(t);
      if (access !== undefined && !access.checks) return { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'this token cannot run checks' } } };
      const scope = typeof input === 'object' && input !== null ? (input as { scope?: unknown }).scope : undefined;
      if (await blocked(t, scope, false)) return noCircle;
      return caci.status(t, input);
    },
  });

  // the verb tools (R-025 D13): refused unless the token was made with the resolve flag, limited to the token's scopes like the read tools, and never
  // the verb that deletes for everyone (`remove`): an agent may resolve for the person, it may not change a circle's notes
  const noResolve = { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'this token cannot resolve facts' } } } as const;
  const mayResolve = async (bearer: unknown): Promise<AgentTokenAccess | undefined> => {
    const access = await accessOf(bearer);
    return access !== undefined && access.resolve ? access : undefined;
  };
  const resolve: AgentResolveApi = Object.freeze({
    verbs: async (t) => ((await mayResolve(t)) === undefined && (await accessOf(t)) !== undefined ? noResolve : caci.verbs(t)),
    resolveFact: async (t, input) => {
      if ((await accessOf(t)) !== undefined && (await mayResolve(t)) === undefined) return noResolve;
      const verb = typeof input === 'object' && input !== null ? (input as { verb?: unknown }).verb : undefined;
      if (typeof verb === 'string' && init.verbs?.get(verb)?.effect === 'remove') return { ok: false, error: { source: 'caci', error: { code: 'FORBIDDEN', message: 'an agent cannot remove a fact for everyone' } } };
      return (await blocked(t, inputScope(input))) ? noCircle : caci.resolveFact(t, input);
    },
    unresolveFact: async (t, input) => {
      if ((await accessOf(t)) !== undefined && (await mayResolve(t)) === undefined) return noResolve;
      return (await blocked(t, inputScope(input))) ? noCircle : caci.unresolveFact(t, input);
    },
    resolutions: async (t, input) => {
      const access = await accessOf(t);
      if (access !== undefined && !access.resolve) return noResolve;
      const listed = await caci.resolutions(t, input);
      if (!listed.ok || access === undefined) return listed;
      // only what the token may read: a record in a brain the token does not list is not shown to it
      const set = new Set(access.scopes);
      return { ok: true, value: Object.freeze({ items: Object.freeze(listed.value.items.filter((r) => set.has(r.fact.scope.kind === 'personal' ? 'personal' : `circle:${r.fact.scope.circleId}`))), next: listed.value.next }) };
    },
  });

  return Object.freeze({ access: accessOf, read, resolve });
}
