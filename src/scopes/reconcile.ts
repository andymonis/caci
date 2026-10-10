import type { CircleStore } from '../circles/index.js';
import { createGraph, dropGraph, listGraphs, type StorageAdapter } from '../graph_store/index.js';
import { err, ok, scopesError, type ScopesResult } from './errors.js';
import { circleGraphId, circleIdOfGraph } from './scope.js';

// Circle records live in `users.db` and circle graphs in `graphs.db`, so they can drift apart: a circle
// dissolved by the account-deletion trigger leaves a graph, a crash between two steps leaves a circle with no
// graph. `reconcileCircleGraphs` puts them back in step and is safe to run at any time and any number of times.
// It touches only graphs named `circle-<circle id>`; nothing else is ever created or dropped.

const PAGE = 200;
const MAX_PAGES = 100_000;
const STORAGE = 'the scopes service could not complete the request';

export interface ReconcileInit {
  /** Only the list of circle ids is used. */
  readonly circles: Pick<CircleStore, 'listCircleIds'>;
  readonly graphAdapter: StorageAdapter;
  /** The most graphs one run will drop. More than this means the listing is probably wrong, so none is dropped. Default 100. */
  readonly maxDrops?: number;
}

export interface ReconcileReport {
  /** Circles whose graph was missing and was created. */
  readonly created: readonly string[];
  /** Circles that no longer exist whose graph was dropped. */
  readonly dropped: readonly string[];
  /** Circles that no longer exist whose graph was NOT dropped because there were more than `maxDrops` of them. */
  readonly skipped: readonly string[];
}

/** What to do, from the circle ids and the graph ids that exist. Pure: other graphs and look-alike names are never in the plan. */
export function planReconcile(circleIds: Iterable<string>, graphIds: Iterable<string>): { create: string[]; drop: string[] } {
  const circles = new Set(circleIds);
  const graphs = new Set<string>();
  for (const id of graphIds) {
    const circle = circleIdOfGraph(id);
    if (circle !== undefined) graphs.add(circle);
  }
  return { create: [...circles].filter((c) => !graphs.has(c)).sort(), drop: [...graphs].filter((c) => !circles.has(c)).sort() };
}

/** Every item of a paged listing, stopping with `undefined` if a page fails or the cursor does not move on. */
async function everything<T>(fetch: (cursor: string | null) => Promise<{ items: readonly T[]; nextCursor: string | null } | undefined>): Promise<T[] | undefined> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetch(cursor);
    if (page === undefined) return undefined;
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (seen.has(page.nextCursor)) return undefined;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return undefined;
}

/**
 * Creates the graph of every circle that has none and drops the graph of every circle that is gone. Graphs are
 * listed **before** circles, so a circle created during the run is never mistaken for a missing one (a circle
 * record is always made before its graph). Both listings must complete before anything is changed; a failure
 * anywhere is the one fixed storage error, and whatever was done before it stays done (the next run continues).
 */
export function reconcileCircleGraphs(init: ReconcileInit): Promise<ScopesResult<ReconcileReport>> {
  const maxDrops = init?.maxDrops ?? 100;
  if (typeof init?.circles?.listCircleIds !== 'function' || init.graphAdapter === undefined || !Number.isInteger(maxDrops) || maxDrops < 0) {
    throw new TypeError('reconcileCircleGraphs needs a circle store (listCircleIds), a graph adapter and a whole-number maxDrops of 0 or more');
  }
  return run(init, maxDrops);
}

async function run(init: ReconcileInit, maxDrops: number): Promise<ScopesResult<ReconcileReport>> {
  try {
    const graphIds = await everything<string>(async (cursor) => {
      const r = await listGraphs(init.graphAdapter, { limit: PAGE, cursor });
      return r.ok ? r.value : undefined;
    });
    if (graphIds === undefined) return err(scopesError('STORAGE_ERROR', STORAGE));
    const circleIds = await everything<string>((cursor) => init.circles.listCircleIds({ limit: PAGE, cursor }));
    if (circleIds === undefined) return err(scopesError('STORAGE_ERROR', STORAGE));
    const plan = planReconcile(circleIds, graphIds);
    const created: string[] = [];
    for (const circle of plan.create) {
      const r = await createGraph(init.graphAdapter, circleGraphId(circle));
      if (r.ok) created.push(circle);
      else if (r.error.code !== 'CONFLICT') return err(scopesError('STORAGE_ERROR', STORAGE));
    }
    const dropped: string[] = [];
    let skipped: string[] = [];
    if (plan.drop.length > maxDrops) skipped = plan.drop;
    else {
      for (const circle of plan.drop) {
        const r = await dropGraph(init.graphAdapter, circleGraphId(circle));
        if (r.ok) dropped.push(circle);
        else if (r.error.code !== 'GRAPH_NOT_FOUND') return err(scopesError('STORAGE_ERROR', STORAGE));
      }
    }
    return ok(Object.freeze({ created: Object.freeze(created), dropped: Object.freeze(dropped), skipped: Object.freeze(skipped) }));
  } catch {
    return err(scopesError('STORAGE_ERROR', STORAGE));
  }
}
