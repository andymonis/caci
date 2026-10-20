import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController } from '../caci/index.js';
import { createGraph, err } from '../graph_store/index.js';
import { createDemoModelClient, createLlm, llmError, type LlmErrorCode, type ModelClient } from '../llm/index.js';
import { createScopeResolver } from '../scopes/index.js';
import { addMember, call, secrets, signIn, startCircleApp, type CircleApp } from './circle-routes.test-util.js';
import { createCaptureRoutes } from './capture-routes.js';
import { createStatusRoutes } from './status-routes.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

let app: CircleApp | undefined;
const all: string[] = [];
let statusFailure: { code: LlmErrorCode; retryAfterMs?: number } | undefined;
let statusCalls = 0;
afterEach(async () => {
  await app?.api.close();
  app = undefined;
  statusFailure = undefined;
  statusCalls = 0;
});
afterAll(() => {
  const text = all.join('\n');
  expect(all.length).toBeGreaterThan(20);
  for (const secret of secrets) expect(text.includes(secret), 'a password or session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'user-u', 'circle-c', 'sk-ant', 'inputTokens', 'outputTokens', '<entries>', 'PROVIDER-SECRET']) expect(text, leak).not.toContain(leak);
});

const post = async (a: CircleApp, body: unknown, token?: string, path = '/api/status') => {
  const r = await call(a.port, 'POST', path, { token, body });
  all.push(r.text);
  return r;
};

async function started(limits: { statusPerHour?: number } = {}) {
  const demo = createDemoModelClient();
  const client: ModelClient = {
    complete: async (request) => {
      if (!(request.system ?? '').startsWith('You are the status assistant')) return demo.complete(request);
      statusCalls++;
      if (statusFailure !== undefined) return err(llmError(statusFailure.code, 'PROVIDER-SECRET sk-ant-xxxx at /var/log', statusFailure.retryAfterMs === undefined ? {} : { retryAfterMs: statusFailure.retryAfterMs }));
      return demo.complete(request);
    },
  };
  app = await startCircleApp({
    more: ({ users, store, graphs, now }) => {
      const llm = createLlm({ controls: SHIPPED_CONTROLS, client });
      const capture = createController({ adapter: graphs, llm, now: () => now.value });
      const scopes = createScopeResolver({ users, store });
      const caci = createCaciController({ users, capture, graphAdapter: graphs, scopes, clock: () => now.value, llm, limits });
      return [...createCaptureRoutes({ caci }), ...createStatusRoutes({ caci })];
    },
  });
  const a = app;
  const t = { root: await signIn(a, 'root'), ann: await signIn(a, 'ann'), bob: await signIn(a, 'bob'), cat: await signIn(a, 'cat') };
  const circle = (await call(a.port, 'POST', '/api/circles', { token: t.bob, body: { name: 'Parent care' } })).json.circle.id as string;
  await addMember(a, circle, 'ann', 'observer');
  for (const g of [`circle-${circle}`, `user-${a.ids.ann}`, `user-${a.ids.bob}`, `user-${a.ids.cat}`]) await createGraph(a.graphs, g);
  const file = async (token: string, text: string, scope?: unknown) => {
    const made = await post(a, { text, ...(scope === undefined ? {} : { scope }) }, token, '/api/capture/propose');
    expect(made.status).toBe(201);
    expect((await call(a.port, 'POST', `/api/capture/proposals/${made.json.proposal.id}/approve`, { token })).status).toBe(200);
  };
  return { a, t, circle, file };
}

describe('POST /api/status', () => {
  it('a circle scope narrows the answer to that circle; a stranger gets the made-up-circle 404 and a stray key is refused by name', async () => {
    const { a, t, circle, file } = await started();
    await file(t.bob, 'Mum new tablets one a day with food', { kind: 'circle', circleId: circle });
    await file(t.ann, 'Dentist appointment on Friday morning');
    const scoped = await post(a, { text: 'status', scope: { kind: 'circle', circleId: circle } }, t.ann);
    expect(scoped.status).toBe(200);
    expect(scoped.json.status.entriesUsed).toBe(1);
    const stray = await post(a, { text: 'status', scope: { kind: 'circle', circleId: circle, graphId: 'x' } }, t.ann);
    expect(stray.status).toBe(422);
    expect(stray.json.error.field).toBe('scope.graphId');
    const made = await post(a, { text: 'status', scope: { kind: 'circle', circleId: 'c0000000000000999' } }, t.ann);
    expect(made.status).toBe(404);
    expect(made.json.error.message).toBe('no such circle');
  });

  it('answers 200 with the status view, names the circle a point came from, and nothing from the inside', async () => {
    const { a, t, circle, file } = await started();
    await file(t.bob, 'Mum new tablets one a day with food', { kind: 'circle', circleId: circle });
    await file(t.ann, 'Dentist appointment on Friday morning');
    const r = await post(a, { text: 'How is Mum with her tablets?', timeZone: 'Europe/London' }, t.ann);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['status']);
    expect(Object.keys(r.json.status).sort()).toEqual(['entriesLeftOut', 'entriesUsed', 'generatedAt', 'headline', 'mode', 'nothing', 'points']);
    expect(r.json.status.mode).toBe('demo');
    expect(r.json.status.entriesUsed).toBe(2);
    expect(r.json.status.points[0].text).toContain('Mum new tablets');
    expect(r.json.status.points[0].sources).toEqual([{ kind: 'circle', circleId: circle, circleName: 'Parent care' }]);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('an observer can ask, and a person with no notes gets nothing:true', async () => {
    const { a, t, circle, file } = await started();
    await file(t.bob, 'Mum new tablets one a day with food', { kind: 'circle', circleId: circle });
    expect((await post(a, { text: 'status' }, t.ann)).json.status.entriesUsed).toBe(1);
    const none = await post(a, { text: 'status' }, t.cat);
    expect(none.status).toBe(200);
    expect(none.json.status.nothing).toBe(true);
  });

  it('needs the session cookie: no cookie is a 401 that sets nothing, a stale one is cleared, Authorization and a body token are ignored', async () => {
    const { a, t } = await started();
    const none = await post(a, { text: 'x' });
    expect(none.status).toBe(401);
    expect(none.cookie).toBeUndefined();
    const stale = await post(a, { text: 'x' }, 'x'.repeat(43));
    expect(stale.status).toBe(401);
    expect(stale.cookie).toContain('Max-Age=0');
    const header = await call(a.port, 'POST', '/api/status', { body: { text: 'x' }, headers: { authorization: `Bearer ${t.ann}` } });
    all.push(header.text);
    expect(header.status).toBe(401);
    expect((await post(a, { text: 'x', token: t.ann })).status).toBe(401);
  });

  it('refuses unknown body fields and query parameters by name, and bad text and time zones with their field', async () => {
    const { a, t } = await started();
    for (const key of ['graphId', 'scope', 'userId', 'entries']) {
      const r = await post(a, { text: 'x', [key]: 'u' }, t.ann);
      expect(r.status, key).toBe(422);
      expect(r.json.error.field).toBe(key);
    }
    const q = await call(a.port, 'POST', '/api/status?scope=mine', { token: t.ann, body: { text: 'x' } });
    all.push(q.text);
    expect(q.status).toBe(422);
    expect(q.json.error.field).toBe('scope');
    for (const [body, field] of [[{}, 'text'], [{ text: '' }, 'text'], [{ text: '   ' }, 'text'], [{ text: 5 }, 'text'], [{ text: 'x'.repeat(501) }, 'text'], [{ text: 'x', timeZone: 'Mars/Base' }, 'timeZone'], [{ text: 'x', timeZone: 5 }, 'timeZone']] as const) {
      const r = await post(a, body, t.ann);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error.field).toBe(field);
    }
    expect(statusCalls).toBe(0);
  });

  it('other methods are 405 with Allow: POST, a form post is 415, a cross-origin post is 403, and none asks the model', async () => {
    const { a, t } = await started();
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect((await call(a.port, method, '/api/status', { token: t.ann })).headers.allow, method).toBe('POST');
    expect((await call(a.port, 'POST', '/api/status', { token: t.ann, body: 'text=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await call(a.port, 'POST', '/api/status', { token: t.ann, body: { text: 'x' }, headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect(statusCalls).toBe(0);
  });

  it('the hourly limit is a 429 with Retry-After in the controller\'s words, and refused asks do not reach the model', async () => {
    const { a, t } = await started({ statusPerHour: 2 });
    expect((await post(a, { text: 'one' }, t.ann)).status).toBe(200);
    expect((await post(a, { text: 'two' }, t.ann)).status).toBe(200);
    const third = await post(a, { text: 'three' }, t.ann);
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('THROTTLED');
    expect(third.json.error.message).toContain('2');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(statusCalls).toBe(2);
    expect((await post(a, { text: 'other' }, t.bob)).status).toBe(200);
  });

  it.each([
    ['TIMEOUT', 502, 'MODEL_TIMEOUT'],
    ['REFUSED', 502, 'MODEL_REFUSED'],
    ['RATE_LIMITED', 503, 'MODEL_BUSY'],
    ['MODEL_ERROR', 502, 'MODEL_ERROR'],
    ['BAD_OUTPUT', 502, 'MODEL_ERROR'],
    ['CONFIG', 500, 'INTERNAL_ERROR'],
  ] as const)('a model failure %s is %i %s in fixed words, never the provider\'s text', async (code, status, mapped) => {
    const { a, t, file } = await started();
    await file(t.ann, 'Dentist appointment on Friday morning');
    statusFailure = { code, ...(code === 'RATE_LIMITED' ? { retryAfterMs: 4000 } : {}) };
    const r = await post(a, { text: 'status' }, t.ann);
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(mapped);
    expect(r.text).not.toContain('PROVIDER-SECRET');
    if (code === 'RATE_LIMITED') expect(r.headers['retry-after']).toBe('4');
    if (code === 'REFUSED') expect(r.json.error.message).toBe('the model declined to answer');
  });

  it('a controller with no status support is a plain 404 in fixed words', async () => {
    const { a, t } = await started();
    app = await (async () => {
      await a.api.close();
      return startCircleApp({
        more: ({ users, store, graphs, now }) => {
          const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() });
          const capture = createController({ adapter: graphs, llm, now: () => now.value });
          const caci = createCaciController({ users, capture, graphAdapter: graphs, scopes: createScopeResolver({ users, store }), clock: () => now.value });
          return createStatusRoutes({ caci });
        },
      });
    })();
    const b = app;
    const token = await signIn(b, 'ann');
    const r = await post(b, { text: 'x' }, token);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_FOUND');
    void t;
  });
});
