import type { JsonValue } from '../graph_store/index.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** What a handler is given. Everything in it came from the request and has been checked or is a plain string. */
export interface RouteContext {
  readonly method: Method;
  /** The path as matched, for example `/api/users/u123`. */
  readonly path: string;
  /** The `:name` parts of the route's path. */
  readonly params: Readonly<Record<string, string>>;
  /** The query string as a prototype-free map; the first of a repeated name wins. */
  readonly query: Readonly<Record<string, string>>;
  /** The parsed JSON body (always an object), or `undefined` when the request had none. */
  readonly body: Readonly<Record<string, JsonValue>> | undefined;
  readonly cookies: Readonly<Record<string, string>>;
  /** Who is asking, as far as throttling is concerned: the socket address, or the address a trusted proxy reported. */
  readonly clientKey: string;
}

/** What a handler returns. The kit turns it into the reply and adds the security headers. */
export interface ApiResponse {
  readonly status: number;
  /** Sent as JSON. Leave out for no body. */
  readonly body?: JsonValue;
  /** Complete `Set-Cookie` values (see `serialiseCookie`). */
  readonly cookies?: readonly string[];
  /** For `429`: seconds to wait. */
  readonly retryAfterSeconds?: number;
}

export interface Route {
  readonly method: Method;
  /** A path like `/api/users/:id`: literal segments, and `:name` for one segment of letters, digits, `_`, `-` and `.`. */
  readonly path: string;
  readonly handler: (context: RouteContext) => Promise<ApiResponse> | ApiResponse;
}

export type Match =
  | { readonly kind: 'match'; readonly route: Route; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: 'method'; readonly allow: readonly Method[] }
  | { readonly kind: 'none' };

const MAX_SEGMENTS = 8;
const MAX_SEGMENT = 128;
/** The only characters a path may hold: nothing that needs decoding, so nothing can hide a `..` or a `/`. */
const PATH = /^\/[A-Za-z0-9._~/-]*$/;
const PARAM = /^[A-Za-z0-9_.-]{1,128}$/;

/** The segments of a request path, or `undefined` if the path is not one we would ever serve (so it is a 404, never matched loosely). */
export function segmentsOf(path: string): string[] | undefined {
  if (typeof path !== 'string' || path.length > 1024 || !PATH.test(path)) return undefined;
  const segments = path.slice(1).split('/');
  if (segments.length > MAX_SEGMENTS) return undefined;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.length > MAX_SEGMENT) return undefined; // also refuses `//` and a trailing `/`
  }
  return segments;
}

/** Checks the routes once, when the server is made: a mistake here is a coding mistake. */
export function checkRoutes(routes: readonly Route[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (!/^\/[A-Za-z0-9_/:-]*$/.test(route.path) || route.path.includes('//')) throw new TypeError(`bad route path: ${route.path}`);
    const names = route.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
    if (names.some((n) => !/^[A-Za-z][A-Za-z0-9]*$/.test(n)) || new Set(names).size !== names.length) throw new TypeError(`bad route parameter in ${route.path}`);
    const shape = `${route.method} ${route.path.replace(/:[A-Za-z0-9]+/g, ':')}`;
    if (seen.has(shape)) throw new TypeError(`two routes for ${shape}`);
    seen.add(shape);
  }
}

/** Finds the route for a method and path: a match, or the methods that would have matched (405), or nothing (404). */
export function matchRoute(routes: readonly Route[], method: string, path: string): Match {
  const segments = segmentsOf(path);
  if (segments === undefined) return { kind: 'none' };
  const allow: Method[] = [];
  for (const route of routes) {
    const pattern = route.path.slice(1).split('/');
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = Object.create(null) as Record<string, string>;
    let fits = true;
    for (const [i, part] of pattern.entries()) {
      const actual = segments[i] as string;
      if (part.startsWith(':')) {
        if (!PARAM.test(actual)) fits = false;
        else params[part.slice(1)] = actual;
      } else if (part !== actual) fits = false;
      if (!fits) break;
    }
    if (!fits) continue;
    if (route.method === method) return { kind: 'match', route, params: Object.freeze(params) };
    if (!allow.includes(route.method)) allow.push(route.method);
  }
  return allow.length > 0 ? { kind: 'method', allow } : { kind: 'none' };
}
