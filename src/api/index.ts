// The HTTP layer of the user API (R-002): a small server on `node:http` with the safety checks every
// route needs, once. It is the only place in the library that imports a network module.

export { clearCookie, parseCookies, serialiseCookie } from './cookies.js';
export type { CookieOptions } from './cookies.js';
export { isJsonContentType, parseBody } from './body.js';
export { matchRoute } from './router.js';
export type { ApiResponse, Match, Method, Route, RouteContext } from './router.js';
export { createApiServer } from './server.js';
export type { ApiServer, ApiServerOptions } from './server.js';
export { createAccountRoutes, errorResponse, STATUS_OF } from './routes.js';
export type { AccountRoutesOptions } from './routes.js';
