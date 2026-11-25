import type { CaciController, CaciError } from '../caci/index.js';
import type { JsonValue } from '../graph_store/index.js';
import { NO_BODY, unknownKey } from './common.js';
import { respond } from './capture-routes.js';
import { clearCookie } from './cookies.js';
import { scopeFrom } from './brain-routes.js';
import type { ApiResponse, Route } from './router.js';

export interface FactRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the other routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

const invalid = (message: string, field: string): CaciError => ({ source: 'caci', error: { code: 'INVALID_INPUT', message, field } });

/**
 * The verb routes of R-025: `POST /api/facts/resolve` with `{ scope?, id, verb }`, `POST /api/facts/unresolve` with `{ scope?, id }`
 * `GET /api/facts/resolutions?limit&after_scope&after_id` (the caller's own, paged) and `GET /api/facts/verbs` (the vocabulary a screen offers). Session cookie only; none of them can name a
 * person, a graph or anything but a fact reference, and the scope is `{ kind: 'personal' }` (the default) or `{ kind: 'circle', circleId }`.
 * A stranger, a non-member and a made-up circle get the same 404. A resolution is private: nothing here lists anyone else's.
 */
export function createFactRoutes(options: FactRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;
  const fail = (error: CaciError): ApiResponse => respond(error, error.source === 'caci' && error.error.code === 'UNAUTHENTICATED' ? [clearCookie(cookieName, { secure })] : undefined);

  const write =
    (keys: readonly string[], run: (token: string, body: Readonly<Record<string, JsonValue>>) => Promise<{ ok: true; value: unknown } | { ok: false; error: CaciError }>) =>
    async (ctx: Parameters<Route['handler']>[0]): Promise<ApiResponse> => {
      const token = ctx.cookies[cookieName];
      if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      const bad = unknownKey(ctx.body ?? NO_BODY, keys);
      if (bad !== undefined) return respond({ source: 'caci', error: { code: 'INVALID_INPUT', message: bad.message, ...(bad.field === undefined ? {} : { field: bad.field }) } });
      const stray = Object.keys(ctx.query)[0];
      if (stray !== undefined) return respond(invalid(`${stray} is not accepted here`, stray));
      const done = await run(token, ctx.body ?? NO_BODY);
      return done.ok ? { status: 200, body: done.value as JsonValue } : fail(done.error);
    };

  return [
    {
      method: 'POST',
      path: '/api/facts/resolve',
      handler: write(['scope', 'id', 'verb'], async (token, body) => {
        const done = await caci.resolveFact(token, { ...(body.scope === undefined ? {} : { scope: body.scope }), ...(body.id === undefined ? {} : { id: body.id }), ...(body.verb === undefined ? {} : { verb: body.verb }) });
        return done.ok ? { ok: true, value: { resolved: done.value } } : done;
      }),
    },
    {
      method: 'POST',
      path: '/api/facts/unresolve',
      handler: write(['scope', 'id'], async (token, body) => {
        const done = await caci.unresolveFact(token, { ...(body.scope === undefined ? {} : { scope: body.scope }), ...(body.id === undefined ? {} : { id: body.id }) });
        return done.ok ? { ok: true, value: { unresolved: done.value } } : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/facts/verbs',
      handler: async (ctx): Promise<ApiResponse> => {
        const token = ctx.cookies[cookieName];
        if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
        const stray = Object.keys(ctx.query)[0];
        if (stray !== undefined) return respond(invalid(`${stray} is not accepted here`, stray));
        const done = await caci.verbs(token);
        return done.ok ? { status: 200, body: done.value as unknown as JsonValue } : fail(done.error);
      },
    },
    {
      method: 'GET',
      path: '/api/facts/resolutions',
      handler: async (ctx): Promise<ApiResponse> => {
        const token = ctx.cookies[cookieName];
        if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
        const stray = Object.keys(ctx.query).find((key) => !['limit', 'after_scope', 'after_id'].includes(key));
        if (stray !== undefined) return respond(invalid(`${stray} is not accepted here`, stray));
        if ((ctx.query.after_scope === undefined) !== (ctx.query.after_id === undefined)) return respond(invalid('give after_scope and after_id together', ctx.query.after_scope === undefined ? 'after_scope' : 'after_id'));
        let after: { scope: unknown; id: string } | undefined;
        if (ctx.query.after_scope !== undefined) {
          const scope = scopeFrom(ctx.query.after_scope, 'after_scope', false);
          if (!scope.ok) return respond(scope.error);
          after = { scope: scope.value, id: ctx.query.after_id as string };
        }
        const limit = ctx.query.limit === undefined ? undefined : ctx.query.limit.trim() === '' ? Number.NaN : Number(ctx.query.limit);
        const done = await caci.resolutions(token, { ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) });
        return done.ok ? { status: 200, body: done.value as unknown as JsonValue } : fail(done.error);
      },
    },
  ];
}
