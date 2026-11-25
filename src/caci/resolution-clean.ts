import { query, type StorageAdapter } from '../graph_store/index.js';
import type { ResolutionStore, ResolvedFact } from '../resolutions/index.js';
import { circleGraphId } from '../scopes/index.js';

// The clean of resolutions (R-025 D16): a record whose fact no longer exists (it was replaced, deleted or its circle went) is of no use and is
// removed. A run is bounded; the next one carries on where it stopped, so a big table is swept over several runs. Nothing is removed on a
// doubt: a graph that cannot be read ends the run with a failure and everything stays.

export interface ResolutionCleanInit {
  readonly resolutions: ResolutionStore;
  readonly graphAdapter: StorageAdapter;
  /** The most distinct facts checked in one run. Default 5,000. */
  readonly maxFacts?: number;
}

export interface CleanReport {
  /** Facts checked this run. */
  readonly checked: number;
  /** Records removed this run. */
  readonly removed: number;
  /** True when this run reached the end of the table (the next one starts again from the beginning). */
  readonly complete: boolean;
}

export interface ResolutionCleaner {
  /** One bounded sweep. Throws when a graph or the store cannot be read, leaving everything it had not yet removed. */
  run(): Promise<CleanReport>;
}

const PAGE = 100;

export function createResolutionCleaner(init: ResolutionCleanInit): ResolutionCleaner {
  const { resolutions, graphAdapter } = init;
  const maxFacts = init.maxFacts ?? 5000;
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 1) throw new TypeError('createResolutionCleaner: maxFacts must be a positive whole number');
  let after: ResolvedFact | undefined;

  /** Whether the fact is gone: no such item, or no such graph (the circle was deleted). Any other failure is thrown. */
  async function gone(fact: ResolvedFact): Promise<boolean> {
    if (fact.scope.kind !== 'circle') return false; // a controller never makes a personal one, and an account's go with it: leave them be
    const r = await query(graphAdapter, { version: 1, graphId: circleGraphId(fact.scope.circleId), from: { partition: 'item', ids: [fact.factId] }, traverse: { depth: 0 }, return: { shape: 'ids' } });
    if (!r.ok) {
      if (r.error.code === 'GRAPH_NOT_FOUND') return true;
      throw new Error('a graph could not be read');
    }
    return (r.value as { ids: unknown[] }).ids.length === 0;
  }

  return Object.freeze({
    async run(): Promise<CleanReport> {
      let checked = 0;
      let removed = 0;
      while (checked < maxFacts) {
        const page = await resolutions.facts({ limit: Math.min(PAGE, maxFacts - checked), ...(after === undefined ? {} : { after }) });
        for (const fact of page.items) {
          checked++;
          if (await gone(fact)) removed += await resolutions.removeFact(fact.scope, fact.factId);
          after = fact;
        }
        if (!page.hasMore) {
          after = undefined;
          return Object.freeze({ checked, removed, complete: true });
        }
      }
      return Object.freeze({ checked, removed, complete: false });
    },
  });
}
