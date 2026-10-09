import type { ControllerError, Controller, PendingProposal, ProposalSummary } from '../app/index.js';
import { err, ok, type JsonValue, type Result, type StorageAdapter } from '../graph_store/index.js';
import { createRegistrationThrottle as createWindowLimiter, type Authenticated, type UserController } from '../users/index.js';
import { createBrowser, type CategoryItemsPage, type CategoryPage, type GraphSummary, type ItemDetail, type PageInput } from './browse.js';
import { caciError, type CaciError } from './errors.js';

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
  readonly limits?: CaciLimits;
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
}

/** What approving a proposal reports: which proposal, how many operations were written, and what they were. */
export interface ApprovedView {
  readonly id: string;
  readonly applied: number;
  readonly summary: ProposalSummary;
}

export interface CaciController {
  /**
   * Asks the model how to file a note, for the person the session belongs to, in **their** graph (taken
   * from the session: there is no way to name another). Holds the answer as a pending proposal owned by
   * them. Writes nothing.
   */
  propose(token: unknown, input: { readonly text: unknown }): Promise<Result<ProposalView, CaciError>>;
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
  /** Which model files this person's notes: `demo` (nothing leaves the machine) or `anthropic` (the note and category names go to Anthropic). Nothing else is said. */
  mode(token: unknown): Promise<Result<{ readonly mode: 'demo' | 'anthropic' }, CaciError>>;
  /** Counts of items, categories and links in the caller's graph. */
  summary(token: unknown): Promise<Result<GraphSummary, CaciError>>;
  /** The caller's categories by id, a page at a time (`limit` 1 to 100, default 50), each with how many items are filed under it. */
  categories(token: unknown, page?: PageInput): Promise<Result<CategoryPage, CaciError>>;
  /** The items filed under one of the caller's categories. An id that is not one of theirs is `NOT_FOUND`, whatever other graphs hold. */
  categoryItems(token: unknown, categoryId: unknown, page?: PageInput): Promise<Result<CategoryItemsPage, CaciError>>;
  /** One of the caller's items, and the categories it is filed under. */
  item(token: unknown, itemId: unknown): Promise<Result<ItemDetail, CaciError>>;
  /** Discards the owner's pending proposal. Nothing is written. */
  reject(token: unknown, proposalId: unknown): Promise<Result<{ readonly id: string }, CaciError>>;
}

interface Held {
  readonly userId: string;
  readonly expiresAt: number;
}

const whole = (value: number | undefined, fallback: number, name: string): number => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`createCaciController: ${name} must be a positive whole number`);
  return n;
};

/** How a pending proposal is shown: no prompt, no raw model output, no usage, no model name, no graph id. */
export function viewOf(proposal: PendingProposal, mode: 'demo' | 'anthropic'): ProposalView {
  return Object.freeze({
    id: proposal.id,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    mode,
    text: proposal.text,
    summary: proposal.summary,
    operations: proposal.mutation.ops as unknown as readonly JsonValue[],
    ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
  });
}

export function createCaciController(init: CaciControllerInit): CaciController {
  const { users, capture, graphAdapter } = init;
  if (users === undefined || capture === undefined || graphAdapter === undefined) throw new TypeError('createCaciController needs users, capture and graphAdapter');
  const browser = createBrowser(graphAdapter);
  const mode = init.mode ?? 'demo';
  if (mode !== 'demo' && mode !== 'anthropic') throw new TypeError('createCaciController: mode must be demo or anthropic');
  const clock = init.clock ?? Date.now;
  const maxPending = whole(init.limits?.maxPendingPerUser, 10, 'maxPendingPerUser');
  const perHour = whole(init.limits?.proposalsPerHour, 30, 'proposalsPerHour');
  const hourly = createWindowLimiter({ max: perHour, windowMs: HOUR_MS });
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
  async function owned(token: unknown, proposalId: unknown): Promise<Result<{ userId: string; id: string }, CaciError>> {
    const me = await whoIs(token);
    if (!me.ok) return me;
    const userId = me.value.user.id;
    sweep(clock());
    if (typeof proposalId !== 'string') return err(notFound());
    if (held.get(proposalId)?.userId === userId) return ok({ userId, id: proposalId });
    if (expiredOwners.get(proposalId) === userId) return err(expired());
    return err(notFound());
  }

  /** The capture controller's own refusals for a proposal that is gone, in this controller's words. */
  const gone = (error: ControllerError): CaciError | undefined => {
    if (error.source !== 'app') return undefined;
    if (error.error.code === 'PROPOSAL_NOT_FOUND') return notFound();
    if (error.error.code === 'PROPOSAL_EXPIRED') return expired();
    return undefined;
  };

  return {
    async mode(token) {
      const me = await whoIs(token);
      return me.ok ? ok(Object.freeze({ mode })) : me;
    },

    async summary(token) {
      const me = await whoIs(token);
      return me.ok ? browser.summary(me.value.graphId) : me;
    },

    async categories(token, page) {
      const me = await whoIs(token);
      return me.ok ? browser.categories(me.value.graphId, page) : me;
    },

    async categoryItems(token, categoryId, page) {
      const me = await whoIs(token);
      return me.ok ? browser.categoryItems(me.value.graphId, categoryId, page) : me;
    },

    async item(token, itemId) {
      const me = await whoIs(token);
      return me.ok ? browser.item(me.value.graphId, itemId) : me;
    },

    async get(token, proposalId) {
      const mine = await owned(token, proposalId);
      if (!mine.ok) return mine;
      const proposal = capture.get(mine.value.id);
      if (proposal === undefined) {
        held.delete(mine.value.id);
        return err(expired());
      }
      return ok(viewOf(proposal, mode));
    },

    async approve(token, proposalId) {
      const mine = await owned(token, proposalId);
      if (!mine.ok) return mine;
      const done = await capture.approve(mine.value.id);
      if (done.ok) {
        held.delete(mine.value.id);
        return ok(Object.freeze({ id: mine.value.id, applied: done.value.written.applied, summary: done.value.proposal.summary }));
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
        if (key !== 'text') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
      }
      const text = input?.text;
      if (typeof text !== 'string') return err(caciError('INVALID_INPUT', 'text must be text', { field: 'text' }));
      if (text.trim() === '') return err(caciError('INVALID_INPUT', 'text must not be empty', { field: 'text' }));
      if (text.length > MAX_NOTE_CHARS) return err(caciError('INVALID_INPUT', `text is over the limit of ${MAX_NOTE_CHARS} characters`, { field: 'text' }));

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
        const made = await capture.propose(me.value.graphId, { kind: 'text', text });
        reserved.delete(reservation);
        if (!made.ok) return made;
        held.set(made.value.id, { userId, expiresAt: made.value.expiresAt });
        return ok(viewOf(made.value, mode));
      } catch (cause) {
        reserved.delete(reservation);
        throw cause;
      }
    },
  };
}
