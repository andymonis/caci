import type { CaciController } from '../caci/index.js';
import type { JsonValue } from '../graph_store/index.js';
import { pageOf, scopeFrom } from './brain-routes.js';
import { respond } from './capture-routes.js';
import { clearCookie } from './cookies.js';
import type { ApiResponse, Route } from './router.js';

export interface LedgerRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the other routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

/**
 * The change log of a brain (R-014): `GET /api/ledger?scope=personal|circle:<id>&limit&cursor`, newest first. Read-only, session
 * cookie only, and it cannot name a graph: the scope is `personal` (the default) or a circle the caller may read. A stranger and a
 * made-up circle get the same 404. It is a review log, not a history.
 */
export function createLedgerRoutes(options: LedgerRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;
  const allowed = ['scope', 'limit', 'cursor'];
  return [
    {
      method: 'GET',
      path: '/api/ledger',
      handler: async (ctx): Promise<ApiResponse> => {
        const token = ctx.cookies[cookieName];
        if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
        const stray = Object.keys(ctx.query).find((key) => !allowed.includes(key));
        if (stray !== undefined) return respond({ source: 'caci', error: { code: 'INVALID_INPUT', message: `${stray} is not accepted here`, field: stray } });
        const scope = scopeFrom(ctx.query.scope, 'scope', false);
        if (!scope.ok) return respond(scope.error);
        const done = await caci.ledger(token, scope.value, pageOf(ctx.query));
        if (done.ok) return { status: 200, body: done.value as unknown as JsonValue };
        return respond(done.error, done.error.source === 'caci' && done.error.error.code === 'UNAUTHENTICATED' ? [clearCookie(cookieName, { secure })] : undefined);
      },
    },
  ];
}
