import { err, ok, write, type GraphError, type GraphOptions, type Mutation, type Result, type StorageAdapter, type WriteOutput } from '../graph_store/index.js';
import type { CategoriseOptions, Llm, LlmError } from '../llm/index.js';
import { appError, type AppError } from './errors.js';
import { createItemIdGenerator, type ItemIdGenerator } from './ids.js';
import { normaliseInput, type Normalisers } from './normalise.js';
import { createPendingStore, type PendingProposal } from './pending.js';
import { readCategories, readExisting } from './read-graph.js';
import { describeSummary, summarise } from './summary.js';

/** Errors keep the type of the component that produced them; `source` says which. */
export type ControllerError =
  | { readonly source: 'app'; readonly error: AppError }
  | { readonly source: 'graph'; readonly error: GraphError }
  | { readonly source: 'llm'; readonly error: LlmError };

export interface ControllerInit {
  readonly adapter: StorageAdapter;
  readonly llm: Llm;
  /** Makes the id of each note's item. Default: time-ordered ids like `note-...`. */
  readonly ids?: ItemIdGenerator;
  /** Makes the id of each proposal. Default: `prop-...`. */
  readonly proposalIds?: ItemIdGenerator;
  /** How picture and voice inputs become text. Text needs none. */
  readonly normalisers?: Normalisers;
  readonly graphOptions?: GraphOptions;
  /** The clock in milliseconds, for tests. */
  readonly now?: () => number;
  /** How long a proposal can wait for approval. Default 15 minutes. */
  readonly ttlMs?: number;
  /** Most proposals held at once. Default 100. */
  readonly maxPending?: number;
  /** Most categories shown to the model. Default 500. */
  readonly maxCategories?: number;
}

export interface ProposeOptions {
  /** Passed on to `categorise` (model, tier, time limit, cancellation, limits). */
  readonly categorise?: CategoriseOptions;
}

/** What a successful approval returns. */
export interface Approved {
  /** The proposal that was applied; it is no longer held. */
  readonly proposal: PendingProposal;
  /** What `write` reported. */
  readonly written: WriteOutput;
}

export interface Controller {
  /**
   * Asks the model how to file a note in a graph and holds the answer as a pending proposal.
   * Reads the graph; **writes nothing**.
   */
  propose(graphId: string, input: unknown, options?: ProposeOptions): Promise<Result<PendingProposal, ControllerError>>;
  /**
   * Applies a pending proposal with `write()`, once. The proposal is taken out before the write
   * starts, so a second (or simultaneous) approval finds nothing and writes nothing. If the write
   * fails nothing is changed (a mutation is all-or-nothing) and the proposal is put back, with its
   * original expiry, so it can be tried again or rejected. The preview was computed when the proposal
   * was made; the graph may have changed since, and the write is what decides.
   */
  approve(proposalId: string): Promise<Result<Approved, ControllerError>>;
  /** Discards a pending proposal without writing anything. */
  reject(proposalId: string): Result<PendingProposal, ControllerError>;
  /** A held proposal, unless it is unknown or has expired. */
  get(proposalId: string): PendingProposal | undefined;
}

export const DEFAULT_CONTROLLER_OPTIONS = Object.freeze({ ttlMs: 15 * 60_000, maxPending: 100, maxCategories: 500 });

const app = (error: AppError): Result<never, ControllerError> => err({ source: 'app', error });
const graph = (error: GraphError): Result<never, ControllerError> => err({ source: 'graph', error });
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** The ids of the items and categories a mutation touches, each once. */
function touched(mutation: Mutation): { items: string[]; categories: string[] } {
  const items = new Set<string>();
  const categories = new Set<string>();
  for (const op of mutation.ops) {
    if (op.op === 'upsertNode') (op.partition === 'item' ? items : categories).add(op.id);
    else if (op.op === 'link') {
      items.add(op.item);
      categories.add(op.category);
    }
  }
  return { items: [...items], categories: [...categories] };
}

/**
 * Builds the controller that connects input, the model and the graph. A missing adapter or model
 * component, or a bad setting, is a coding mistake and throws a `TypeError`; every call afterwards
 * returns a result.
 */
export function createController(init: ControllerInit): Controller {
  if (typeof init !== 'object' || init === null) throw new TypeError('createController: expected { adapter, llm }');
  if (typeof init.adapter?.transaction !== 'function') throw new TypeError('createController: `adapter` must be a StorageAdapter');
  if (typeof init.llm?.categorise !== 'function') throw new TypeError('createController: `llm` must come from createLlm()');
  const settings = { ...DEFAULT_CONTROLLER_OPTIONS, ...init };
  for (const key of ['ttlMs', 'maxPending', 'maxCategories'] as const) {
    if (!positive(settings[key])) throw new TypeError(`createController: ${key} must be a positive whole number`);
  }
  const now = init.now ?? Date.now;
  const itemIds = init.ids ?? createItemIdGenerator({ now });
  const proposalIds = init.proposalIds ?? createItemIdGenerator({ now, prefix: 'prop' });
  const store = createPendingStore({ now, ttlMs: settings.ttlMs, maxPending: settings.maxPending });
  const { adapter, llm, graphOptions } = init;

  async function propose(graphId: string, input: unknown, options?: ProposeOptions): Promise<Result<PendingProposal, ControllerError>> {
    try {
      // Refuse before any paid work if there is no room to hold the answer.
      if (!store.hasRoom()) return app(appError('TOO_MANY_PENDING', 'too many proposals are waiting; approve, reject or let some expire first'));
      // The graph is read first: it is cheap, and a note should not be transcribed or sent to a model for a graph that is not there.
      const read = await readCategories(adapter, graphId, settings.maxCategories, graphOptions);
      if (!read.ok) return graph(read.error);

      const note = await normaliseInput(input, init.normalisers);
      if (!note.ok) return app(note.error);

      const id = proposalIds();
      const itemId = itemIds();
      const proposed = await llm.categorise(
        { text: note.value, graphId, itemId, requestId: id, categories: read.value.categories },
        options?.categorise,
      );
      if (!proposed.ok) return err({ source: 'llm', error: proposed.error });

      const { mutation, rationale, usage, model, attempts } = proposed.value;
      const existing = await readExisting(adapter, graphId, touched(mutation), graphOptions);
      if (!existing.ok) return graph(existing.error);
      const summary = summarise(mutation, existing.value);
      if (!summary.ok) return app(summary.error);

      const held = store.add({
        id,
        graphId,
        itemId,
        note: note.value,
        mutation,
        ...(rationale === undefined ? {} : { rationale }),
        summary: summary.value,
        text: describeSummary(summary.value),
        usage,
        model,
        attempts,
        context: { categoriesRead: read.value.categories.length, capped: read.value.capped },
      });
      return held.ok ? ok(held.value) : app(held.error);
    } catch {
      return app(appError('UNEXPECTED', 'propose failed unexpectedly'));
    }
  }

  const unavailable = (state: 'expired' | 'unknown', id: string): Result<never, ControllerError> =>
    state === 'expired'
      ? app(appError('PROPOSAL_EXPIRED', `proposal ${id} ran out of time before it was approved; ask for a new one`))
      : app(appError('PROPOSAL_NOT_FOUND', `no pending proposal ${id}: it is unknown, or it was already approved or rejected`));

  async function approve(proposalId: string): Promise<Result<Approved, ControllerError>> {
    const taken = store.take(proposalId);
    if (taken.state !== 'found') return unavailable(taken.state, String(proposalId));
    const { proposal } = taken;
    try {
      const written = await write(adapter, proposal.mutation, graphOptions);
      if (!written.ok) {
        store.restore(proposal);
        return graph(written.error);
      }
      return ok(Object.freeze({ proposal, written: written.value }));
    } catch {
      store.restore(proposal);
      return app(appError('UNEXPECTED', 'approve failed unexpectedly; the proposal was kept'));
    }
  }

  function reject(proposalId: string): Result<PendingProposal, ControllerError> {
    const taken = store.take(proposalId);
    return taken.state === 'found' ? ok(taken.proposal) : unavailable(taken.state, String(proposalId));
  }

  return Object.freeze({ propose, approve, reject, get: (proposalId: string) => store.get(proposalId) });
}
