import type { JsonValue } from '../graph_store/index.js';
import type { UserController } from '../users/index.js';
import { NO_BODY, unknownKey } from './common.js';
import { clearCookie } from './cookies.js';
import type { ApiResponse, Route, RouteContext } from './router.js';
import { errorResponse } from './routes.js';

export interface AgentTokenRoutesOptions {
  readonly controller: UserController;
  /** The session cookie's name. Default `caci_session`. */
  readonly cookieName?: string;
  readonly secureCookies?: boolean;
}

/**
 * Making, listing and ending the personal access tokens of R-022. These routes use the **session cookie** (never a token): a
 * person manages their agent's access from their own signed-in session. The one place a token appears in an answer is the reply
 * to making it, once; the list never holds it. They exist only when the operator has switched agent access on.
 */
export function createAgentTokenRoutes(options: AgentTokenRoutesOptions): readonly Route[] {
  const { controller } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;
  const asJson = (value: unknown): JsonValue => value as JsonValue;

  const signedIn =
    (allowedBody: readonly string[], run: (ctx: RouteContext, token: string, body: Readonly<Record<string, JsonValue>>) => Promise<ApiResponse>) =>
    async (ctx: RouteContext): Promise<ApiResponse> => {
      const token = ctx.cookies[cookieName];
      if (token === undefined) return errorResponse({ code: 'UNAUTHENTICATED', message: 'not signed in' });
      const body = ctx.body ?? NO_BODY;
      const badBody = unknownKey(body, allowedBody);
      if (badBody !== undefined) return errorResponse(badBody);
      const extra = Object.keys(ctx.query)[0];
      if (extra !== undefined) return errorResponse({ code: 'INVALID_INPUT', message: `${extra} is not accepted here`, field: extra });
      const response = await run(ctx, token, body);
      return response.status === 401 ? { ...response, cookies: [clearCookie(cookieName, { secure })] } : response;
    };

  return [
    {
      method: 'POST',
      path: '/api/me/agent-tokens',
      handler: signedIn(['name', 'scopes', 'checks', 'days'], async (_ctx, token, body) => {
        const made = await controller.createAgentToken(token, body);
        return made.ok ? { status: 201, body: { token: made.value.token, agentToken: asJson(made.value.agentToken) } } : errorResponse(made.error);
      }),
    },
    {
      method: 'GET',
      path: '/api/me/agent-tokens',
      handler: signedIn([], async (_ctx, token) => {
        const listed = await controller.listAgentTokens(token);
        return listed.ok ? { status: 200, body: asJson(listed.value) } : errorResponse(listed.error);
      }),
    },
    {
      method: 'DELETE',
      path: '/api/me/agent-tokens/:id',
      handler: signedIn([], async (ctx, token) => {
        const ended = await controller.revokeAgentToken(token, ctx.params.id);
        return ended.ok ? { status: 204 } : errorResponse(ended.error);
      }),
    },
  ];
}
