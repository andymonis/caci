import type { CaciController, CaciError } from '../caci/index.js';
import type { JsonValue, Result } from '../graph_store/index.js';
import { respond } from './capture-routes.js';
import { clearCookie } from './cookies.js';
import type { ApiResponse, Route, RouteContext } from './router.js';

export interface ReadRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the other routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;
const ok = (response: ApiResponse): Result<ApiResponse, CaciError> => ({ ok: true, value: response });

/** The page controls of a query string: a `limit` that is not a number is passed on as NaN, so the controller refuses it by name. */
function pageOf(query: Readonly<Record<string, string>>): { limit?: number; cursor?: string } {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit.trim() === '' ? Number.NaN : Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/**
 * The read routes of R-003: browse your own graph. All GET, all need the session cookie, and none
 * can name a graph: the controller reads the one that belongs to the session. Ids travel in the query
 * string (they are opaque text: spaces, capitals, any script), never in the path.
 */
export function createReadRoutes(options: ReadRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;

  /** A read that needs a session and only the query parameters it knows (a typo is refused by name, not ignored). */
  const read =
    (allowed: readonly string[], run: (ctx: RouteContext, token: string) => Promise<Result<ApiResponse, CaciError>>) =>
    async (ctx: RouteContext): Promise<ApiResponse> => {
      const token = ctx.cookies[cookieName];
      if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      const stray = Object.keys(ctx.query).find((key) => !allowed.includes(key));
      if (stray !== undefined) return respond({ source: 'caci', error: { code: 'INVALID_INPUT', message: `${stray} is not accepted here`, field: stray } });
      const done = await run(ctx, token);
      if (done.ok) return done.value;
      return respond(done.error, done.error.source === 'caci' && done.error.error.code === 'UNAUTHENTICATED' ? [clearCookie(cookieName, { secure })] : undefined);
    };

  return [
    {
      method: 'GET',
      path: '/api/graph',
      handler: read([], async (_ctx, token) => {
        const done = await caci.summary(token);
        return done.ok ? ok({ status: 200, body: { summary: asJson(done.value) } }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/graph/categories',
      handler: read(['limit', 'cursor'], async (ctx, token) => {
        const done = await caci.categories(token, pageOf(ctx.query));
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/graph/category',
      handler: read(['id', 'limit', 'cursor'], async (ctx, token) => {
        const done = await caci.categoryItems(token, ctx.query.id, pageOf(ctx.query));
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/graph/item',
      handler: read(['id'], async (ctx, token) => {
        const done = await caci.item(token, ctx.query.id);
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
  ];
}
