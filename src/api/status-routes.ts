import type { CaciController, CaciError } from '../caci/index.js';
import type { JsonValue } from '../graph_store/index.js';
import { NO_BODY, unknownKey } from './common.js';
import { respond } from './capture-routes.js';
import { clearCookie } from './cookies.js';
import type { Route } from './router.js';

export interface StatusRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the other routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;

/**
 * The status route of R-011: `POST /api/status` with `{ text, timeZone? }` and nothing else. It needs the session
 * cookie and cannot name a graph, a scope or a person: the controller reads what the signed-in person may read.
 * The answer is the status view (headline, points with their sources, counts) and never anything from the inside.
 * POST because each request costs a model call, so the cross-origin rules apply.
 */
export function createStatusRoutes(options: StatusRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;
  const fail = (error: CaciError, clear: boolean) => respond(error, clear ? [clearCookie(cookieName, { secure })] : undefined, 'status');

  return [
    {
      method: 'POST',
      path: '/api/status',
      handler: async (ctx) => {
        const token = ctx.cookies[cookieName];
        if (token === undefined) return fail({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } }, false);
        const bad = unknownKey(ctx.body ?? NO_BODY, ['text', 'timeZone']);
        if (bad !== undefined) return fail({ source: 'caci', error: { code: 'INVALID_INPUT', message: bad.message, ...(bad.field === undefined ? {} : { field: bad.field }) } }, false);
        const stray = Object.keys(ctx.query)[0];
        if (stray !== undefined) return fail({ source: 'caci', error: { code: 'INVALID_INPUT', message: `${stray} is not accepted here`, field: stray } }, false);
        const made = await caci.status(token, { text: ctx.body?.text, ...(ctx.body?.timeZone === undefined ? {} : { timeZone: ctx.body.timeZone }) });
        if (made.ok) return { status: 200, body: { status: asJson(made.value) } };
        return fail(made.error, made.error.source === 'caci' && made.error.error.code === 'UNAUTHENTICATED');
      },
    },
  ];
}
