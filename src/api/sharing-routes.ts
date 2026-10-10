import type { Sharing } from '../sharing/index.js';
import { asJson, circleRoute, ok, pageOf, type CircleRoutesOptions } from './circle-routes.js';
import type { Route } from './router.js';

export interface SharingRoutesOptions extends Pick<CircleRoutesOptions, 'cookieName' | 'secureCookies'> {
  readonly sharing: Sharing;
}

/**
 * The sharing routes of R-008: three for what I share and four for reading what others share with me (ids of
 * categories and items travel in the query string, never in the path). They use the circle routes' session handling, strictness and status table, so
 * a stranger to a circle gets its "no such circle" and nobody can name whose categories are shared: the
 * owner is always the session.
 */
export function createSharingRoutes(options: SharingRoutesOptions): readonly Route[] {
  const { sharing } = options;
  const route = circleRoute.bind(undefined, options);

  return [
    {
      method: 'GET',
      path: '/api/circles/:id/grants',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await sharing.grants(token, ctx.params.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'PUT',
      path: '/api/circles/:id/grants/:userId',
      handler: route({}, async (ctx, token) => {
        const set = await sharing.setGrant(token, ctx.params.id, ctx.params.userId, ctx.body);
        if (!set.ok) return set;
        return ok(set.value === undefined ? { status: 204 } : { status: 200, body: { grant: asJson(set.value) } });
      }),
    },
    {
      method: 'DELETE',
      path: '/api/circles/:id/grants/:userId',
      handler: route({ body: [] }, async (ctx, token) => {
        const done = await sharing.withdraw(token, ctx.params.id, ctx.params.userId);
        return done.ok ? ok({ status: 204 }) : done;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/shared',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await sharing.sharedWithMe(token, ctx.params.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/shared/:userId/categories',
      handler: route({ body: [], query: ['limit', 'cursor'] }, async (ctx, token) => {
        const listed = await sharing.sharedCategories(token, ctx.params.id, ctx.params.userId, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/shared/:userId/category',
      handler: route({ body: [], query: ['id', 'limit', 'cursor'] }, async (ctx, token) => {
        const listed = await sharing.sharedCategoryItems(token, ctx.params.id, ctx.params.userId, ctx.query.id, pageOf(ctx.query));
        return listed.ok ? ok({ status: 200, body: asJson(listed.value) }) : listed;
      }),
    },
    {
      method: 'GET',
      path: '/api/circles/:id/shared/:userId/item',
      handler: route({ body: [], query: ['id'] }, async (ctx, token) => {
        const got = await sharing.sharedItem(token, ctx.params.id, ctx.params.userId, ctx.query.id);
        return got.ok ? ok({ status: 200, body: asJson(got.value) }) : got;
      }),
    },
  ];
}
