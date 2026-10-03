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

export interface PendingStore {
  /** Holds a proposal for `ttlMs`. Expired ones are dropped first; a full store refuses rather than forget someone's proposal. */
  add(proposal: NewProposal): Result<PendingProposal, AppError>;
  /** The proposal, unless it is unknown or has expired. */
  get(id: string): PendingProposal | undefined;
}

export interface PendingStoreOptions {
  readonly now: () => number;
  readonly ttlMs: number;
  readonly maxPending: number;
}

/** An in-memory store of pending proposals, one per controller. */
export function createPendingStore(options: PendingStoreOptions): PendingStore {
  const { now, ttlMs, maxPending } = options;
  const held = new Map<string, PendingProposal>();
  const alive = (p: PendingProposal): boolean => now() < p.expiresAt;
  const sweep = (): void => {
    for (const [id, p] of held) if (!alive(p)) held.delete(id);
  };
  return {
    add(proposal) {
      sweep();
      if (held.has(proposal.id)) return err(appError('UNEXPECTED', `a proposal with id ${proposal.id} is already held`));
      if (held.size >= maxPending) {
        return err(appError('TOO_MANY_PENDING', `${held.size} proposals are already waiting; approve, reject or let some expire first`));
      }
      const createdAt = now();
      const entry: PendingProposal = Object.freeze({ ...proposal, createdAt, expiresAt: createdAt + ttlMs });
      held.set(entry.id, entry);
      return ok(entry);
    },
    get(id) {
      const p = held.get(id);
      if (p === undefined) return undefined;
      if (alive(p)) return p;
      held.delete(id);
      return undefined;
    },
  };
}
