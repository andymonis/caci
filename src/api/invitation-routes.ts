import { asJson, circleRoute, ok, pageOf, type CircleRoutesOptions } from './circle-routes.js';
import type { Route } from './router.js';

/**
 * The invitation routes of R-004. Same rules as the circle routes: the session cookie is the only
 * credential, one status table, unknown query parameters and body fields refused by name, and a
 * stranger gets the answer for a circle that does not exist. Inviting answers `202 { invited: true }`
 * for every target, whether or not the account exists, so the response cannot be used to find out who
 * has an account. Accepting or declining anything but your own open invitation is `404 no such
 * invitation`, whatever the reason.
 */
export function createInvitationRoutes(options: CircleRoutesOptions): readonly Route[] {
  const { circles } = options;
  const route = (rules: { body?: readonly string[]; query?: readonly string[] }, run: Parameters<typeof circleRoute>[2]) => circleRoute(options, rules, run);

  return [
    {
      method: 'POST',
      path: '/api/circles/:id/invitations',
      handler: route({}, async (ctx, token) => {
        const done = await circles.invite(token, ctx.params.id, ctx.body);
        return done.ok ? ok({ status: 202, body: asJson(done.value) }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/invitations',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await circles.invitations(token, ctx.params.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'DELETE',
      path: '/api/circles/:id/invitations/:invitationId',
      handler: route({ body: [] }, async (ctx, token) => {
        const done = await circles.revokeInvitation(token, ctx.params.id, ctx.params.invitationId);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/invitations',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await circles.myInvitations(token, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'POST',
      path: '/api/invitations/:id/accept',
      handler: route({ body: [] }, async (ctx, token) => {
        const joined = await circles.accept(token, ctx.params.id);
        return joined.ok ? ok({ status: 200, body: { circle: asJson(joined.value) } }) : joined;
      }),
    },
    {
      method: 'POST',
      path: '/api/invitations/:id/decline',
      handler: route({ body: [] }, async (ctx, token) => {
        const done = await circles.decline(token, ctx.params.id);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
  ];
}
