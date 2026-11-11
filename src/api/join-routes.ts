import { asJson, circleRoute, ok, pageOf, type CircleRoutesOptions } from './circle-routes.js';
import type { Route } from './router.js';

/**
 * The join link routes of R-023, built on the circle routes' own helpers so they behave the same: the session cookie is the only
 * credential, one status table, unknown query parameters and body fields refused by name, a stranger gets the answer for a circle
 * that does not exist. **The token travels only in a request body** (never the path or the query: a `?token=` is refused by name),
 * and is in one response only: the one that makes the link. Every kind of link that does not work, for preview or join, is the
 * same 404; a client that misses too often is held back (the controller counts by the client key the server worked out).
 * These routes are served only when the operator switches join links on.
 */
export function createJoinRoutes(options: CircleRoutesOptions): readonly Route[] {
  const { circles } = options;
  const route = (rules: { body?: readonly string[]; query?: readonly string[] }, run: Parameters<typeof circleRoute>[2]) => circleRoute(options, rules, run);

  return [
    {
      method: 'POST',
      path: '/api/circles/:id/join-links',
      handler: route({}, async (ctx, token) => {
        const made = await circles.createJoinLink(token, ctx.params.id, ctx.body);
        return made.ok ? ok({ status: 201, body: asJson(made.value) }) : made;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/join-links',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await circles.listJoinLinks(token, ctx.params.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'DELETE',
      path: '/api/circles/:id/join-links/:linkId',
      handler: route({ body: [] }, async (ctx, token) => {
        const done = await circles.revokeJoinLink(token, ctx.params.id, ctx.params.linkId);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
    {
      method: 'POST',
      path: '/api/join/preview',
      handler: route({}, async (ctx, token) => {
        const seen = await circles.previewJoin(token, ctx.body, { clientKey: ctx.clientKey });
        return seen.ok ? ok({ status: 200, body: { preview: asJson(seen.value) } }) : seen;
      }),
    },
    {
      method: 'POST',
      path: '/api/join',
      handler: route({}, async (ctx, token) => {
        const joined = await circles.join(token, ctx.body, { clientKey: ctx.clientKey });
        return joined.ok ? ok({ status: 200, body: { result: asJson(joined.value) } }) : joined;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/join-requests',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await circles.joinRequests(token, ctx.params.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'POST',
      path: '/api/circles/:id/join-requests/:requestId/approve',
      handler: route({ body: [] }, async (ctx, token) => {
        const approved = await circles.approveJoin(token, ctx.params.id, ctx.params.requestId);
        return approved.ok ? ok({ status: 200, body: { member: asJson(approved.value) } }) : approved;
      }),
    },
    {
      method: 'POST',
      path: '/api/circles/:id/join-requests/:requestId/decline',
      handler: route({ body: [] }, async (ctx, token) => {
        const done = await circles.declineJoin(token, ctx.params.id, ctx.params.requestId);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/join-requests',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await circles.myJoinRequests(token, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
  ];
}
