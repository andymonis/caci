import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { baseConfig } from '../src/service/service.test-util.ts';
import { createCirclesClient } from './circles-client.js';
import { fakePage, fill, waitFor } from './fake-page.test-util.mjs';
import { createNotesClient } from './notes-client.js';
import { browserFetch, PW } from './sharing-world.test-util.mjs';
import { userHooks } from './user-hooks.js';
import { mountUser } from './user-mount.js';

// Agent access (R-022) through the everyday app's own page code against the real service: the person makes a key in Settings, an
// agent uses it on /mcp, the person stops it. Real SQLite files, real HTTP, real sessions.

let dir;
let service;
afterEach(async () => {
  await service?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  service = undefined;
});
async function boot(extra = {}) {
  dir = mkdtempSync(join(tmpdir(), 'caci-agent-journey-'));
  service = await startService({ ...baseConfig(dir), trustedProxies: 1, ...extra });
}
function browser() {
  const fetchFn = browserFetch(service.port);
  const page = fakePage('user.html');
  let current = '';
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mountUser(page.document, fetchFn, env, (context) => userHooks(page.document, fetchFn, context));
  return { page, fetchFn, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
async function register(b, username, displayName) {
  await waitFor(() => !el(b, 'screen-signed-out').hidden, 'the sign-in form');
  el(b, 'show-register').fire('click');
  fill(b.page, 'register', { username, displayName, email: '', password: PW });
  el(b, 'register-form').fire('submit');
  await waitFor(() => !el(b, 'screen-signed-in').hidden && !el(b, 'update-send').disabled, 'Home after registering');
}
const boxes = (b) => el(b, 'agent-brains').children.map((r) => r.querySelector('[data-slot="box"]'));
const keyRows = (b) => el(b, 'agent-list').children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
async function mcp(token, method, params) {
  const res = await fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? undefined : JSON.parse(text) };
}
const tool = async (token, name, args) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return r.json?.result?.structuredContent ?? r.json;
};
const openSettings = async (b) => {
  b.go('#/settings');
  await waitFor(() => !el(b, 'agent-access').hidden, 'the Agent access part');
};

describe('Agent access in Settings, against the real service', () => {
  it('is not there when the service has agent access off', async () => {
    await boot({ agentAccess: false });
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    eve.go('#/settings');
    await waitFor(() => !el(eve, 'view-settings').hidden, 'Settings');
    await new Promise((r) => setTimeout(r, 50));
    expect(el(eve, 'agent-access').hidden).toBe(true);
  });

  it('the person makes a key for their own notes and a circle, an agent uses it, the person stops it, and it stops working', async () => {
    await boot({ agentAccess: true });
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const circles = createCirclesClient({ fetchFn: eve.fetchFn });
    const club = await circles.createCircle({ name: 'Club' });
    const notes = createNotesClient({ fetchFn: eve.fetchFn });
    for (const [text, scope] of [['Dentist appointment on Tuesday at four'], ['Club picnic on Saturday afternoon', { kind: 'circle', circleId: club.value.id }]]) {
      const proposed = await notes.propose(text, scope);
      expect((await notes.approve(proposed.value.id)).ok).toBe(true);
    }

    await openSettings(eve);
    expect(el(eve, 'agent-warning').textContent).toContain("sent to your agent's provider");
    expect(el(eve, 'agent-brains').children.map((r) => slot(r, 'label').textContent)).toEqual(['My own notes', 'Circle "Club"']);
    expect(el(eve, 'agent-empty').hidden).toBe(false);

    el(eve, 'agent-name').value = 'Desk assistant';
    el(eve, 'agent-days').value = '30';
    boxes(eve).forEach((b) => (b.checked = true));
    el(eve, 'agent-form').fire('submit');
    await waitFor(() => !el(eve, 'agent-created').hidden, 'the new key');
    const token = el(eve, 'agent-created-token').value;
    expect(token).toMatch(/^cpat_[A-Za-z0-9_-]{43}$/);
    expect(keyRows(eve)).toHaveLength(1);
    expect(slot(keyRows(eve)[0], 'details').textContent).toContain('Can read: My own notes, Circle "Club".');
    expect(slot(keyRows(eve)[0], 'details').textContent).not.toContain(token);

    // the agent uses it
    expect((await mcp(token, 'initialize', { protocolVersion: '2025-06-18' })).json.result.serverInfo.name).toBe('caci');
    expect((await tool(token, 'list_brains', {})).brains.map((b) => b.name)).toEqual(['Your own notes', 'Club']);
    expect((await tool(token, 'search_facts', { scope: 'personal', text: 'dentist tuesday' })).facts).toHaveLength(1);
    expect((await tool(token, 'search_facts', { scope: `circle:${club.value.id}`, text: 'picnic saturday' })).facts).toHaveLength(1);

    // she dismisses it: the key's text is gone from the page, and the list still shows the key (without its text)
    el(eve, 'agent-created-done').fire('click');
    expect(el(eve, 'agent-created-token').value).toBe('');
    expect(keyRows(eve)).toHaveLength(1);
    expect((await tool(token, 'list_brains', {})).brains).toHaveLength(2); // still works: dismissing only forgets the text

    // she stops it, after being asked
    slot(keyRows(eve)[0], 'revoke').fire('click');
    expect(el(eve, 'agent-revoke-confirm').hidden).toBe(false);
    expect((await mcp(token, 'ping')).status).toBe(200); // asking changed nothing
    el(eve, 'agent-revoke-yes').fire('click');
    await waitFor(() => keyRows(eve).length === 0 && el(eve, 'agent-notice').textContent.startsWith('Stopped'), 'the key to be stopped');
    expect((await mcp(token, 'ping')).status).toBe(401);
  });

  it('forgets a new key on leaving Settings, and one person never sees another\'s keys', async () => {
    await boot({ agentAccess: true });
    const eve = browser();
    const fay = browser();
    await register(eve, 'eve', 'Eve');
    await register(fay, 'fay', 'Fay');
    await openSettings(eve);
    el(eve, 'agent-name').value = 'Eve key';
    el(eve, 'agent-days').value = '90';
    boxes(eve)[0].checked = true;
    el(eve, 'agent-form').fire('submit');
    await waitFor(() => !el(eve, 'agent-created').hidden, 'the new key');
    eve.go('#/');
    await waitFor(() => el(eve, 'agent-access').hidden, 'the part to be hidden');
    expect(el(eve, 'agent-created-token').value).toBe('');
    await openSettings(eve);
    expect(el(eve, 'agent-created').hidden).toBe(true);
    expect(keyRows(eve)).toHaveLength(1);
    await openSettings(fay);
    expect(keyRows(fay)).toHaveLength(0);
    expect(el(fay, 'agent-empty').hidden).toBe(false);
  });

  it('a name with markup stays text, and a full list is the service\'s words at the top', async () => {
    await boot({ agentAccess: true });
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    await openSettings(eve);
    el(eve, 'agent-days').value = '90';
    boxes(eve)[0].checked = true;
    for (let i = 0; i < 10; i++) {
      el(eve, 'agent-name').value = i === 0 ? '<img src=x onerror=alert(1)>' : `key ${i}`;
      boxes(eve)[0].checked = true;
      el(eve, 'agent-form').fire('submit');
      await waitFor(() => keyRows(eve).length === i + 1, `key ${i}`);
    }
    expect(keyRows(eve).map((r) => slot(r, 'name').textContent)).toContain('<img src=x onerror=alert(1)>');
    el(eve, 'agent-name').value = 'one too many';
    boxes(eve)[0].checked = true;
    el(eve, 'agent-form').fire('submit');
    await waitFor(() => !el(eve, 'agent-error').hidden, 'the refusal');
    expect(el(eve, 'agent-error').textContent).toMatch(/most agent tokens/);
    expect(keyRows(eve)).toHaveLength(10);
  });
});
