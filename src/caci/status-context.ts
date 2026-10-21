import type { JsonObject, StorageAdapter } from '../graph_store/index.js';
import { err, ok, query, type Result } from '../graph_store/index.js';
import type { StatusEntry } from '../llm/index.js';
import type { Provenance, ResolvedScope } from '../scopes/index.js';
import type { CaciError } from './errors.js';

// The context of a status request (R-011): what the person can read, as numbered entries, newest first, within a
// size budget. Every scope is read on its own through the public `query` and never merged; an entry keeps the
// provenance of the scope it came from (kept beside the entries, never sent to the model as anything but a label).
// Nothing is written and nothing is kept.

export interface StatusContextLimits {
  /** Characters (entry text plus where it came from) over all entries. Default 12,000. */
  readonly maxTotalChars?: number;
  /** One entry's text is cut to this many characters. Default 600. */
  readonly maxEntryChars?: number;
  /** The newest this many items of each scope are candidates. Default 200. */
  readonly maxPerScope?: number;
  /** At most this many items of one scope are read at all. Default 2,000. */
  readonly maxReadPerScope?: number;
  /** Graphs read at the same time. Default 4. */
  readonly maxConcurrentReads?: number;
}

export const DEFAULT_STATUS_CONTEXT_LIMITS = Object.freeze({ maxTotalChars: 12_000, maxEntryChars: 600, maxPerScope: 200, maxReadPerScope: 2000, maxConcurrentReads: 4 });

export interface StatusContext {
  /** The numbered entries (position + 1 is the number), newest first. */
  readonly entries: readonly StatusEntry[];
  /** Where each entry came from, in the same order. */
  readonly provenance: readonly Provenance[];
  /** The graph id of each entry's item, in the same order (never sent to the model; the controller turns it into a fact reference). */
  readonly ids: readonly string[];
  /** Items read and not used (too old for the budget or beyond the per-scope cap). */
  readonly entriesLeftOut: number;
}

const PAGE = 500;
const BATCH = 50;
const NAME_CLIP = 60;
const EXTRA_KEYS = 5;
const STAMP_KEYS = ['contributedBy', 'contributedAt', 'title', 'summary'] as const;

const clip = (text: string, max: number): string => [...text].slice(0, max).join('');
const oneLine = (text: string): string => text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
const isMissingGraph = (e: CaciError): boolean => e.source === 'graph' && e.error.code === 'GRAPH_NOT_FOUND';
/** Plain code-unit order, so nothing depends on the machine's locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The time an item was made: a circle item's `contributedAt`, else the time inside a minted id (`note-<9 base-36 digits>-...`), else unknown. */
export function timeOf(id: string, data: JsonObject | undefined, now: number): number | undefined {
  const stamp = data?.contributedAt;
  if (typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 86_400_000) return stamp;
  const m = /^[a-z]+-([0-9a-z]{9})-/.exec(id);
  if (m !== null) {
    const ms = Number.parseInt(m[1] as string, 36);
    if (Number.isSafeInteger(ms) && ms >= Date.UTC(2020, 0, 1) && ms <= now + 86_400_000) return ms;
  }
  return undefined;
}

function textOf(data: JsonObject | undefined, categories: readonly string[], maxChars: number): string {
  const parts: string[] = [];
  const title = typeof data?.title === 'string' ? oneLine(data.title) : '';
  const summary = typeof data?.summary === 'string' ? oneLine(data.summary) : '';
  if (title !== '' && summary !== '') parts.push(`${clip(title, 120)}: ${clip(summary, 300)}`);
  else if (title !== '' || summary !== '') parts.push(clip(title || summary, 300));
  let extras = 0;
  for (const [key, value] of Object.entries(data ?? {})) {
    if ((STAMP_KEYS as readonly string[]).includes(key) || extras >= EXTRA_KEYS) continue;
    const shown = typeof value === 'string' ? oneLine(value) : JSON.stringify(value) ?? '';
    if (shown === '') continue;
    parts.push(`${clip(oneLine(key), 30)}: ${clip(shown, 100)}`);
    extras++;
  }
  if (categories.length > 0) parts.push(`filed under ${categories.slice(0, 8).map((c) => clip(oneLine(c), 40)).join(', ')}`);
  return clip(parts.join('; ') || '(no text)', maxChars);
}

interface Candidate {
  readonly scopeIndex: number;
  readonly id: string;
  readonly when: number | undefined;
  readonly data: JsonObject | undefined;
}

type NodesOut = { nodes: Array<{ partition: string; id: string; data?: JsonObject }>; nextCursor: string | null };
type SubgraphOut = { nodes: Array<{ partition: string; id: string; data?: JsonObject }>; edges: Array<{ item: string; category: string }>; nextCursor: string | null; truncated?: boolean };

export function createStatusContext(adapter: StorageAdapter, limits: StatusContextLimits = {}) {
  const settings = { ...DEFAULT_STATUS_CONTEXT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`createCaciController: status ${name} must be a positive whole number`);
  }

  const read = async (graphId: string, input: Record<string, unknown>): Promise<Result<unknown, CaciError>> => {
    const r = await query(adapter, { version: 1, graphId, ...input });
    return r.ok ? ok(r.value) : err({ source: 'graph', error: r.error });
  };

  /** The newest items of one scope, with the number read (to say how many were left out). */
  async function candidates(r: ResolvedScope, scopeIndex: number, now: number): Promise<Result<{ items: Candidate[]; read: number }, CaciError>> {
    const items: Candidate[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < Math.ceil(settings.maxReadPerScope / PAGE) + 1 && items.length < settings.maxReadPerScope; pages++) {
      const listed = await read(r.graphId, { from: { all: true }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true }, page: { limit: PAGE, ...(cursor === null ? {} : { cursor }) } });
      if (!listed.ok) return listed;
      const out = listed.value as NodesOut;
      for (const n of out.nodes) if (n.partition === 'item' && items.length < settings.maxReadPerScope) items.push({ scopeIndex, id: n.id, when: timeOf(n.id, n.data, now), data: n.data });
      if (out.nextCursor === null) break;
      cursor = out.nextCursor;
    }
    const newest = [...items].sort((a, b) => (b.when ?? -1) - (a.when ?? -1) || byText(a.id, b.id)).slice(0, settings.maxPerScope);
    return ok({ items: newest, read: items.length });
  }

  /** Category names (or ids) for the given items, from edges read through named seeds. */
  async function categoriesOf(graphId: string, ids: readonly string[]): Promise<Result<Map<string, string[]>, CaciError>> {
    const found = new Map<string, string[]>();
    for (let at = 0; at < ids.length; at += BATCH) {
      let cursor: string | null = null;
      for (let pages = 0; pages < 10; pages++) {
        const r = await read(graphId, { from: { partition: 'item', ids: ids.slice(at, at + BATCH) }, traverse: { depth: 1 }, return: { shape: 'subgraph', includeData: true }, page: { limit: 1000, ...(cursor === null ? {} : { cursor }) } });
        if (!r.ok) return r;
        const out = r.value as SubgraphOut;
        const names = new Map(out.nodes.filter((n) => n.partition === 'category').map((n) => [n.id, typeof n.data?.name === 'string' && n.data.name !== '' ? n.data.name : n.id] as const));
        for (const e of out.edges) found.set(e.item, [...(found.get(e.item) ?? []), names.get(e.category) ?? e.category]);
        if (out.nextCursor === null) break;
        cursor = out.nextCursor;
      }
    }
    for (const [id, list] of found) found.set(id, [...new Set(list)].sort(byText));
    return ok(found);
  }

  return {
    /** Builds the context from the scopes the person may read right now, in the order given (their own brain first). */
    async read(readable: readonly ResolvedScope[], now: number): Promise<Result<StatusContext, CaciError>> {
      const perScope: Array<{ items: Candidate[]; read: number } | undefined> = [];
      for (let at = 0; at < readable.length; at += settings.maxConcurrentReads) {
        const chunk = readable.slice(at, at + settings.maxConcurrentReads);
        const results = await Promise.all(chunk.map((r, k) => candidates(r, at + k, now)));
        for (const [k, result] of results.entries()) {
          const r = chunk[k] as ResolvedScope;
          if (result.ok) perScope[at + k] = result.value;
          else if (r.scope.kind === 'circle' && isMissingGraph(result.error)) perScope[at + k] = undefined; // a circle without its graph contributes nothing
          else return result;
        }
      }
      const all = perScope.flatMap((s) => s?.items ?? []);
      const totalRead = perScope.reduce((n, s) => n + (s?.read ?? 0), 0);
      all.sort((a, b) => (b.when ?? -1) - (a.when ?? -1) || a.scopeIndex - b.scopeIndex || byText(a.id, b.id));

      // Take newest first until the budget is spent. Category names are read only for the items that were taken.
      const chosen: Candidate[] = [];
      let used = 0;
      for (const c of all) {
        const where = whereOf((readable[c.scopeIndex] as ResolvedScope).provenance);
        const size = textOf(c.data, [], settings.maxEntryChars).length + where.length + 30; // 30 for the category names that may be added
        if (used + size > settings.maxTotalChars) break;
        used += size;
        chosen.push(c);
      }
      const entries: StatusEntry[] = [];
      const provenance: Provenance[] = [];
      const ids: string[] = [];
      const names = new Map<number, Map<string, string[]>>();
      for (const index of new Set(chosen.map((c) => c.scopeIndex))) {
        const got = await categoriesOf((readable[index] as ResolvedScope).graphId, chosen.filter((c) => c.scopeIndex === index).map((c) => c.id));
        if (!got.ok) return got;
        names.set(index, got.value);
      }
      for (const c of chosen) {
        const scope = readable[c.scopeIndex] as ResolvedScope;
        entries.push(Object.freeze({ where: whereOf(scope.provenance), text: textOf(c.data, names.get(c.scopeIndex)?.get(c.id) ?? [], settings.maxEntryChars), ...(c.when === undefined ? {} : { when: c.when }) }));
        provenance.push(scope.provenance);
        ids.push(c.id);
      }
      return ok(Object.freeze({ entries: Object.freeze(entries), provenance: Object.freeze(provenance), ids: Object.freeze(ids), entriesLeftOut: totalRead - chosen.length }));
    },
  };
}

/** How an entry's scope is named to the model: `personal`, or `circle "Name"` with the name cut and quoted as text. */
export function whereOf(scope: Provenance): string {
  return scope.kind === 'personal' ? 'personal' : `circle ${JSON.stringify(clip(oneLine(scope.circleName), NAME_CLIP))}`;
}
