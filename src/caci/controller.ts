import type { ControllerError, Controller, PendingProposal, ProposalSummary } from '../app/index.js';
import { err, ok, type JsonValue, type Result, type StorageAdapter } from '../graph_store/index.js';
import { createRegistrationThrottle as createWindowLimiter, type Authenticated, type UserController } from '../users/index.js';
import { parseScope, PERSONAL, type Provenance, type ResolvedScope, type ScopeResolver, type ScopesError, type Scope } from '../scopes/index.js';
import { createBrain, type BrainLimits, type BrainScope, type MineCategoryItemsPage, type MineCategoryPage, type MineItemDetail, type MineSummary } from './brain.js';
import { createBrowser, pageOf, type CategoryItemsPage, type CategoryPage, type GraphSummary, type ItemDetail, type PageInput } from './browse.js';
import { caciError, type CaciError } from './errors.js';
import { createStatusContext, type StatusContextLimits } from './status-context.js';
import { capText, newLedgerId, SUMMARY_MAX, TITLE_MAX, type LedgerEntry, type LedgerScope, type LedgerStore } from '../ledger/index.js';
import type { Llm } from '../llm/index.js';
import { isTimeZone } from '../llm/index.js';

/** The longest note accepted: the categoriser's own limit, so a refusal here is clear and costs no model call. */
export const MAX_NOTE_CHARS = 8000;
const HOUR_MS = 60 * 60_000;
/** How many expired proposals are remembered, so that their owners can be told they expired. */
const REMEMBER_EXPIRED = 1000;

export interface CaciLimits {
  /** Proposals one account may have waiting at once. Default 10. */
  readonly maxPendingPerUser?: number;
  /** New proposals one account may start in an hour (each costs a model call). Default 30. */
  readonly proposalsPerHour?: number;
  /** Status requests one account may make in an hour (each costs a model call over a large prompt). Default 20. */
  readonly statusPerHour?: number;
}

export interface CaciControllerInit {
  /** Only `resolve` is used: a session token becomes a user and their graph. */
  readonly users: Pick<UserController, 'resolve'>;
  /** Where the graphs are: browsing reads the signed-in person's graph from here, through the public `query`. */
  readonly graphAdapter: StorageAdapter;
  /** The capture controller (`src/app/`), unchanged: it reads context, asks the model, holds the preview, and writes on approval. */
  readonly capture: Controller;
  /** Which model answers, for the person to see: `demo` or `anthropic`. Default `demo`. */
  readonly mode?: 'demo' | 'anthropic';
  /** The clock in milliseconds. Use the capture controller's clock too, so expiry agrees. */
  readonly clock?: () => number;
  readonly limits?: CaciLimits & BrainLimits & { readonly status?: StatusContextLimits };
  /** The LLM component, for status updates (R-011). Without it `status` is not available. */
  readonly llm?: Pick<Llm, 'status'>;
  /** Resolves a circle scope to its graph for the current member (R-009). Without it only the personal scope works. */
  readonly scopes?: ScopeResolver;
  /** The change log (R-014): after an approved write, what was added, removed and updated is recorded here. Without it nothing is recorded. */
  readonly ledger?: LedgerStore;
  /** The predefined text a pulse sends (R-016 D21), read by the service from `controls/pulse.txt`; without it a pulse is not available. */
  readonly pulseText?: string;
  /** Who is who in the change log: only the display name and username of a user id are ever read from it. Without it entries carry no names. */
  readonly directory?: { get(id: string): Promise<{ readonly username: string; readonly displayName: string } | undefined> };
  /** Told, with one fixed sentence and no note text, when recording a change failed. The change itself stands. A throwing hook is ignored. */
  readonly onLedgerFailure?: (message: string) => void;
}

/** A proposal as a person is allowed to see it: the preview and what they would be approving, and nothing about the plumbing. */
export interface ProposalView {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly mode: 'demo' | 'anthropic';
  /** The preview in plain words. */
  readonly text: string;
  readonly summary: ProposalSummary;
  /** The operations that approving would write. */
  readonly operations: readonly JsonValue[];
  /** The model's short reason, when it gave one. */
  readonly rationale?: string;
  /** Where it will be written, for a circle proposal (the circle's name and id). Absent for a personal one, as before R-009. */
  readonly scope?: Provenance;
}

/** One line of the change log, as a person is allowed to see it (R-014): no graph id, no proposal id, no user id. */
export interface LedgerEntryView {
  readonly id: string;
  readonly at: number;
  readonly action: 'added' | 'updated' | 'removed';
  readonly kind: 'item' | 'category';
  /** The id of the note or category that changed. */
  readonly subject: string;
  /** What it was called; for a removal, the removed text. */
  readonly title?: string;
  readonly summary?: string;
  /** Who made the change, when they can still be named. */
  readonly by?: { readonly username: string; readonly displayName: string };
}

/** A page of the change log of one brain, newest first. */
export interface LedgerView {
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
  /** Whose log it is, for a circle (absent for the personal one). */
  readonly scope?: Provenance;
}

/** The longest request accepted for a status. */
export const MAX_STATUS_REQUEST_CHARS = 500;

/** A status as a person is allowed to see it: the short answer, where each point came from, and nothing about the plumbing. */
export interface StatusView {
  readonly headline: string;
  readonly points: ReadonlyArray<{ readonly text: string; readonly sources: readonly Provenance[] }>;
  /** True when nothing relevant was found (and there are no points). */
  readonly nothing: boolean;
  readonly generatedAt: number;
  readonly mode: 'demo' | 'anthropic';
  /** How many notes the model was shown, and how many it was not (too many for one request: the newest were used). */
  readonly entriesUsed: number;
  readonly entriesLeftOut: number;
}

/** What approving a proposal reports: which proposal, how many operations were written, and what they were. */
export interface ApprovedView {
  readonly id: string;
  readonly applied: number;
  readonly summary: ProposalSummary;
  /** Categories removed afterwards because the notes this one replaced were the only ones in them (R-014). Absent when there were none. */
  readonly tidied?: readonly { readonly id: string; readonly name?: string }[];
}

export interface CaciController {
  /**
   * Asks the model how to file a note, for the person the session belongs to, in **their** graph (taken
   * from the session: there is no way to name another). Holds the answer as a pending proposal owned by
   * them. Writes nothing.
   */
  propose(token: unknown, input: { readonly text: unknown; readonly scope?: unknown }): Promise<Result<ProposalView, CaciError>>;
  /**
   * A pending proposal, for its owner only. Anyone else (another account, an admin, a made-up id) gets exactly
   * the answer a missing proposal gets. Its owner is told when it has expired.
   */
  get(token: unknown, proposalId: unknown): Promise<Result<ProposalView, CaciError>>;
  /**
   * Writes the owner's pending proposal to their graph, once. If the write fails nothing is changed and the
   * proposal stays pending, so it can be tried again or rejected. Approving twice, or twice at once, writes once.
   */
  approve(token: unknown, proposalId: unknown): Promise<Result<ApprovedView, CaciError>>;
  /**
   * A short status, in a fixed format, for **the person who asks and nobody else**, from everything they can read
   * right now: their own brain and every circle brain they belong to (any role). Free text in (`text`, 1 to 500
   * characters; optional `timeZone`, an IANA name, default UTC). Writes nothing and keeps nothing.
   */
  status(token: unknown, input: { readonly text?: unknown; readonly timeZone?: unknown; readonly scope?: unknown; readonly pulse?: unknown }): Promise<Result<StatusView, CaciError>>;
  /** Which model files this person's notes: `demo` (nothing leaves the machine) or `anthropic` (the note and category names go to Anthropic). Nothing else is said. */
  mode(token: unknown): Promise<Result<{ readonly mode: 'demo' | 'anthropic' }, CaciError>>;
  /** The scopes the person may use, their own brain first: where each is, their role there and whether they may capture. */
  brainScopes(token: unknown): Promise<Result<{ readonly items: readonly BrainScope[] }, CaciError>>;
  /** My Brain: counts over the person's brain and every circle brain they may read, and for each on its own. */
  mineSummary(token: unknown): Promise<Result<MineSummary, CaciError>>;
  /** My Brain: the categories of every readable scope, each tagged with where it came from, in a fixed order, a page at a time. */
  mineCategories(token: unknown, page?: PageInput): Promise<Result<MineCategoryPage, CaciError>>;
  /**
   * My Brain: the items of one category. A category in My Brain is identified by **where it is and its id**:
   * `ref` is `{ scope, id }` and nothing else, and the scope is required. The caller must be able to read that scope.
   */
  mineCategoryItems(token: unknown, ref: unknown, page?: PageInput): Promise<Result<MineCategoryItemsPage, CaciError>>;
  /** My Brain: one item, identified by `{ scope, id }`, and the categories of that scope it is filed under. */
  mineItem(token: unknown, ref: unknown): Promise<Result<MineItemDetail, CaciError>>;
  /**
   * Counts of items, categories and links in the caller's graph, or (with a `scope`, R-009) in one circle's brain
   * the caller may read, in which case the answer names the circle. Every browse call below takes the same optional
   * trailing `scope`: omitted or personal is the caller's own brain exactly as before.
   */
  summary(token: unknown, scope?: unknown): Promise<Result<GraphSummary, CaciError>>;
  /** The caller's categories by id, a page at a time (`limit` 1 to 100, default 50), each with how many items are filed under it. */
  categories(token: unknown, page?: PageInput, scope?: unknown): Promise<Result<CategoryPage, CaciError>>;
  /** The items filed under one of the caller's categories. An id that is not one of theirs is `NOT_FOUND`, whatever other graphs hold. */
  categoryItems(token: unknown, categoryId: unknown, page?: PageInput, scope?: unknown): Promise<Result<CategoryItemsPage, CaciError>>;
  /** One of the caller's items, and the categories it is filed under. */
  item(token: unknown, itemId: unknown, scope?: unknown): Promise<Result<ItemDetail, CaciError>>;
  /**
   * The change log of one brain, newest first, a page at a time: the person's own (default) or a circle they may read (R-014). It is a
   * review log of what was added, removed and updated, not a history of the notes. A stranger gets the made-up-circle answer.
   */
  ledger(token: unknown, scope?: unknown, page?: PageInput): Promise<Result<LedgerView, CaciError>>;
  /** Discards the owner's pending proposal. Nothing is written. */
  reject(token: unknown, proposalId: unknown): Promise<Result<{ readonly id: string }, CaciError>>;
}

interface Held {
  readonly userId: string;
  readonly expiresAt: number;
  /** Fixed when the proposal is made and never changed: where approving would write (a circle scope only). */
  readonly circle?: { readonly scope: Scope; readonly graphId: string; readonly provenance: Provenance };
}

const whole = (value: number | undefined, fallback: number, name: string): number => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`createCaciController: ${name} must be a positive whole number`);
  return n;
};

/** How a pending proposal is shown: no prompt, no raw model output, no usage, no model name, no graph id. */
export function viewOf(proposal: PendingProposal, mode: 'demo' | 'anthropic', scope?: Provenance): ProposalView {
  return Object.freeze({
    id: proposal.id,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    mode,
    text: proposal.text,
    summary: proposal.summary,
    operations: proposal.mutation.ops as unknown as readonly JsonValue[],
    ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
    ...(scope === undefined || scope.kind === 'personal' ? {} : { scope }),
  });
}

export function createCaciController(init: CaciControllerInit): CaciController {
  const { users, capture, graphAdapter } = init;
  if (users === undefined || capture === undefined || graphAdapter === undefined) throw new TypeError('createCaciController needs users, capture and graphAdapter');
  const browser = createBrowser(graphAdapter);
  const brain = createBrain(browser, init.limits);
  const mode = init.mode ?? 'demo';
  if (mode !== 'demo' && mode !== 'anthropic') throw new TypeError('createCaciController: mode must be demo or anthropic');
  const scopes = init.scopes;
  const clock = init.clock ?? Date.now;
  const maxPending = whole(init.limits?.maxPendingPerUser, 10, 'maxPendingPerUser');
  const perHour = whole(init.limits?.proposalsPerHour, 30, 'proposalsPerHour');
  const hourly = createWindowLimiter({ max: perHour, windowMs: HOUR_MS });
  const statusPerHour = whole(init.limits?.statusPerHour, 20, 'statusPerHour');
  const statusHourly = createWindowLimiter({ max: statusPerHour, windowMs: HOUR_MS });
  const statusContext = createStatusContext(graphAdapter, init.limits?.status);
  const statusLlm = init.llm;
  const pulseText = init.pulseText;
  if (pulseText !== undefined && (typeof pulseText !== 'string' || pulseText.trim() === '' || [...pulseText].length > MAX_STATUS_REQUEST_CHARS)) throw new TypeError(`pulseText must be 1 to ${MAX_STATUS_REQUEST_CHARS} characters of text`);
  /** Accounts with a status being made right now: one at a time each. */
  const making = new Set<string>();
  /** Every pending proposal with its owner. */
  const held = new Map<string, Held>();
  /** Places kept for proposals whose model call is still running, by owner: the place is taken before the call, not after it. */
  const reserved = new Map<number, string>();
  let reservations = 0;

  /** Expired proposals and their owners, oldest first, bounded. */
  const expiredOwners = new Map<string, string>();
  const sweep = (now: number): void => {
    for (const [id, h] of [...held]) {
      if (h.expiresAt > now) continue;
      held.delete(id);
      expiredOwners.set(id, h.userId);
      if (expiredOwners.size > REMEMBER_EXPIRED) expiredOwners.delete(expiredOwners.keys().next().value as string);
    }
  };
  const pendingOf = (userId: string): number[] => [...[...held.values()].filter((h) => h.userId === userId).map((h) => h.expiresAt), ...[...reserved.values()].filter((u) => u === userId).map(() => Number.POSITIVE_INFINITY)];

  async function whoIs(token: unknown): Promise<Result<Authenticated, CaciError>> {
    const me = await users.resolve(token);
    return me.ok ? ok(me.value) : err(caciError('UNAUTHENTICATED', 'not signed in'));
  }

  const notFound = (): CaciError => caciError('NOT_FOUND', 'no such proposal');
  const expired = (): CaciError => caciError('EXPIRED', 'that proposal has expired: make it again');

  /**
   * The owner's view of a proposal id. Everyone else, and every id that is not a proposal, gets the very
   * same `NOT_FOUND`, so nobody can tell a stranger's proposal from one that does not exist.
   */
  async function owned(token: unknown, proposalId: unknown): Promise<Result<{ userId: string; id: string; held: Held }, CaciError>> {
    const me = await whoIs(token);
    if (!me.ok) return me;
    const userId = me.value.user.id;
    sweep(clock());
    if (typeof proposalId !== 'string') return err(notFound());
    const h = held.get(proposalId);
    if (h !== undefined && h.userId === userId) return ok({ userId, id: proposalId, held: h });
    if (expiredOwners.get(proposalId) === userId) return err(expired());
    return err(notFound());
  }

  /** Records what an approved write changed. Never throws and never undoes the change: a failure only calls the hook. */
  async function recordChanges(userId: string, h: Held, done: { readonly proposal: PendingProposal; readonly tidied: ReadonlyArray<{ readonly id: string; readonly name?: string }> }): Promise<void> {
    const ledger = init.ledger;
    if (ledger === undefined) return;
    try {
      const { proposal } = done;
      const scope: LedgerScope = h.circle === undefined || h.circle.scope.kind !== 'circle' ? { kind: 'personal', userId } : { kind: 'circle', circleId: h.circle.scope.circleId };
      const textOf = (partition: 'item' | 'category', id: string): { title?: string; summary?: string } => {
        const op = proposal.mutation.ops.find((o) => o.op === 'upsertNode' && o.partition === partition && o.id === id);
        const data = (op?.op === 'upsertNode' ? op.data : undefined) as Record<string, unknown> | undefined;
        const title = partition === 'item' ? data?.title : data?.name;
        return { ...(typeof title === 'string' ? { title: capText(title, TITLE_MAX) } : {}), ...(typeof data?.summary === 'string' ? { summary: capText(data.summary, SUMMARY_MAX) } : {}) };
      };
      const at = clock();
      // Oldest first: the tidy, then the removals, then what was created; the newest-first listing then shows the new note on top.
      const parts: Array<Omit<LedgerEntry, 'id' | 'at' | 'scope' | 'actor' | 'proposalId'>> = [
        ...done.tidied.map((c) => ({ action: 'removed' as const, kind: 'category' as const, subject: c.id, ...(c.name === undefined ? {} : { title: capText(c.name, TITLE_MAX) }) })),
        ...proposal.summary.removed.map((r) => ({ action: 'removed' as const, kind: 'item' as const, subject: r.id, title: r.title, summary: r.summary })),
        ...proposal.summary.updatedCategories.map((id) => ({ action: 'updated' as const, kind: 'category' as const, subject: id, ...textOf('category', id) })),
        ...proposal.summary.newCategories.map((id) => ({ action: 'added' as const, kind: 'category' as const, subject: id, ...textOf('category', id) })),
        ...proposal.summary.newItems.map((id) => ({ action: 'added' as const, kind: 'item' as const, subject: id, ...textOf('item', id) })),
      ];
      const result = await ledger.append(parts.map((p, i) => ({ id: newLedgerId(), at: at + i, scope, actor: userId, proposalId: proposal.id, ...p })));
      if (!result.ok) reportLedger();
    } catch {
      reportLedger();
    }
  }
  function reportLedger(): void {
    try {
      init.onLedgerFailure?.('the change was made but could not be recorded in the change log');
    } catch {
      // a hook must never change what happens
    }
  }

  const noCircle = (): CaciError => caciError('NOT_FOUND', 'no such circle');
  const storage = (): CaciError => ({ source: 'graph', error: { code: 'STORAGE_ERROR', message: 'the service could not complete the request' } as never });

  /** A scope problem in this controller's words: a malformed scope names its field. */
  const scopeProblem = (e: ScopesError): CaciError => {
    if (e.code === 'INVALID_INPUT') return caciError('INVALID_INPUT', e.message, { field: e.field === undefined || e.field === 'scope' ? 'scope' : `scope.${e.field}` });
    if (e.code === 'UNAUTHENTICATED') return caciError('UNAUTHENTICATED', 'not signed in');
    if (e.code === 'NOT_FOUND') return noCircle();
    if (e.code === 'LIMIT_REACHED') return caciError('INVALID_INPUT', e.message, { field: 'scope' });
    return storage();
  };

  /**
   * A circle proposal may only be shown or written while its owner is still allowed to capture into that circle,
   * checked now, from the store. If not, the proposal is discarded (it can never be approved) and reads as missing.
   */
  async function stillAllowed(token: unknown, id: string, h: Held): Promise<CaciError | undefined> {
    if (h.circle === undefined) return undefined;
    const r = scopes === undefined ? undefined : await scopes.resolve(token, h.circle.scope, 'capture');
    if (r?.ok === true) return undefined;
    if (r !== undefined && !r.ok && r.error.code === 'STORAGE_ERROR') return storage(); // cannot tell: keep it, refuse for now
    capture.reject(id);
    held.delete(id);
    return notFound();
  }

  /**
   * The graph a browse call reads: the caller's own (the session says which), or one circle's brain when the
   * caller is a current member in any reading role, checked now. Everything else is the one NOT_FOUND.
   */
  async function readable(token: unknown, scope: unknown): Promise<Result<{ graphId: string; provenance: Provenance | undefined }, CaciError>> {
    const me = await whoIs(token);
    if (!me.ok) return me;
    const parsed = parseScope(scope);
    if (!parsed.ok) return err(scopeProblem(parsed.error));
    if (parsed.value.kind === 'personal') return ok({ graphId: me.value.graphId, provenance: undefined });
    if (scopes === undefined) return err(noCircle());
    const resolved = await scopes.resolve(token, parsed.value, 'read');
    if (!resolved.ok) return err(scopeProblem(resolved.error));
    return ok({ graphId: resolved.value.graphId, provenance: resolved.value.provenance });
  }

  /** Everything the person may read, their own brain first. Without a resolver that is just their own. */
  async function readableScopes(token: unknown): Promise<Result<readonly ResolvedScope[], CaciError>> {
    if (scopes !== undefined) {
      const r = await scopes.readable(token);
      return r.ok ? ok(r.value) : err(scopeProblem(r.error));
    }
    const me = await whoIs(token);
    if (!me.ok) return me;
    return ok([Object.freeze({ userId: me.value.user.id, scope: PERSONAL, graphId: me.value.graphId, provenance: Object.freeze({ kind: 'personal' as const }) })]);
  }

  /** `{ scope, id }` as My Brain names a category or an item: both required, nothing else, and the scope readable now. */
  async function located(token: unknown, ref: unknown): Promise<Result<{ where: ResolvedScope; id: unknown }, CaciError>> {
    const me = await whoIs(token);
    if (!me.ok) return me;
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return err(caciError('INVALID_INPUT', 'name it as { scope, id }', { field: 'ref' }));
    for (const key of Object.keys(ref)) if (key !== 'scope' && key !== 'id') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
    const given = (ref as { scope?: unknown; id?: unknown }).scope;
    if (given === undefined) return err(caciError('INVALID_INPUT', 'say which scope it is in', { field: 'scope' }));
    const parsed = parseScope(given);
    if (!parsed.ok) return err(scopeProblem(parsed.error));
    if (parsed.value.kind === 'personal') {
      return ok({ where: Object.freeze({ userId: me.value.user.id, scope: PERSONAL, graphId: me.value.graphId, provenance: Object.freeze({ kind: 'personal' as const }) }), id: (ref as { id?: unknown }).id });
    }
    if (scopes === undefined) return err(noCircle());
    const resolved = await scopes.resolve(token, parsed.value, 'read');
    return resolved.ok ? ok({ where: resolved.value, id: (ref as { id?: unknown }).id }) : err(scopeProblem(resolved.error));
  }

  /** A browse result with the circle it came from (nothing is added for the personal brain). */
  const tag = <T extends object>(value: T, provenance: Provenance | undefined): T => (provenance === undefined ? value : Object.freeze({ ...value, scope: provenance }));

  /** The capture controller's own refusals for a proposal that is gone, in this controller's words. */
  const gone = (error: ControllerError): CaciError | undefined => {
    if (error.source !== 'app') return undefined;
    if (error.error.code === 'PROPOSAL_NOT_FOUND') return notFound();
    if (error.error.code === 'PROPOSAL_EXPIRED') return expired();
    return undefined;
  };

  return {
    async status(token, input) {
      const me = await whoIs(token);
      if (!me.ok) return me;
      if (statusLlm === undefined) return err(caciError('NOT_FOUND', 'status updates are not available'));
      const userId = me.value.user.id;
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return err(caciError('INVALID_INPUT', 'send { text }', { field: 'text' }));
      for (const key of Object.keys(input)) if (key !== 'text' && key !== 'timeZone' && key !== 'scope' && key !== 'pulse') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
      // a pulse (R-016 D21) is the predefined text for one circle: no text may come with it, the server supplies it
      const pulse = input.pulse;
      if (pulse !== undefined && typeof pulse !== 'boolean') return err(caciError('INVALID_INPUT', 'pulse must be true or false', { field: 'pulse' }));
      if (pulse === true) {
        if (pulseText === undefined) return err(caciError('NOT_FOUND', 'pulse is not available'));
        if (input.text !== undefined) return err(caciError('INVALID_INPUT', 'a pulse takes no text', { field: 'text' }));
        if (input.scope === undefined) return err(caciError('INVALID_INPUT', 'a pulse needs a circle scope', { field: 'scope' }));
      }
      const asked = pulse === true ? pulseText : input.text;
      if (typeof asked !== 'string') return err(caciError('INVALID_INPUT', 'text must be text', { field: 'text' }));
      const text = asked.trim();
      if (text === '') return err(caciError('INVALID_INPUT', 'text must not be empty', { field: 'text' }));
      if ([...text].length > MAX_STATUS_REQUEST_CHARS) return err(caciError('INVALID_INPUT', `text is over the limit of ${MAX_STATUS_REQUEST_CHARS} characters`, { field: 'text' }));
      if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) return err(caciError('INVALID_INPUT', 'timeZone must be a time zone name such as "Europe/London" or "UTC"', { field: 'timeZone' }));
      const timeZone = input.timeZone === undefined ? 'UTC' : (input.timeZone as string);

      // an optional scope narrows the context to one brain (R-016 D20): resolved now with the read right, so a stranger or a made-up
      // circle gets the one NOT_FOUND before anything is counted, read or asked
      let only: ResolvedScope | undefined;
      if (input.scope !== undefined) {
        const parsed = parseScope(input.scope);
        if (!parsed.ok) return err(scopeProblem(parsed.error));
        if (pulse === true && parsed.value.kind !== 'circle') return err(caciError('INVALID_INPUT', 'a pulse needs a circle scope', { field: 'scope' }));
        if (scopes === undefined) {
          if (parsed.value.kind !== 'personal') return err(noCircle());
          only = Object.freeze({ userId, scope: PERSONAL, graphId: me.value.graphId, provenance: Object.freeze({ kind: 'personal' as const }) });
        } else {
          const resolved = await scopes.resolve(token, parsed.value, 'read');
          if (!resolved.ok) return err(scopeProblem(resolved.error));
          only = resolved.value;
        }
      }

      // one at a time per account, and an hourly limit: both are checked before anything is read or any model is asked, and a refusal is not counted
      if (making.has(userId)) return err(caciError('THROTTLED', 'a status for you is already being made: wait for it', { retryAfterMs: 5000 }));
      const wait = statusHourly.check(userId, clock());
      if (!wait.allowed) return err(caciError('THROTTLED', `you have asked for the most statuses allowed in an hour (${statusPerHour})`, { retryAfterMs: wait.retryAfterMs }));
      making.add(userId);
      try {
        const all = only === undefined ? await readableScopes(token) : ok([only] as readonly ResolvedScope[]);
        if (!all.ok) return all;
        const context = await statusContext.read(all.value, clock());
        if (!context.ok) return context;
        statusHourly.record(userId, clock()); // the model is about to be asked
        const answered = await statusLlm.status({ text, entries: context.value.entries, timeZone });
        if (!answered.ok) return err({ source: 'llm' as const, error: answered.error });
        const provenance = context.value.provenance;
        const points = answered.value.points.map((p) => {
          const seen = new Set<string>();
          const sources: Provenance[] = [];
          for (const ref of p.refs) {
            const where = provenance[ref - 1];
            if (where === undefined) continue;
            const key = where.kind === 'personal' ? 'personal' : `circle:${where.circleId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push(Object.freeze(where.kind === 'personal' ? { kind: 'personal' as const } : { kind: 'circle' as const, circleId: where.circleId, circleName: where.circleName }));
          }
          return Object.freeze({ text: p.text, sources: Object.freeze(sources) });
        });
        return ok(
          Object.freeze({
            headline: answered.value.headline,
            points: Object.freeze(points),
            nothing: answered.value.nothing,
            generatedAt: clock(),
            mode,
            entriesUsed: context.value.entries.length,
            entriesLeftOut: context.value.entriesLeftOut,
          }),
        );
      } finally {
        making.delete(userId);
      }
    },

    async mode(token) {
      const me = await whoIs(token);
      return me.ok ? ok(Object.freeze({ mode })) : me;
    },

    async mineCategoryItems(token, ref, page) {
      const at = await located(token, ref);
      return at.ok ? brain.categoryItems(at.value.where.userId, at.value.where, at.value.id, page) : at;
    },

    async mineItem(token, ref) {
      const at = await located(token, ref);
      return at.ok ? brain.item(at.value.where, at.value.id) : at;
    },

    async brainScopes(token) {
      const all = await readableScopes(token);
      return all.ok ? ok(Object.freeze({ items: brain.scopes(all.value) })) : all;
    },

    async mineSummary(token) {
      const all = await readableScopes(token);
      return all.ok ? brain.summary(all.value) : all;
    },

    async mineCategories(token, page) {
      const all = await readableScopes(token);
      return all.ok ? brain.categories((all.value[0] as ResolvedScope).userId, all.value, page) : all;
    },

    async summary(token, scope) {
      const where = await readable(token, scope);
      if (!where.ok) return where;
      const r = await browser.summary(where.value.graphId);
      return r.ok ? ok(tag(r.value, where.value.provenance)) : r;
    },

    async categories(token, page, scope) {
      const where = await readable(token, scope);
      if (!where.ok) return where;
      const r = await browser.categories(where.value.graphId, page);
      return r.ok ? ok(tag(r.value, where.value.provenance)) : r;
    },

    async categoryItems(token, categoryId, page, scope) {
      const where = await readable(token, scope);
      if (!where.ok) return where;
      const r = await browser.categoryItems(where.value.graphId, categoryId, page);
      return r.ok ? ok(tag(r.value, where.value.provenance)) : r;
    },

    async item(token, itemId, scope) {
      const where = await readable(token, scope);
      if (!where.ok) return where;
      const r = await browser.item(where.value.graphId, itemId);
      return r.ok ? ok(tag(r.value, where.value.provenance)) : r;
    },

    async get(token, proposalId) {
      const mine = await owned(token, proposalId);
      if (!mine.ok) return mine;
      const refused = await stillAllowed(token, mine.value.id, mine.value.held);
      if (refused !== undefined) return err(refused);
      const proposal = capture.get(mine.value.id);
      if (proposal === undefined) {
        held.delete(mine.value.id);
        return err(expired());
      }
      return ok(viewOf(proposal, mode, mine.value.held.circle?.provenance));
    },

    async ledger(token, scope, page) {
      const me = await whoIs(token);
      if (!me.ok) return me;
      const store = init.ledger;
      if (store === undefined) return err(caciError('NOT_FOUND', 'the change log is not available'));
      const parsed = parseScope(scope);
      if (!parsed.ok) return err(scopeProblem(parsed.error));
      let which: LedgerScope;
      let provenance: Provenance | undefined;
      if (parsed.value.kind === 'personal') which = { kind: 'personal', userId: me.value.user.id };
      else {
        if (scopes === undefined) return err(noCircle());
        const resolved = await scopes.resolve(token, parsed.value, 'read');
        if (!resolved.ok) return err(scopeProblem(resolved.error));
        which = { kind: 'circle', circleId: parsed.value.circleId };
        provenance = resolved.value.provenance;
      }
      const paged = pageOf(page);
      if (!paged.ok) return paged;
      let listed;
      try {
        listed = await store.list(which, paged.value);
      } catch (cause) {
        if (cause instanceof RangeError) return err(caciError('INVALID_INPUT', 'cursor is not one this service gave for this request', { field: 'cursor' }));
        return err(storage());
      }
      const names = new Map<string, { username: string; displayName: string } | undefined>();
      const who = async (id: string) => {
        if (!names.has(id)) {
          try {
            const u = await init.directory?.get(id);
            names.set(id, u === undefined ? undefined : { username: u.username, displayName: u.displayName });
          } catch {
            names.set(id, undefined);
          }
        }
        return names.get(id);
      };
      const items: LedgerEntryView[] = [];
      for (const e of listed.items) {
        const by = await who(e.actor);
        items.push(Object.freeze({ id: e.id, at: e.at, action: e.action, kind: e.kind, subject: e.subject, ...(e.title === undefined ? {} : { title: e.title }), ...(e.summary === undefined ? {} : { summary: e.summary }), ...(by === undefined ? {} : { by: Object.freeze(by) }) }));
      }
      return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor, ...(provenance === undefined ? {} : { scope: provenance }) }));
    },

    async approve(token, proposalId) {
      const mine = await owned(token, proposalId);
      if (!mine.ok) return mine;
      const refused = await stillAllowed(token, mine.value.id, mine.value.held);
      if (refused !== undefined) return err(refused);
      const done = await capture.approve(mine.value.id);
      if (done.ok) {
        held.delete(mine.value.id);
        await recordChanges(mine.value.userId, mine.value.held, done.value);
        return ok(Object.freeze({ id: mine.value.id, applied: done.value.written.applied, summary: done.value.proposal.summary, ...(done.value.tidied.length === 0 ? {} : { tidied: done.value.tidied }) }));
      }
      const reason = gone(done.error);
      if (reason !== undefined) {
        held.delete(mine.value.id);
        return err(reason);
      }
      return done; // a failed write: the proposal is still pending, and is still counted
    },

    async reject(token, proposalId) {
      const mine = await owned(token, proposalId);
      if (!mine.ok) return mine;
      const done = capture.reject(mine.value.id);
      if (done.ok) {
        held.delete(mine.value.id);
        return ok(Object.freeze({ id: mine.value.id }));
      }
      const reason = gone(done.error);
      if (reason !== undefined) held.delete(mine.value.id);
      return err(reason ?? done.error);
    },

    async propose(token, input) {
      const me = await whoIs(token);
      if (!me.ok) return me;
      const userId = me.value.user.id;

      for (const key of Object.keys(input ?? {})) {
        if (key !== 'text' && key !== 'scope') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
      }
      const text = input?.text;
      if (typeof text !== 'string') return err(caciError('INVALID_INPUT', 'text must be text', { field: 'text' }));
      if (text.trim() === '') return err(caciError('INVALID_INPUT', 'text must not be empty', { field: 'text' }));
      if (text.length > MAX_NOTE_CHARS) return err(caciError('INVALID_INPUT', `text is over the limit of ${MAX_NOTE_CHARS} characters`, { field: 'text' }));

      const parsed = parseScope(input?.scope);
      if (!parsed.ok) return err(scopeProblem(parsed.error));
      // where the note will be written is decided here, once, and bound to the proposal: a circle needs a current member who may capture
      let graphId = me.value.graphId;
      let circle: Held['circle'];
      if (parsed.value.kind === 'circle') {
        if (scopes === undefined) return err(noCircle());
        const resolved = await scopes.resolve(token, parsed.value, 'capture');
        if (!resolved.ok) return err(scopeProblem(resolved.error));
        graphId = resolved.value.graphId;
        circle = Object.freeze({ scope: resolved.value.scope, graphId, provenance: resolved.value.provenance });
      }

      const now = clock();
      sweep(now);
      const mine = pendingOf(userId);
      if (mine.length >= maxPending) {
        const soonest = Math.min(...mine);
        return err(caciError('TOO_MANY_PENDING', `you already have ${maxPending} proposals waiting: approve or reject one first`, Number.isFinite(soonest) ? { retryAfterMs: Math.max(1, soonest - now) } : {}));
      }
      const wait = hourly.check(userId, now);
      if (!wait.allowed) return err(caciError('THROTTLED', `you have made the most proposals allowed in an hour (${perHour})`, { retryAfterMs: wait.retryAfterMs }));

      // from here the model will be asked: count it, and keep a place before the first await so that simultaneous requests cannot slip past the limit
      hourly.record(userId, now);
      const reservation = ++reservations;
      reserved.set(reservation, userId);
      try {
        const made = await capture.propose(graphId, { kind: 'text', text }, circle === undefined ? undefined : { stamp: { contributedBy: userId } });
        reserved.delete(reservation);
        if (!made.ok) return made;
        held.set(made.value.id, { userId, expiresAt: made.value.expiresAt, ...(circle === undefined ? {} : { circle }) });
        return ok(viewOf(made.value, mode, circle?.provenance));
      } catch (cause) {
        reserved.delete(reservation);
        throw cause;
      }
    },
  };
}
