import type { Page, Paged } from './adapter.js';

/** Rows asked of the adapter at a time. */
export const READ_PAGE = 1000;

/**
 * Walks any paged listing from the adapter, page by page, however many pages there are.
 *
 * The core trusts an adapter to hand back a cursor that moves on. An adapter that does not, one
 * that gives the same cursor twice running or comes back to a cursor it already gave, would make
 * the walk run for ever. So this throws instead, naming what was being listed. Callers sit inside
 * code that turns a throw into `STORAGE_ERROR` (and inside a transaction, so a write is rolled back).
 *
 * A page is handed to the caller before its cursor is checked, so the caller may act on it (for
 * example delete its rows) first.
 */
export async function* walkPages<T>(fetch: (page: Page) => Promise<Paged<T>>, what: string, limit: number = READ_PAGE): AsyncGenerator<readonly T[]> {
  const given = new Set<unknown>();
  let cursor: string | null = null;
  do {
    const page: Paged<T> = await fetch({ limit, cursor });
    yield page.items;
    const next: string | null = page.nextCursor;
    if (next !== null) {
      if (next === cursor) throw new Error(`the adapter's paging cursor did not advance while listing ${what}`);
      if (given.has(next)) throw new Error(`the adapter's paging cursor went back to an earlier page while listing ${what}`);
      given.add(next);
    }
    cursor = next;
  } while (cursor !== null);
}
