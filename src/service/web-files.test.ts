import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, createWebRoutes } from '../api/index.js';
import { loadWebFiles, type WebFileSpec } from './web-files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-web-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const SPECS: readonly WebFileSpec[] = [
  { path: '/', file: 'index.html', kind: 'html' },
  { path: '/app.js', file: 'app.js', kind: 'js' },
  { path: '/style.css', file: 'style.css', kind: 'css' },
];
const GOOD = { 'index.html': '<!doctype html>', 'app.js': "console.log('é')", 'style.css': 'a{}' };

describe('loading the web app\'s files', () => {
  it('reads exactly the listed files as UTF-8, with the path and kind given', () => {
    const files = loadWebFiles(folder(GOOD), SPECS);
    expect(files).toEqual([
      { path: '/', kind: 'html', text: '<!doctype html>' },
      { path: '/app.js', kind: 'js', text: "console.log('é')" },
      { path: '/style.css', kind: 'css', text: 'a{}' },
    ]);
  });

  it('never reads or returns anything that is not listed, whatever else is in the folder', () => {
    const dir = folder({ ...GOOD, 'secret.txt': 'TOP SECRET', '.env': 'KEY=1' });
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'x.js'), 'hidden');
    const files = loadWebFiles(dir, SPECS);
    expect(JSON.stringify(files)).not.toMatch(/SECRET|KEY=1|hidden/);
    expect(files).toHaveLength(3);
  });

  it('a missing file stops the start and the message names it and the folder', () => {
    const dir = folder({ 'index.html': 'x', 'style.css': 'y' });
    expect(() => loadWebFiles(dir, SPECS)).toThrow(`the web app is missing its file "app.js" in ${dir}`);
    expect(() => loadWebFiles(join(dir, 'nowhere'), SPECS)).toThrow(/missing its file "index.html"/);
  });

  it('a folder, a link or an oversized file instead of an ordinary file is refused, and said', () => {
    const dir = folder(GOOD);
    rmSync(join(dir, 'app.js'));
    mkdirSync(join(dir, 'app.js'));
    expect(() => loadWebFiles(dir, SPECS)).toThrow(/"app.js".*not an ordinary file/);
    rmSync(join(dir, 'app.js'), { recursive: true });
    const elsewhere = folder({ 'real.js': 'secret outside' });
    symlinkSync(join(elsewhere, 'real.js'), join(dir, 'app.js'));
    expect(() => loadWebFiles(dir, SPECS)).toThrow(/"app.js".*not an ordinary file/);
    rmSync(join(dir, 'app.js'));
    writeFileSync(join(dir, 'app.js'), 'x'.repeat(512 * 1024 + 1));
    expect(() => loadWebFiles(dir, SPECS)).toThrow(/larger than 524288 bytes/);
    writeFileSync(join(dir, 'app.js'), 'x'.repeat(512 * 1024));
    expect(() => loadWebFiles(dir, SPECS)).not.toThrow();
  });

  it('file names must be plain names: no folders, no dot segments, no odd characters', () => {
    const dir = folder(GOOD);
    for (const file of ['../x', 'a/b', '', '.hidden', 'UP.JS', 'a..b', 'a b', 'x\0y', `${'a'.repeat(65)}`, '/etc/passwd', 'sub/../app.js']) {
      expect(() => loadWebFiles(dir, [{ path: '/', file, kind: 'html' }]), JSON.stringify(file)).toThrow(TypeError);
    }
  });

  it('works end to end: the bytes of the files are what the server sends, and only those', async () => {
    const dir = folder({ ...GOOD, 'secret.txt': 'TOP SECRET' });
    const api = createApiServer({ routes: createWebRoutes({ files: loadWebFiles(dir, SPECS) }) });
    const port = await api.listen(0);
    try {
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, text: await res.text() };
      };
      expect(await get('/')).toEqual({ status: 200, text: '<!doctype html>' });
      expect(await get('/app.js')).toEqual({ status: 200, text: "console.log('é')" });
      expect((await get('/secret.txt')).status).toBe(404);
      expect((await get('/secret.txt')).text).not.toContain('SECRET');
    } finally {
      await api.close();
    }
  });
});
