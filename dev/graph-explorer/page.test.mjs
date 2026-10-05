import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../../src/graph_store/adapters/memory/index.ts';
import * as library from '../../src/graph_store/index.ts';
import { createApp } from './app.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const sources = readdirSync(publicDir).filter((f) => f.endsWith('.js'));
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

describe('the explorer page', () => {
  it('finds its scripts (so the checks below cannot pass by looking at nothing)', () => {
    expect(sources.sort()).toEqual(['app.js', 'capture.js', 'layout.js', 'scenarios.js', 'storage.js']);
  });

  it.each(sources)('%s never writes HTML or runs text as code', (file) => {
    const code = readFileSync(join(publicDir, file), 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of [/\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /\.srcdoc/, /DOMParser/]) {
      expect(code, `${file} uses ${bad}`).not.toMatch(bad);
    }
  });

  it('every id the script looks up exists in the page', () => {
    const script = readFileSync(join(publicDir, 'app.js'), 'utf8');
    const wanted = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    const present = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const id of wanted) expect(present.has(id), `#${id} is used by app.js but missing from index.html`).toBe(true);
    for (const id of ['capture', 'capture-text', 'capture-propose', 'capture-approve', 'capture-reject', 'capture-real', 'capture-summary']) expect(wanted.has(id), id).toBe(true);
  });

  it('loads nothing from the network', () => {
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) expect(url, url).toMatch(/^\//);
    // the SVG namespace is an identifier, not an address anything is fetched from
    for (const file of sources) expect(readFileSync(join(publicDir, file), 'utf8').replaceAll('http://www.w3.org/2000/svg', ''), file).not.toMatch(/https?:\/\/|@import/);
  });

  it('the capture panel is hidden until the server says capture is on, and the real-model switch starts off', () => {
    expect(html).toMatch(/<section id="capture" hidden>/);
    expect(html).toMatch(/<input type="checkbox" id="capture-real">/);
  });

  it('serves the capture script', async () => {
    const explorer = createApp({ ...library, createMemoryAdapter });
    const port = await explorer.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/capture.js`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/javascript');
    } finally {
      await explorer.close();
    }
  });
});
