import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_POLICY } from '../api/index.js';
import type { ServiceConfig } from './config.js';
import { serve } from './cli.js';
import { startService, type RunningService } from './service.js';
import { defaultWebDir, WEB_FILE_SPECS } from './web-app.js';

// The web app served by the running service (R-005): real files, real HTTP.

const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-web-svc-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7 });
async function start(webDir?: string): Promise<{ service: RunningService; base: string; dir: string }> {
  const dir = tmp();
  const service = await startService(config(dir), webDir === undefined ? {} : { webDir });
  running.push(service);
  return { service, base: `http://127.0.0.1:${service.port}`, dir };
}
const webFolder = defaultWebDir();
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' } as const;

describe('the list of files', () => {
  it('is exactly the files in web/ that are not tests: nothing unlisted is ever served, nothing listed is missing', () => {
    const inFolder = readdirSync(webFolder).filter((f) => !/\.test(-util)?\.mjs$/.test(f)).sort();
    expect(WEB_FILE_SPECS.map((s) => s.file).sort()).toEqual(inFolder);
  });

  it('serves the page at / and each other file at its own name', () => {
    expect(WEB_FILE_SPECS.map((s) => s.path).sort()).toEqual(['/', '/api-client.js', '/app.js', '/circle-page.js', '/circle-session.js', '/circles-client.js', '/circles-pages.js', '/circles-session.js', '/circles-view.js', '/forms.js', '/mount.js', '/permissions.js', '/router.js', '/session.js', '/style.css', '/view.js']);
    for (const spec of WEB_FILE_SPECS) {
      if (spec.path === '/') expect(spec.file).toBe('index.html');
      else expect(spec.path).toBe(`/${spec.file}`);
    }
  });

  it('is frozen, and the folder it reads is the one beside the code', () => {
    expect(Object.isFrozen(WEB_FILE_SPECS)).toBe(true);
    expect(existsSync(join(webFolder, 'index.html'))).toBe(true);
    expect(webFolder.endsWith('/web/')).toBe(true);
  });
});

describe('the running service serves the web app', () => {
  it('sends each file with exactly its bytes, its type and the web policy', async () => {
    const { base } = await start();
    for (const spec of WEB_FILE_SPECS) {
      const res = await fetch(`${base}${spec.path}`);
      expect(res.status, spec.path).toBe(200);
      expect(await res.text(), spec.path).toBe(readFileSync(join(webFolder, spec.file), 'utf8'));
      const byExtension = spec.file.endsWith('.html') ? TYPES.html : spec.file.endsWith('.css') ? TYPES.css : TYPES.js; // from the name, not from the list under test
      expect(res.headers.get('content-type'), spec.path).toBe(byExtension);
      expect(res.headers.get('content-security-policy'), spec.path).toBe(WEB_POLICY);
      expect(res.headers.get('cache-control'), spec.path).toBe('no-store');
      expect(res.headers.get('x-content-type-options'), spec.path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), spec.path).toBe('no-referrer');
    }
  });

  it('the page is the web app\'s page, and it asks for exactly the files that are served', async () => {
    const { base } = await start();
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('<title>CaCi</title>');
    const asked = [...page.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(asked.sort()).toEqual(['/app.js', '/style.css']);
    for (const path of asked) expect((await fetch(`${base}${path}`)).status).toBe(200);
  });

  it('every module imports only files that are served', async () => {
    const { base } = await start();
    for (const spec of WEB_FILE_SPECS.filter((s) => s.kind === 'js')) {
      const text = await (await fetch(`${base}${spec.path}`)).text();
      for (const m of text.matchAll(/from '(\.\/[a-z-]+\.js)'/g)) expect((await fetch(`${base}/${(m[1] as string).slice(2)}`)).status, `${spec.path} -> ${m[1]}`).toBe(200);
    }
  });

  it('API routes are unchanged: signed out is still a JSON 401 and the API keeps the lock-down', async () => {
    const { base } = await start();
    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(401);
    expect(me.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(me.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(await me.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });

  it('anything else is still a plain JSON 404: other files, folders, tests, source, dot-dot and encodings', async () => {
    const { base } = await start();
    const paths = ['/index.html', '/web', '/web/index.html', '/mount.test.mjs', '/pages.test.mjs', '/fake-page.test-util.mjs', '/package.json', '/src/service/service.ts', '/../package.json', '/%2e%2e/package.json', '/.env', '/app.js/', '/APP.JS', '/favicon.ico', '/data/users.db', '/users.db', '/graphs.db'];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toBe('application/json; charset=utf-8');
      expect(res.headers.get('content-security-policy'), path).toBe("default-src 'none'");
    }
  });

  it('only GET: a POST to the page is 405', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('a clean stop after serving the app leaves only the two database files', async () => {
    const { service, base, dir } = await start();
    await fetch(`${base}/`);
    await service.close();
    running.splice(running.indexOf(service), 1);
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
  });
});

describe('the folder it reads from', () => {
  function copy(skip: string[] = []): string {
    const dir = tmp();
    for (const spec of WEB_FILE_SPECS) if (!skip.includes(spec.file)) copyFileSync(join(webFolder, spec.file), join(dir, spec.file));
    return dir;
  }

  it('serves only the listed files from it, whatever else is there', async () => {
    const web = copy();
    writeFileSync(join(web, 'secret.txt'), 'TOP SECRET');
    writeFileSync(join(web, 'extra.js'), 'alert(1)');
    mkdirSync(join(web, 'sub'));
    writeFileSync(join(web, 'sub', 'x.js'), 'hidden');
    const { base } = await start(web);
    for (const path of ['/secret.txt', '/extra.js', '/sub/x.js']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toMatch(/SECRET|alert|hidden/);
    }
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });

  it('a missing file stops the start, names the file, and leaves no data folder behind', async () => {
    const web = copy(['mount.js']);
    const dir = tmp();
    const data = join(dir, 'data');
    await expect(startService({ ...config(data) }, { webDir: web })).rejects.toThrow(`the web app is missing its file "mount.js" in ${web}`);
    expect(existsSync(data)).toBe(false);
  });

  it('a folder that does not exist stops the start the same way', async () => {
    const data = join(tmp(), 'data');
    await expect(startService(config(data), { webDir: join(tmp(), 'nowhere') })).rejects.toThrow(/missing its file "index.html"/);
    expect(existsSync(data)).toBe(false);
  });
});

describe('serve', () => {
  it('says where to open the web app', async () => {
    const out: string[] = [];
    const dir = tmp();
    const result = await serve({ CACI_PORT: '0', CACI_DATA_DIR: dir }, { stdout: (t) => void out.push(t), stderr: () => undefined });
    expect(result.code).toBe(0);
    if (result.code === 0) running.push(result.service);
    expect(out.join('')).toMatch(/Open http:\/\/127\.0\.0\.1:\d+\/ in a browser to register and sign in\./);
  });
});
