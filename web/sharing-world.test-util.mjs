import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { createSqliteAdapter } from '../src/graph_store/adapters/sqlite/index.ts';
import { write } from '../src/graph_store/index.ts';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCirclesClient } from './circles-client.js';
import { createLedgerClient } from './ledger-client.js';
import { createNotesClient } from './notes-client.js';
import { createSharingClient } from './sharing-client.js';

// A real service on real files with three accounts in one circle, ann's brain seeded, for the tests of the
// sharing client and the sharing logic. Importing this file registers the clean-up after each test.

export const PW = 'correct horse 7 staple';
export const SECRET = 'SECRET-PRIVATE-CATEGORY';
const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client = 0;
export function browserFetch(port) {
  let cookie;
  const address = `198.51.100.${(client++ % 250) + 1}`;
  return async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}), origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': address },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
    return res;
  };
}

export const ODD_CATEGORY = 'a b/c?d=e&f#g 😀';
export const ODD_ITEM = '<b>item</b> 100%';

export async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sharing-web-'));
  dirs.push(dir);
  const service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, sessionIdleDays: 7, sessionDays: 30 });
  running.push(service);
  const people = {};
  for (const name of ['ann', 'bob', 'cat', 'dan']) {
    const f = browserFetch(service.port);
    const api = createApiClient({ fetchFn: f });
    const registered = await api.register({ username: name, displayName: `Display ${name}`, password: PW });
    await api.login({ username: name, password: PW });
    people[name] = { fetch: f, id: registered.value.id, circles: createCirclesClient({ fetchFn: f }), sharing: createSharingClient({ fetchFn: f }), notes: createNotesClient({ fetchFn: f }), ledger: createLedgerClient({ fetchFn: f }) };
  }
  const circle = (await people.ann.circles.createCircle({ name: 'Club' })).value.id;
  for (const name of ['bob', 'cat']) {
    await people.ann.circles.invite(circle, { username: name, role: 'member' });
    const invitation = (await people[name].circles.myInvitations()).value.items[0].id;
    expect((await people[name].circles.acceptInvitation(invitation)).ok).toBe(true);
  }
  const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    const wrote = await write(graphs, {
      version: 1,
      kind: 'mutation',
      graphId: `user-${people.ann.id}`,
      ops: [
        { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health <i>x</i>' } },
        { op: 'upsertNode', partition: 'category', id: 'secret', data: { name: SECRET } },
        { op: 'upsertNode', partition: 'category', id: ODD_CATEGORY, data: { name: 'Odd' } },
        { op: 'upsertNode', partition: 'item', id: 'both', data: { title: 'Dentist', summary: '<script>x</script>' } },
        { op: 'upsertNode', partition: 'item', id: 'hidden', data: { title: 'hidden' } },
        { op: 'upsertNode', partition: 'item', id: ODD_ITEM, data: { title: 'Odd' } },
        { op: 'link', item: 'both', category: 'health', weight: 0.9 },
        { op: 'link', item: 'both', category: 'secret' },
        { op: 'link', item: 'hidden', category: 'secret' },
        { op: 'link', item: ODD_ITEM, category: ODD_CATEGORY },
      ],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  } finally {
    await graphs.close();
  }
  return { ...people, circle, annId: people.ann.id, service, dir };
}

