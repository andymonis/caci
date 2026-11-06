import { madeAt, readCandidates } from '../app/index.js';
import { err, ok, query, type JsonObject, type Result, type StorageAdapter } from '../graph_store/index.js';
import type { CaciError } from './errors.js';

/** Facts found by words (R-022): the candidate search of R-014, offered to an agent. Read-only, through the public `query`. */
export const DEFAULT_SEARCH_RESULTS = 20;
export const MAX_SEARCH_RESULTS = 50;

export interface FactHit {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The fact's key (R-015), when it has one. */
  readonly key?: string;
  /** When it was entered: a circle item's stamp, else the time inside a minted id, when either is known. */
  readonly at?: number;
  /** Who entered it, where the brain records that (a circle's items) and the account still exists. */
  readonly by?: { readonly username: string; readonly displayName: string };
}

type Directory = { get(id: string): Promise<{ readonly username: string; readonly displayName: string } | undefined> } | undefined;

const graphFailure = (error: unknown): CaciError => ({ source: 'graph', error: error as never });

/** The facts of one graph that share meaningful words with `text`: facts whose key is in the text first, then by shared words, newest first. */
export async function searchFacts(adapter: StorageAdapter, graphId: string, text: string, limit: number, directory: Directory): Promise<Result<readonly FactHit[], CaciError>> {
  const found = await readCandidates(adapter, graphId, text, { maxCandidates: limit, maxChars: 200_000 });
  if (!found.ok) return err(graphFailure(found.error));
  if (found.value.length === 0) return ok(Object.freeze([]));
  const ids = found.value.map((c) => c.id);
  const read = await query(adapter, { version: 1, graphId, from: { partition: 'item', ids }, traverse: { depth: 0 }, return: { shape: 'nodes', includeData: true }, page: { limit: ids.length, cursor: null } });
  if (!read.ok) return err(graphFailure(read.error));
  const out = read.value;
  const data = new Map<string, JsonObject | undefined>();
  if ('nodes' in out) for (const node of out.nodes) data.set(node.id, node.data);
  const names = new Map<string, { username: string; displayName: string } | undefined>();
  const hits: FactHit[] = [];
  for (const c of found.value) {
    const d = data.get(c.id);
    const stamp = typeof d?.contributedAt === 'number' ? d.contributedAt : undefined;
    const at = stamp !== undefined && Number.isSafeInteger(stamp) && stamp > 0 ? stamp : madeAt(c.id, d) || undefined;
    let by: FactHit['by'];
    const who = d?.contributedBy;
    if (typeof who === 'string' && directory !== undefined) {
      if (!names.has(who)) {
        try {
          const u = await directory.get(who);
          names.set(who, u === undefined ? undefined : { username: u.username, displayName: u.displayName });
        } catch {
          names.set(who, undefined);
        }
      }
      const n = names.get(who);
      if (n !== undefined) by = Object.freeze({ ...n });
    }
    hits.push(Object.freeze({ id: c.id, title: c.title, summary: c.summary, ...(c.key === undefined ? {} : { key: c.key }), ...(at === undefined ? {} : { at }), ...(by === undefined ? {} : { by }) }));
  }
  return ok(Object.freeze(hits));
}
