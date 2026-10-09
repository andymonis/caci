import type { CaciController, CaciError } from '../caci/index.js';
import type { JsonValue, Result } from '../graph_store/index.js';
import { clearCookie } from './cookies.js';
import { NO_BODY, unknownKey } from './common.js';
import type { ApiResponse, Route, RouteContext } from './router.js';

export interface CaptureRoutesOptions {
  readonly caci: CaciController;
  /** The session cookie's name; the same one the account routes use. Default `caci_session`. */
  readonly cookieName?: string;
  /** Whether the cookie is `Secure` (needed to clear it with the same attributes). Default `false`. */
  readonly secureCookies?: boolean;
}

interface Mapped {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly retryAfterSeconds?: number;
}

const fixed = (status: number, code: string, message: string, extra: Pick<Mapped, 'field' | 'retryAfterSeconds'> = {}): Mapped => ({ status, code, message, ...extra });
const seconds = (ms: number | undefined): Pick<Mapped, 'retryAfterSeconds'> => (ms === undefined ? {} : { retryAfterSeconds: ms / 1000 });

/**
 * One place that decides what a failure looks like to the outside. Messages are **fixed per kind**, never the
 * text of a provider, a store or a path: a front end learns what happened and what it can do, and nothing
 * from the inside.
 */
export function mapCaciError(error: CaciError): Mapped {
  switch (error.source) {
    case 'caci': {
      const e = error.error;
      switch (e.code) {
        case 'UNAUTHENTICATED':
          return fixed(401, 'UNAUTHENTICATED', 'not signed in');
        case 'NOT_FOUND':
          return fixed(404, 'NOT_FOUND', e.message); // the controller's own fixed words: no such proposal, category or item
        case 'EXPIRED':
          return fixed(410, 'EXPIRED', 'that proposal has expired: make it again');
        case 'THROTTLED':
          return fixed(429, 'THROTTLED', 'you have made the most proposals allowed in an hour', seconds(e.retryAfterMs));
        case 'TOO_MANY_PENDING':
          return fixed(429, 'TOO_MANY_PENDING', 'you have too many proposals waiting: approve or reject one first', seconds(e.retryAfterMs));
        case 'INVALID_INPUT':
          return fixed(422, 'INVALID_INPUT', e.message, e.field === undefined ? {} : { field: e.field });
      }
      return fixed(500, 'INTERNAL_ERROR', 'internal error');
    }
    case 'app': {
      switch (error.error.code) {
        case 'INVALID_INPUT':
        case 'UNSUPPORTED_INPUT':
          return fixed(422, 'INVALID_INPUT', 'the note could not be used', { field: 'text' });
        case 'PROPOSAL_NOT_FOUND':
          return fixed(404, 'NOT_FOUND', 'no such proposal');
        case 'PROPOSAL_EXPIRED':
          return fixed(410, 'EXPIRED', 'that proposal has expired: make it again');
        case 'TOO_MANY_PENDING':
          return fixed(429, 'BUSY', 'the service is holding too many proposals: try again in a few minutes', { retryAfterSeconds: 60 });
        default:
          return fixed(500, 'INTERNAL_ERROR', 'internal error');
      }
    }
    case 'graph': {
      switch (error.error.code) {
        case 'NODE_NOT_FOUND':
        case 'CONFLICT':
          return fixed(409, 'WRITE_REFUSED', 'this proposal can no longer be applied: it would not fit your notes as they are now');
        case 'VALIDATION_ERROR':
          return fixed(409, 'WRITE_REFUSED', 'this proposal can no longer be applied');
        default:
          return fixed(500, 'STORAGE_ERROR', 'your notes could not be read or saved: try again');
      }
    }
    case 'llm': {
      switch (error.error.code) {
        case 'TIMEOUT':
          return fixed(502, 'MODEL_TIMEOUT', 'the model took too long: try again');
        case 'REFUSED':
          return fixed(502, 'MODEL_REFUSED', 'the model declined to file this note');
        case 'RATE_LIMITED':
          return fixed(503, 'MODEL_BUSY', 'the model is busy: try again shortly', seconds(error.error.retryAfterMs ?? 30_000));
        case 'CONFIG':
        case 'CANCELLED':
          return fixed(500, 'INTERNAL_ERROR', 'internal error');
        default:
          return fixed(502, 'MODEL_ERROR', 'the model could not file this note: try again');
      }
    }
  }
}

export function respond(error: CaciError, cookies?: readonly string[]): ApiResponse {
  const m = mapCaciError(error);
  return {
    status: m.status,
    body: { error: { code: m.code, message: m.message, ...(m.field === undefined ? {} : { field: m.field }) } },
    ...(m.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: m.retryAfterSeconds }),
    ...(cookies === undefined ? {} : { cookies }),
  };
}

/**
 * The capture routes of R-003: propose a filing for a note, look at it, approve it, reject it. Every
 * route needs the session cookie; nothing here chooses a graph or an owner, the controller does both from
 * the session. The routes only translate: statuses, the cookie, the JSON.
 */
export function createCaptureRoutes(options: CaptureRoutesOptions): readonly Route[] {
  const { caci } = options;
  const cookieName = options.cookieName ?? 'caci_session';
  const secure = options.secureCookies ?? false;

  /** A route that needs a session; a refused session also clears a stale cookie. */
  const signedIn =
    (allowed: readonly string[], run: (ctx: RouteContext, token: string) => Promise<Result<ApiResponse, CaciError>>) =>
    async (ctx: RouteContext): Promise<ApiResponse> => {
      const token = ctx.cookies[cookieName];
      const clear = [clearCookie(cookieName, { secure })];
      if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      const bad = unknownKey(ctx.body ?? NO_BODY, allowed);
      if (bad !== undefined) return respond({ source: 'caci', error: { code: 'INVALID_INPUT', message: bad.message, ...(bad.field === undefined ? {} : { field: bad.field }) } });
      const done = await run(ctx, token);
      if (done.ok) return done.value;
      return respond(done.error, done.error.source === 'caci' && done.error.error.code === 'UNAUTHENTICATED' ? clear : undefined);
    };

  const ok = (response: ApiResponse): Result<ApiResponse, CaciError> => ({ ok: true, value: response });
  const asJson = (value: unknown): JsonValue => value as JsonValue;

  return [
    {
      method: 'GET',
      path: '/api/capture/mode',
      handler: async (ctx) => {
        const token = ctx.cookies[cookieName];
        if (token === undefined) return respond({ source: 'caci', error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
        const stray = Object.keys(ctx.query)[0];
        if (stray !== undefined) return respond({ source: 'caci', error: { code: 'INVALID_INPUT', message: `${stray} is not accepted here`, field: stray } });
        const done = await caci.mode(token);
        if (done.ok) return { status: 200, body: { mode: done.value.mode } };
        return respond(done.error, done.error.source === 'caci' && done.error.error.code === 'UNAUTHENTICATED' ? [clearCookie(cookieName, { secure })] : undefined);
      },
    },
    {
      method: 'POST',
      path: '/api/capture/propose',
      handler: signedIn(['text'], async (ctx, token) => {
        const made = await caci.propose(token, { text: ctx.body?.text });
        return made.ok ? ok({ status: 201, body: { proposal: asJson(made.value) } }) : made;
      }),
    },
    {
      method: 'GET',
      path: '/api/capture/proposals/:id',
      handler: signedIn([], async (ctx, token) => {
        const got = await caci.get(token, ctx.params.id);
        return got.ok ? ok({ status: 200, body: { proposal: asJson(got.value) } }) : got;
      }),
    },
    {
      method: 'POST',
      path: '/api/capture/proposals/:id/approve',
      handler: signedIn([], async (ctx, token) => {
        const done = await caci.approve(token, ctx.params.id);
        return done.ok ? ok({ status: 200, body: { written: asJson(done.value) } }) : done;
      }),
    },
    {
      method: 'POST',
      path: '/api/capture/proposals/:id/reject',
      handler: signedIn([], async (ctx, token) => {
        const done = await caci.reject(token, ctx.params.id);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
  ];
}
