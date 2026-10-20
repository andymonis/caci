import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards on the everyday app's own files (R-016 UP-NFR-01, UP-FR-09), like pages.test.mjs for the back office: no inline code, nothing
// from another address, no way to turn text into markup, no browser storage. They read the real files, so a careless edit breaks the build.

const dir = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(dir, name), 'utf8');
const html = read('user.html');
const css = read('user-style.css');
const tags = [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2], text: m[0] }));
const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag.attrs)?.[1];
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w"'`/])\/\/.*$/gm, '$1');

/** The modules the page loads: user-app.js and everything it imports, by name, transitively. */
function modulesOf(entry) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const m of code(read(name)).matchAll(/from\s+'\.\/([a-z0-9.-]+\.js)'/g)) visit(m[1]);
  };
  visit(entry);
  return [...seen].sort();
}
const modules = modulesOf('user-app.js');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

describe('the page', () => {
  it('loads one module script from /user-app.js and one style sheet, and nothing else', () => {
    const scripts = tags.filter((t) => t.name === 'script');
    expect(scripts).toHaveLength(1);
    expect(attr(scripts[0], 'src')).toBe('/user-app.js');
    expect(attr(scripts[0], 'type')).toBe('module');
    expect(html).toMatch(/<script type="module" src="\/user-app\.js"><\/script>/);
    expect(tags.filter((t) => t.name === 'link').map((t) => `${attr(t, 'rel')} ${attr(t, 'href')}`).sort()).toEqual(['icon data:,', 'stylesheet /user-style.css']);
    expect(tags.filter((t) => t.name === 'style' || t.name === 'iframe' || t.name === 'img' || t.name === 'form' && attr(t, 'action') !== undefined)).toEqual([]);
  });
  it('has no inline style, event handler or off-site address', () => {
    for (const t of tags) {
      expect(t.attrs, t.text).not.toMatch(/\sstyle\s*=/i);
      expect(t.attrs, t.text).not.toMatch(/\son[a-z]+\s*=/i);
      for (const name of ['src', 'href', 'action', 'formaction', 'poster', 'data', 'srcset']) {
        const value = attr(t, name);
        if (value !== undefined) expect(['/user-app.js', '/user-style.css', '/admin', '#/', '#/settings', 'data:,'], `${t.name} ${name}`).toContain(value);
      }
    }
  });
  it('has unique ids, and every for and aria-describedby points at one', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of tags) {
      const f = attr(t, 'for');
      if (f !== undefined) expect(ids, `for=${f}`).toContain(f);
      for (const d of (attr(t, 'aria-describedby') ?? '').split(/\s+/).filter(Boolean)) expect(ids, `describedby ${d}`).toContain(d);
    }
  });
  it('gives every input a visible label, a name and the right autocomplete', () => {
    const inputs = tags.filter((t) => t.name === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(8);
    for (const t of inputs) {
      const id = attr(t, 'id');
      expect(html, id).toMatch(new RegExp(`<label for="${id}"`));
      expect(attr(t, 'name'), id).toBeTruthy();
      expect(attr(t, 'autocomplete'), id).toBeTruthy();
    }
    const pw = (id) => tags.find((t) => attr(t, 'id') === id);
    expect(attr(pw('signin-password'), 'autocomplete')).toBe('current-password');
    expect(attr(pw('register-password'), 'autocomplete')).toBe('new-password');
    expect(attr(pw('password-newPassword'), 'autocomplete')).toBe('new-password');
    expect(attr(pw('password-currentPassword'), 'autocomplete')).toBe('current-password');
    for (const id of ['signin-password', 'register-password', 'password-newPassword', 'password-currentPassword']) expect(attr(pw(id), 'type')).toBe('password');
  });
  it('every form is a post with no action, so a failed script can never put a password in an address', () => {
    for (const t of tags.filter((x) => x.name === 'form')) {
      expect(attr(t, 'method')).toBe('post');
      expect(attr(t, 'action')).toBeUndefined();
      expect(t.attrs).toMatch(/\bnovalidate\b/);
    }
  });
  it('starts with every screen and view hidden, so nothing shows without the script', () => {
    for (const id of ['screen-loading', 'screen-unreachable', 'screen-signed-out', 'screen-signed-in', 'signin-section', 'register-section', 'view-home', 'view-settings']) {
      expect(tags.find((t) => attr(t, 'id') === id)?.attrs, id).toMatch(/\bhidden\b/);
    }
    expect(html).toContain('<noscript>');
  });
  it('is for a phone: a viewport, large touch targets, and light only', () => {
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
    expect(css).toMatch(/min-height:\s*2\.75rem/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(html).not.toMatch(/color-scheme/);
  });
  it('has no manifest, icon file or service worker yet (R-016 D10)', () => {
    expect(html).not.toMatch(/manifest|apple-touch-icon|serviceWorker/i);
    for (const m of modules) expect(code(read(m)), m).not.toMatch(/serviceWorker|navigator\.|caches\b/);
  });
  it('the style sheet loads nothing from anywhere', () => {
    expect(css).not.toMatch(/@import|url\(|@font-face/);
  });
});

describe('the scripts', () => {
  it('are exactly the modules the entry point reaches, and import only each other by name', () => {
    // the chat reuses the notes client, which brings the back office's shared word and permission modules with it
    expect(modules).toEqual(['api-client.js', 'capture-view.js', 'chat-page.js', 'chat-session.js', 'chat-view.js', 'circles-client.js', 'circles-session.js', 'circles-view.js', 'forms.js', 'notes-client.js', 'permissions.js', 'router.js', 'session.js', 'settings-session.js', 'status-session.js', 'status-view.js', 'user-app.js', 'user-mount.js', 'view.js']);
    for (const m of modules) for (const x of code(read(m)).matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) expect(x[1], `${m} imports ${x[1]}`).toMatch(/^\.\/[a-z0-9.-]+\.js$/);
  });
  it('never turn text into markup, run strings as code, or use storage, cookies or the console', () => {
    for (const m of modules) {
      const c = code(read(m));
      for (const banned of [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /DOMParser/, /\beval\s*\(/, /new Function/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /createElement/, /appendChild/, /localStorage|sessionStorage|indexedDB/, /document\.cookie/, /console\./, /\bsrcdoc\b/]) {
        expect(c, `${m} ${banned}`).not.toMatch(banned);
      }
    }
  });
  it('only the entry point touches the address bar', () => {
    for (const m of modules) {
      if (m === 'user-app.js') continue;
      expect(code(read(m)), m).not.toMatch(/\blocation\b|\bhistory\b|\bhashchange\b/);
    }
    expect(code(read('user-app.js'))).toMatch(/window\.location\.hash/);
  });
  it('name only routes that exist, by path (the chat itself uses the account, capture, scope and status routes: see the journey)', () => {
    const paths = new Set();
    for (const m of modules) for (const x of code(read(m)).matchAll(/['"`](\/api\/[^'"`?$]*)/g)) paths.add(x[1]);
    expect([...paths].sort()).toEqual(['/api/brain', '/api/brain/categories', '/api/brain/category', '/api/brain/item', '/api/brain/scopes', '/api/capture/mode', '/api/capture/proposals/', '/api/capture/propose', '/api/circles', '/api/circles/', '/api/graph/categories', '/api/graph/category', '/api/graph/item', '/api/invitations', '/api/invitations/', '/api/login', '/api/logout', '/api/me', '/api/me/password', '/api/register', '/api/status']);
  });
  it('every element the script looks up exists in the page', () => {
    const wanted = new Set();
    for (const x of code(read('user-mount.js')).matchAll(/\$\('([a-zA-Z-]+)'\)/g)) wanted.add(x[1]);
    for (const x of code(read('user-mount.js')).matchAll(/\$\(`([^`]+)`\)/g)) {
      const t = x[1];
      if (t.includes('screen-')) for (const s of ['loading', 'unreachable', 'signed-out', 'signed-in']) wanted.add(`screen-${s}`);
      else if (t === '${form}-form') for (const f of ['signin', 'register', 'profile', 'password']) wanted.add(`${f}-form`);
      else if (t.includes('${form}-${field}-error')) {
        for (const [f, fields] of Object.entries({ signin: ['username', 'password'], register: ['username', 'displayName', 'email', 'password'], profile: ['displayName', 'email'], password: ['currentPassword', 'newPassword'] })) for (const fl of fields) wanted.add(`${f}-${fl}-error`);
      } else if (t.includes('${form}-${field}')) {
        for (const [f, fields] of Object.entries({ signin: ['username', 'password'], register: ['username', 'displayName', 'email', 'password'], profile: ['displayName', 'email'], password: ['currentPassword', 'newPassword'] })) for (const fl of fields) wanted.add(`${f}-${fl}`);
      } else if (t.includes('${form}-section')) for (const f of ['signin', 'register']) wanted.add(`${f}-section`);
      else if (t.includes('${form}-error')) for (const f of ['signin', 'register', 'profile', 'password']) wanted.add(`${f}-error`);
      else if (t.includes('${form}-submit')) for (const f of ['signin', 'register', 'profile', 'password']) wanted.add(`${f}-submit`);
      else if (t.includes('${form}-notice')) for (const f of ['profile', 'password']) wanted.add(`${f}-notice`);
      else if (t.includes('view-')) for (const v of ['home', 'settings']) wanted.add(`view-${v}`);
      else if (t.includes('nav-')) for (const v of ['home', 'settings']) wanted.add(`nav-${v}`);
      else if (t.includes('-heading')) for (const v of ['home', 'settings']) wanted.add(`${v}-heading`);
      else throw new Error(`the guard does not know how to check ${t}`);
    }
    for (const x of code(read('chat-page.js')).matchAll(/\$\('([a-zA-Z-]+)'\)/g)) wanted.add(x[1]);
    for (const id of wanted) expect(ids, id).toContain(id);
    expect(wanted.size).toBeGreaterThan(30);
  });
});
