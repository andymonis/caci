import type { CaciController, CaciError } from '../caci/index.js';
import type { JsonValue, Result } from '../graph_store/index.js';
import { respond } from './capture-routes.js';
import { clearCookie } from './cookies.js';
import type { ApiResponse, Route, RouteContext } from './router.js';

export interface BrainRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the other routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;
const ok = (response: ApiResponse): Result<ApiResponse, CaciError> => ({ ok: true, value: response });
const invalid = (message: string, field: string): Result<never, CaciError> => ({ ok: false, error: { source: 'caci', error: { code: 'INVALID_INPUT', message, field } } });

function pageOf(query: Readonly<Record<string, string>>): { limit?: number; cursor?: string } {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit.trim() === '' ? Number.NaN : Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/** `personal`, `circle:<id>` or (where allowed) `mine`, as the controller wants it. Anything else is refused naming the parameter. */
function scopeFrom(text: string | undefined, field: string, allowMine: boolean): Result<{ kind: 'personal' } | { kind: 'circle'; circleId: string } | 'mine', CaciError> {
  if (text === undefined || text === 'personal') return { ok: true, value: { kind: 'personal' } };
  if (text === 'mine') return allowMine ? { ok: true, value: 'mine' } : invalid(`${field} must be personal or circle:<id>`, field);
  if (text.startsWith('circle:')) return { ok: true, value: { kind: 'circle', circleId: text.slice('circle:'.length) } };
  return invalid(`${field} must be personal, circle:<id>${allowMine ? ' or mine' : ''}`, field);
}

/**
 * The brain routes of R-009: browse your own brain, one circle's brain, or **My Brain** (your own and every
 * circle you may read, each result saying where it came from). All GET, all need the session cookie, and none
 * can name a graph: the scope is `personal`, `circle:<id>` or `mine`, and the controller decides what it may read.
 * Ids of categories and items travel in the query string. In My Brain a category or an item is named by where
 * it is as well as its id (`source`). The older `/api/graph/*` routes are unchanged.
 */
export function createBrainRoutes(options: BrainRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;

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

  /** The source of a category or item in My Brain: required there, and refused anywhere else. */
  const sourceFor = (ctx: RouteContext, mine: boolean) => {
    if (!mine) return ctx.query.source === undefined ? undefined : invalid('source is only used with scope=mine', 'source');
    if (ctx.query.source === undefined) return invalid('say where it is: source=personal or source=circle:<id>', 'source');
    return scopeFrom(ctx.query.source, 'source', false);
  };

  return [
    {
      method: 'GET',
      path: '/api/brain/scopes',
      handler: read([], async (_ctx, token) => {
        const done = await caci.brainScopes(token);
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/brain',
      handler: read(['scope'], async (ctx, token) => {
        const scope = scopeFrom(ctx.query.scope, 'scope', true);
        if (!scope.ok) return scope;
        const done = scope.value === 'mine' ? await caci.mineSummary(token) : await caci.summary(token, scope.value);
        return done.ok ? ok({ status: 200, body: { summary: asJson(done.value) } }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/brain/categories',
      handler: read(['scope', 'limit', 'cursor'], async (ctx, token) => {
        const scope = scopeFrom(ctx.query.scope, 'scope', true);
        if (!scope.ok) return scope;
        const done = scope.value === 'mine' ? await caci.mineCategories(token, pageOf(ctx.query)) : await caci.categories(token, pageOf(ctx.query), scope.value);
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/brain/category',
      handler: read(['scope', 'source', 'id', 'limit', 'cursor'], async (ctx, token) => {
        const scope = scopeFrom(ctx.query.scope, 'scope', true);
        if (!scope.ok) return scope;
        const source = sourceFor(ctx, scope.value === 'mine');
        if (source !== undefined && !source.ok) return source;
        const done = scope.value === 'mine' ? await caci.mineCategoryItems(token, { scope: (source as { value: unknown }).value, id: ctx.query.id }, pageOf(ctx.query)) : await caci.categoryItems(token, ctx.query.id, pageOf(ctx.query), scope.value);
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/brain/item',
      handler: read(['scope', 'source', 'id'], async (ctx, token) => {
        const scope = scopeFrom(ctx.query.scope, 'scope', true);
        if (!scope.ok) return scope;
        const source = sourceFor(ctx, scope.value === 'mine');
        if (source !== undefined && !source.ok) return source;
        const done = scope.value === 'mine' ? await caci.mineItem(token, { scope: (source as { value: unknown }).value, id: ctx.query.id }) : await caci.item(token, ctx.query.id, scope.value);
        return done.ok ? ok({ status: 200, body: asJson(done.value) }) : done;
      }),
    },
  ];
}
