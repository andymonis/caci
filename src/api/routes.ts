import type { JsonValue, Result } from '../graph_store/index.js';
import type { UserController, UsersError } from '../users/index.js';
import { clearCookie, serialiseCookie } from './cookies.js';
import type { ApiResponse, Route, RouteContext } from './router.js';

export interface AccountRoutesOptions {
  readonly controller: UserController;
  /** The session cookie's name. Default `caci_session`. */
  readonly cookieName?: string;
  /** Add `Secure` to the cookie (the browser then sends it only over HTTPS). Default `false`. */
  readonly secureCookies?: boolean;
  /** How long the browser keeps the cookie. Default 7 days, the same as a session's absolute lifetime. */
  readonly cookieMaxAgeSeconds?: number;
}

/** HTTP status for each `UsersError` code. */
export const STATUS_OF: Readonly<Record<UsersError['code'], number>> = Object.freeze({
  INVALID_INPUT: 422,
  CONFLICT: 409,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  THROTTLED: 429,
  LAST_ADMIN: 409,
  STORAGE_ERROR: 500,
});

/** Same shape as every other failure the server sends. `field` appears only for input problems. */
export function errorResponse(error: UsersError, extra: Pick<ApiResponse, 'cookies'> = {}): ApiResponse {
  return {
    status: STATUS_OF[error.code] ?? 500,
    body: { error: { code: error.code, message: error.message, ...(error.field === undefined ? {} : { field: error.field }) } },
    ...(error.retryAfterMs === undefined ? {} : { retryAfterSeconds: error.retryAfterMs / 1000 }),
    ...extra,
  };
}

const NO_BODY = Object.freeze({});

/** A body with a key we do not know is refused by name, so a typo (or an attempt to send `role` to register) is never silently ignored. */
function unknownKey(body: Readonly<Record<string, JsonValue>>, allowed: readonly string[]): UsersError | undefined {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return { code: 'INVALID_INPUT', message: `${key} is not accepted here`, field: key };
  }
  return undefined;
}

/**
 * The account and admin routes of R-002. The session cookie is the only credential: the token never
 * appears in a body, and an `Authorization` header is not even looked at. Every route hands the
 * work to the user controller and only translates: status codes, the cookie, the JSON.
 */
export function createAccountRoutes(options: AccountRoutesOptions): readonly Route[] {
  const { controller } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;
  const maxAge = options.cookieMaxAgeSeconds ?? 7 * 24 * 60 * 60;

  const clearing = (): readonly string[] => [clearCookie(cookieName, { secure })];
  const bodyOf = (ctx: RouteContext): Readonly<Record<string, JsonValue>> => ctx.body ?? NO_BODY;

  /** A route that needs a session. A failed sign-in also clears a stale cookie, so the browser stops sending it. */
  const signedIn =
    (allowed: readonly string[] | undefined, run: (ctx: RouteContext, token: string, body: Readonly<Record<string, JsonValue>>) => Promise<ApiResponse>) =>
    async (ctx: RouteContext): Promise<ApiResponse> => {
      const token = ctx.cookies[cookieName];
      const body = bodyOf(ctx);
      if (token === undefined) return errorResponse({ code: 'UNAUTHENTICATED', message: 'not signed in' });
      if (allowed !== undefined) {
        const bad = unknownKey(body, allowed);
        if (bad !== undefined) return errorResponse(bad);
      }
      const response = await run(ctx, token, body);
      return response.status === 401 ? { ...response, cookies: clearing() } : response;
    };

  const ok = <T>(result: Result<T, UsersError>, make: (value: T) => ApiResponse): ApiResponse => (result.ok ? make(result.value) : errorResponse(result.error));
  const json = (status: number, body: JsonValue): ApiResponse => ({ status, body });
  const asJson = (value: unknown): JsonValue => value as JsonValue; // users and lists are plain data

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/api/register',
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        const bad = unknownKey(body, ['username', 'displayName', 'password', 'email']);
        if (bad !== undefined) return errorResponse(bad);
        return ok(await controller.register({ username: body.username, displayName: body.displayName, password: body.password, email: body.email }, { clientKey: ctx.clientKey }), (user) => json(201, { user: asJson(user) }));
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        const bad = unknownKey(body, ['username', 'password']);
        if (bad !== undefined) return errorResponse(bad);
        return ok(await controller.login({ username: body.username, password: body.password }, { clientKey: ctx.clientKey }), ({ token, ...me }) => ({
          status: 200,
          body: asJson(me), // the user and their graph: never the token
          cookies: [serialiseCookie(cookieName, token, { secure, maxAgeSeconds: maxAge })],
        }));
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      handler: async (ctx) => {
        await controller.logout(ctx.cookies[cookieName]);
        return { status: 204, cookies: clearing() };
      },
    },
    { method: 'GET', path: '/api/me', handler: signedIn(undefined, async (_ctx, token) => ok(await controller.getMe(token), (me) => json(200, asJson(me)))) },
    {
      method: 'PATCH',
      path: '/api/me',
      handler: signedIn(['displayName', 'email'], async (_ctx, token, body) => ok(await controller.updateMe(token, body), (user) => json(200, { user: asJson(user) }))),
    },
    {
      method: 'POST',
      path: '/api/me/password',
      handler: signedIn(['currentPassword', 'newPassword'], async (ctx, token, body) =>
        ok(await controller.changePassword(token, { currentPassword: body.currentPassword, newPassword: body.newPassword }, { clientKey: ctx.clientKey }), (user) => json(200, { user: asJson(user) })),
      ),
    },
    {
      method: 'DELETE',
      path: '/api/me',
      handler: signedIn(['password'], async (ctx, token, body) =>
        ok(await controller.deleteMe(token, { password: body.password }, { clientKey: ctx.clientKey }), () => ({ status: 204, cookies: clearing() })),
      ),
    },
    {
      method: 'GET',
      path: '/api/users',
      handler: signedIn(undefined, async (ctx, token) => {
        // the query string is all text: a limit that is not a number is passed on as NaN and refused by name
        const input = { ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit.trim() === '' ? Number.NaN : Number(ctx.query.limit) }), ...(ctx.query.cursor === undefined ? {} : { cursor: ctx.query.cursor }) };
        return ok(await controller.listUsers(token, input), (page) => json(200, asJson(page)));
      }),
    },
    {
      method: 'GET',
      path: '/api/users/:id',
      handler: signedIn(undefined, async (ctx, token) => ok(await controller.getUser(token, ctx.params.id), (user) => json(200, { user: asJson(user) }))),
    },
    {
      method: 'PATCH',
      path: '/api/users/:id',
      handler: signedIn(['displayName', 'email', 'role'], async (ctx, token, body) => ok(await controller.updateUser(token, ctx.params.id, body), (user) => json(200, { user: asJson(user) }))),
    },
    {
      method: 'DELETE',
      path: '/api/users/:id',
      handler: signedIn(undefined, async (ctx, token) => ok(await controller.deleteUser(token, ctx.params.id), () => ({ status: 204 }))),
    },
    {
      method: 'POST',
      path: '/api/users/:id/password',
      handler: signedIn(['newPassword'], async (ctx, token, body) => ok(await controller.resetPassword(token, ctx.params.id, { newPassword: body.newPassword }), (user) => json(200, { user: asJson(user) }))),
    },
  ];
  return routes;
}
