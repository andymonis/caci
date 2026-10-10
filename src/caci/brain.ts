import { createHash } from 'node:crypto';
import type { CircleRole } from '../circles/index.js';
import { authoriseBrain, type Provenance, type ResolvedScope } from '../scopes/index.js';
import { err, ok, type Result } from '../graph_store/index.js';
import { pageOf, type CategoryItemsPage, type CategoryView, type createBrowser, type GraphSummary, type ItemDetail, type ItemView, type PageInput } from './browse.js';
import { caciError, type CaciError } from './errors.js';

// My Brain (R-009): one view over the person's own brain and every circle brain they may read, built by reading
// each graph on its own and never merging them. Everything here carries where it came from; two nodes with the
// same id in two scopes are two results. Nothing is written and nothing is kept between requests.

/** A scope the person may use, for choosing one: where it is, their role there, and whether they may capture into it. */
export interface BrainScope {
  readonly scope: Provenance;
  readonly role?: CircleRole;
  readonly canCapture: boolean;
}

/** Counts across every readable scope, and for each scope on its own. */
export interface MineSummary extends GraphSummary {
  readonly scopes: ReadonlyArray<GraphSummary & { readonly scope: Provenance }>;
}

export interface MineCategory extends CategoryView {
  readonly scope: Provenance;
}
export interface MineCategoryPage {
  readonly items: readonly MineCategory[];
  readonly nextCursor: string | null;
}

/** The items of one category of one scope: the category's identity is the scope and its id. */
export interface MineCategoryItemsPage extends Omit<CategoryItemsPage, 'scope' | 'items'> {
  readonly scope: Provenance;
  readonly items: ReadonlyArray<ItemView & { readonly scope: Provenance }>;
}
/** One item of one scope, and the categories (of that same scope) it is filed under. */
export interface MineItemDetail extends Omit<ItemDetail, 'scope' | 'item' | 'categories'> {
  readonly scope: Provenance;
  readonly item: ItemView & { readonly scope: Provenance };
  readonly categories: ReadonlyArray<ItemDetail['categories'][number] & { readonly scope: Provenance }>;
}

export interface BrainLimits {
  /** Graphs read at the same time when counting. Default 4. */
  readonly maxConcurrentReads?: number;
}

type Browser = ReturnType<typeof createBrowser>;

const keyOf = (r: ResolvedScope): string => (r.scope.kind === 'personal' ? 'personal' : `circle:${r.scope.circleId}`);

/** What a cursor is bound to: the person, the view and exactly which scopes were readable, in order. */
const fingerprint = (userId: string, view: string, parts: readonly string[]): string => createHash('sha256').update(JSON.stringify([userId, view, parts])).digest('hex').slice(0, 32);

interface Position {
  /** Which scope, by place in the readable list. */
  readonly i: number;
  /** The graph store's own cursor inside that scope, or null at its start. */
  readonly c: string | null;
}
const encode = (view: string, fp: string, at: Position): string => Buffer.from(JSON.stringify({ v: 1, w: view, f: fp, i: at.i, c: at.c }), 'utf8').toString('base64url');
function decode(cursor: string, view: string, fp: string, count: number): Position | undefined {
  if (cursor.length > 2048) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const p = parsed as { v?: unknown; w?: unknown; f?: unknown; i?: unknown; c?: unknown };
  // the version, the view and the fingerprint are checked by re-encoding below: a cursor is accepted only if it is exactly what we would have given
  if (p === null || typeof p !== 'object' || !Number.isSafeInteger(p.i) || (p.i as number) < 0 || (p.i as number) >= count || !(p.c === null || typeof p.c === 'string')) return undefined;
  const at = { i: p.i as number, c: p.c as string | null };
  return encode(view, fp, at) === cursor ? at : undefined; // one spelling only
}
const badCursor = (): CaciError => caciError('INVALID_INPUT', 'cursor is not one this service gave for this view', { field: 'cursor' });
const isMissingGraph = (e: CaciError): boolean => e.source === 'graph' && e.error.code === 'GRAPH_NOT_FOUND';

export function createBrain(browser: Browser, limits: BrainLimits = {}) {
  const concurrency = limits.maxConcurrentReads ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('createCaciController: maxConcurrentReads must be a positive whole number');

  return {
    scopes(readable: readonly ResolvedScope[]): readonly BrainScope[] {
      return Object.freeze(
        readable.map((r) => Object.freeze({ scope: r.provenance, ...(r.role === undefined ? {} : { role: r.role }), canCapture: r.role === undefined || authoriseBrain(r.role, 'capture') })),
      );
    },

    async summary(readable: readonly ResolvedScope[]): Promise<Result<MineSummary, CaciError>> {
      const rows: Array<GraphSummary & { scope: Provenance }> = [];
      for (let at = 0; at < readable.length; at += concurrency) {
        const chunk = readable.slice(at, at + concurrency);
        const results = await Promise.all(chunk.map((r) => browser.summary(r.graphId)));
        for (const [k, result] of results.entries()) {
          const r = chunk[k] as ResolvedScope;
          if (result.ok) rows.push({ ...result.value, scope: r.provenance });
          else if (r.scope.kind === 'circle' && isMissingGraph(result.error)) rows.push({ itemCount: 0, categoryCount: 0, edgeCount: 0, scope: r.provenance });
          else return result;
        }
      }
      const total = (pick: (s: GraphSummary) => number): number => rows.reduce((n, s) => n + pick(s), 0);
      return ok(Object.freeze({ itemCount: total((s) => s.itemCount), categoryCount: total((s) => s.categoryCount), edgeCount: total((s) => s.edgeCount), scopes: Object.freeze(rows.map((s) => Object.freeze(s))) }));
    },

    /** The items of one category in one resolved scope; the cursor is bound to the person, that scope and that category. */
    async categoryItems(userId: string, where: ResolvedScope, categoryId: unknown, input: PageInput | undefined): Promise<Result<MineCategoryItemsPage, CaciError>> {
      const page = pageOf(input);
      if (!page.ok) return page;
      const fp = fingerprint(userId, 'items', [keyOf(where), typeof categoryId === 'string' ? categoryId : '']);
      let inner: string | null = null;
      if (page.value.cursor !== null) {
        const decoded = decode(page.value.cursor, 'items', fp, 1);
        if (decoded === undefined) return err(badCursor());
        inner = decoded.c;
      }
      const listed = await browser.categoryItems(where.graphId, categoryId, { limit: page.value.limit, ...(inner === null ? {} : { cursor: inner }) });
      if (!listed.ok) return listed;
      const { category, items, nextCursor } = listed.value;
      return ok(Object.freeze({ scope: where.provenance, category, items: Object.freeze(items.map((i) => Object.freeze({ ...i, scope: where.provenance }))), nextCursor: nextCursor === null ? null : encode('items', fp, { i: 0, c: nextCursor }) }));
    },

    /** One item of one resolved scope, with its categories, all tagged. */
    async item(where: ResolvedScope, itemId: unknown): Promise<Result<MineItemDetail, CaciError>> {
      const found = await browser.item(where.graphId, itemId);
      if (!found.ok) return found;
      const { item, categories, moreCategories } = found.value;
      return ok(Object.freeze({ scope: where.provenance, item: Object.freeze({ ...item, scope: where.provenance }), categories: Object.freeze(categories.map((c) => Object.freeze({ ...c, scope: where.provenance }))), ...(moreCategories === true ? { moreCategories: true as const } : {}) }));
    },

    async categories(userId: string, readable: readonly ResolvedScope[], input: PageInput | undefined): Promise<Result<MineCategoryPage, CaciError>> {
      const page = pageOf(input);
      if (!page.ok) return page;
      const fp = fingerprint(userId, 'categories', readable.map(keyOf));
      let at: Position = { i: 0, c: null };
      if (page.value.cursor !== null) {
        const decoded = decode(page.value.cursor, 'categories', fp, readable.length);
        if (decoded === undefined) return err(badCursor());
        at = decoded;
      }
      const items: MineCategory[] = [];
      let { i, c: inner } = at;
      let next: Position | undefined;
      while (i < readable.length && items.length < page.value.limit) {
        const r = readable[i] as ResolvedScope;
        const listed = await browser.categories(r.graphId, { limit: page.value.limit - items.length, ...(inner === null ? {} : { cursor: inner }) });
        if (!listed.ok) {
          if (r.scope.kind === 'circle' && isMissingGraph(listed.error)) {
            i++;
            inner = null;
            continue;
          }
          return listed;
        }
        for (const cat of listed.value.items) items.push(Object.freeze({ ...cat, scope: r.provenance }));
        if (listed.value.nextCursor !== null) {
          next = { i, c: listed.value.nextCursor };
          break;
        }
        i++;
        inner = null;
      }
      if (next === undefined && i < readable.length) next = { i, c: null };
      return ok(Object.freeze({ items: Object.freeze(items), nextCursor: next === undefined ? null : encode('categories', fp, next) }));
    },
  };
}
