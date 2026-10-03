import { err, ok, type Mutation, type Result } from '../graph_store/index.js';
import type { TokenUsage } from '../llm/index.js';
import { appError, type AppError } from './errors.js';
import type { ProposalSummary } from './summary.js';

/** A proposal waiting for a person to approve or reject it. Nothing in it has been written. */
export interface PendingProposal {
  readonly id: string;
  readonly graphId: string;
  /** The id minted for the note's item. */
  readonly itemId: string;
  /** The note, as text (after normalising). */
  readonly note: string;
  readonly mutation: Mutation;
  readonly rationale?: string;
  readonly summary: ProposalSummary;
  /** The summary as plain text for a person. */
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly attempts: 1 | 2;
  /** How much of the graph the model was shown. */
  readonly context: { readonly categoriesRead: number; readonly capped: boolean };
  readonly createdAt: number;
  /** After this moment (in the controller's clock) the proposal can no longer be approved. */
  readonly expiresAt: number;
}

export type NewProposal = Omit<PendingProposal, 'createdAt' | 'expiresAt'>;

/** What taking a proposal out of the store found. */
export type TakeResult =
  | { readonly state: 'found'; readonly proposal: PendingProposal }
  /** It was held but ran out of time. (Recently expired ids are remembered, so this is reported consistently.) */
  | { readonly state: 'expired' }
  /** Never held, already taken (approved or rejected), or expired long enough ago to be forgotten. */
  | { readonly state: 'unknown' };

/** How many expired ids are remembered so that they can be told apart from unknown ones. */
const REMEMBER_EXPIRED = 1000;

export interface PendingStore {
  /** Whether another proposal would fit right now (expired ones do not count), so callers can refuse before doing paid work. */
  hasRoom(): boolean;
  /** Holds a proposal for `ttlMs`. Expired ones are dropped first; a full store refuses rather than forget someone's proposal. */
  add(proposal: NewProposal): Result<PendingProposal, AppError>;
  /** The proposal, unless it is unknown or has expired. */
  get(id: string): PendingProposal | undefined;
  /**
   * Removes a proposal and hands it over, in one step: of two callers taking the same id, only one
   * gets it. An expired proposal is removed too, but reported as expired.
   */
  take(id: string): TakeResult;
  /** Puts a taken proposal back, with its original expiry, after the work it was taken for failed. */
  restore(proposal: PendingProposal): void;
}

export interface PendingStoreOptions {
  readonly now: () => number;
  readonly ttlMs: number;
  readonly maxPending: number;
}

const tooMany = (waiting: number): AppError => appError('TOO_MANY_PENDING', `${waiting} proposals are already waiting; approve, reject or let some expire first`);

/** An in-memory store of pending proposals, one per controller. */
export function createPendingStore(options: PendingStoreOptions): PendingStore {
  const { now, ttlMs, maxPending } = options;
  const held = new Map<string, PendingProposal>();
  const gone = new Set<string>();
  const alive = (p: PendingProposal): boolean => now() < p.expiresAt;
  const expire = (id: string): void => {
    held.delete(id);
    gone.add(id);
    if (gone.size > REMEMBER_EXPIRED) gone.delete(gone.values().next().value as string);
  };
  const sweep = (): void => {
    for (const [id, p] of held) if (!alive(p)) expire(id);
  };
  return {
    hasRoom() {
      sweep();
      return held.size < maxPending;
    },
    add(proposal) {
      sweep();
      if (held.has(proposal.id)) return err(appError('UNEXPECTED', `a proposal with id ${proposal.id} is already held`));
      if (held.size >= maxPending) return err(tooMany(held.size));
      const createdAt = now();
      const entry: PendingProposal = Object.freeze({ ...proposal, createdAt, expiresAt: createdAt + ttlMs });
      held.set(entry.id, entry);
      return ok(entry);
    },
    get(id) {
      const p = held.get(id);
      if (p === undefined) return undefined;
      if (alive(p)) return p;
      expire(id);
      return undefined;
    },
    take(id) {
      const p = held.get(id);
      if (p === undefined) return { state: gone.has(id) ? 'expired' : 'unknown' };
      if (!alive(p)) {
        expire(id);
        return { state: 'expired' };
      }
      held.delete(id);
      return { state: 'found', proposal: p };
    },
    restore(proposal) {
      // May briefly take the store one over its limit if a new proposal arrived meanwhile: better than losing this one.
      held.set(proposal.id, proposal);
    },
  };
}
