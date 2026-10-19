import { err, ok, parseMutation, query, write, type GraphError, type GraphOptions, type JsonValue, type Mutation, type Result, type StorageAdapter, type WriteOutput } from '../graph_store/index.js';
import type { CategoriseOptions, Llm, LlmError } from '../llm/index.js';
import { readCandidates, type Candidate, type CandidateOptions } from './candidates.js';
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
  /**
   * How existing notes that a new note might replace are found and offered to the model (R-014): `false` switches replacing off
   * (the service does this when the controls' `maxReplaces` is 0), an object tunes the search. Default: on, with the defaults.
   */
  readonly candidates?: CandidateOptions | false;
  /** Told, with a fixed sentence and no note text or ids, when something that must not fail an approval did (for example the tidy). Never throws into the caller. */
  readonly onWarning?: (message: string) => void;
}

export interface ProposeOptions {
  /** Passed on to `categorise` (model, tier, time limit, cancellation, limits). */
  readonly categorise?: CategoriseOptions;
  /**
   * Who is adding this note, to be recorded on the item it creates (`contributedBy`, and `contributedAt` from the
   * controller's clock). Set by trusted code after the model has answered; whatever the model put under those two
   * names, on any node, is removed first, so the model cannot set, replace or forge them.
   */
  readonly stamp?: { readonly contributedBy: string };
}

/** What a successful approval returns. */
export interface Approved {
  /** The proposal that was applied; it is no longer held. */
  readonly proposal: PendingProposal;
  /** What `write` reported. */
  readonly written: WriteOutput;
  /** Categories removed afterwards because the notes this one replaced were the only ones in them (R-014 D9). Empty for none. */
  readonly tidied: readonly TidiedCategory[];
}

/** A category that was removed because it was left with no notes. */
export interface TidiedCategory {
  readonly id: string;
  readonly name?: string;
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
  const candidateOptions = init.candidates === false ? undefined : (init.candidates ?? {});

  /** The mutation with the two contribution fields removed from every upsert and then set on every item (fact) this proposal creates. */
  function stamped(mutation: Mutation, contributedBy: string, at: number): Mutation {
    const ops = mutation.ops.map((op) => {
      if (op.op !== 'upsertNode') return op;
      const data = { ...((op.data ?? {}) as Record<string, JsonValue>) };
      delete data.contributedBy;
      delete data.contributedAt;
      return { ...op, data: op.partition === 'item' ? { ...data, contributedBy, contributedAt: at } : data } as typeof op;
    });
    return { ...mutation, ops } as Mutation;
  }

  async function propose(graphId: string, input: unknown, options?: ProposeOptions): Promise<Result<PendingProposal, ControllerError>> {
    try {
      // Refuse before any paid work if there is no room to hold the answer.
      if (!store.hasRoom()) return app(appError('TOO_MANY_PENDING', 'too many proposals are waiting; approve, reject or let some expire first'));
      // The graph is read first: it is cheap, and a note should not be transcribed or sent to a model for a graph that is not there.
      const read = await readCategories(adapter, graphId, settings.maxCategories, graphOptions);
      if (!read.ok) return graph(read.error);

      const note = await normaliseInput(input, init.normalisers);
      if (!note.ok) return app(note.error);

      // The notes this one might replace: found here, by the controller, from this graph only (R-014).
      let candidates: Candidate[] = [];
      if (candidateOptions !== undefined) {
        const found = await readCandidates(adapter, graphId, note.value, candidateOptions, graphOptions);
        if (!found.ok) return graph(found.error);
        candidates = found.value;
      }

      const id = proposalIds();
      const itemId = itemIds();
      const proposed = await llm.categorise(
        { text: note.value, graphId, itemId, requestId: id, categories: read.value.categories, existing: candidates.map((c) => ({ title: c.title, summary: c.summary, ...(c.key === undefined ? {} : { key: c.key }) })) },
        options?.categorise,
      );
      if (!proposed.ok) return err({ source: 'llm', error: proposed.error });

      const { rationale, usage, model, attempts } = proposed.value;
      let mutation = options?.stamp === undefined ? proposed.value.mutation : stamped(proposed.value.mutation, options.stamp.contributedBy, now());
      // The model named numbers; the ids come from what the controller found, and the deletes are built here, never by the model.
      // (the guard has already checked that each number is one of those shown, and that none is repeated)
      const replaced = proposed.value.replaces.map((n) => candidates[n - 1] as Candidate);
      if (replaced.length > 0) {
        const deletes = replaced.map((c) => ({ op: 'deleteNode' as const, partition: 'item' as const, id: c.id }));
        const checked = parseMutation({ ...mutation, ops: [...deletes, ...mutation.ops] }, graphOptions);
        if (!checked.ok) return graph(checked.error);
        mutation = checked.value;
      }
      const existing = await readExisting(adapter, graphId, touched(mutation), graphOptions);
      if (!existing.ok) return graph(existing.error);
      const summary = summarise(mutation, existing.value, replaced);
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

  const warn = (message: string): void => {
    try {
      init.onWarning?.(message);
    } catch {
      // a warning hook must never change what happens
    }
  };

  /** The categories the given items are filed under, with their names (read before the items are deleted, while their links exist). */
  async function categoriesOf(graphId: string, itemIds: readonly string[]): Promise<Result<TidiedCategory[], GraphError>> {
    const out: TidiedCategory[] = [];
    let cursor: string | null = null;
    do {
      const r = await query(adapter, { version: 1, graphId, from: { partition: 'item', ids: [...itemIds] }, traverse: { depth: 1 }, filter: { partition: 'category' }, return: { shape: 'nodes', includeData: true }, page: { limit: 200, cursor } }, graphOptions);
      if (!r.ok) return r;
      if (!('nodes' in r.value)) return err({ code: 'STORAGE_ERROR', message: 'a categories listing did not return nodes' });
      for (const n of r.value.nodes) if (n.partition === 'category') out.push(typeof n.data?.name === 'string' ? { id: n.id, name: n.data.name } : { id: n.id });
      cursor = r.value.nextCursor;
    } while (cursor !== null && out.length < 1000);
    return ok(out);
  }

  /** Removes those categories that now hold no items. Idempotent; a category the new note links to has an item and stays. */
  async function tidy(graphId: string, candidates: readonly TidiedCategory[]): Promise<TidiedCategory[]> {
    const done: TidiedCategory[] = [];
    for (const category of candidates) {
      const counted = await query(adapter, { version: 1, graphId, from: { partition: 'category', ids: [category.id] }, traverse: { depth: 1 }, filter: { partition: 'item' }, return: { shape: 'count' } }, graphOptions);
      if (!counted.ok || !('count' in counted.value)) throw new Error('could not count');
      if (counted.value.count > 0) continue;
      const removed = await write(adapter, { version: 1, kind: 'mutation', graphId, createIfMissing: false, ops: [{ op: 'deleteNode', partition: 'category', id: category.id }] }, graphOptions);
      if (!removed.ok) throw new Error('could not remove');
      done.push(category);
    }
    return done;
  }

  async function approve(proposalId: string): Promise<Result<Approved, ControllerError>> {
    const taken = store.take(proposalId);
    if (taken.state !== 'found') return unavailable(taken.state, String(proposalId));
    const { proposal } = taken;
    try {
      // What the removed notes were filed under, while their links still exist (for the tidy after the write).
      let affected: TidiedCategory[] = [];
      if (proposal.summary.removed.length > 0) {
        const before = await categoriesOf(proposal.graphId, proposal.summary.removed.map((r) => r.id)).catch(() => undefined);
        if (before?.ok === true) affected = before.value;
        else warn('could not read which categories the replaced notes were in, so empty categories will not be tidied');
      }
      const written = await write(adapter, proposal.mutation, graphOptions);
      if (!written.ok) {
        store.restore(proposal);
        return graph(written.error);
      }
      let tidied: TidiedCategory[] = [];
      if (affected.length > 0) {
        try {
          tidied = await tidy(proposal.graphId, affected);
        } catch {
          warn('could not tidy the categories left empty by a replacement; they will stay until the next replacement or by hand');
        }
      }
      return ok(Object.freeze({ proposal, written: written.value, tidied: Object.freeze(tidied) }));
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
