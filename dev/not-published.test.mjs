// The dev tools (graph explorer, LLM lab and the code they share) are local development tools.
// These tests fail if any of them could ever leak into a release or listen beyond this machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dev = dirname(fileURLToPath(import.meta.url));
const root = join(dev, '..');
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const devSources = () => walk(dev).filter((file) => /\.mjs$/.test(file) && !/\.test\.mjs$/.test(file));

describe('the dev tools are never part of a release', () => {
  it('the package only publishes an allow-list that does not include dev/', () => {
    const { files, private: isPrivate } = read('package.json');
    expect(files).toEqual(['dist', 'schema', 'web/*.html', 'web/*.js', 'web/*.css']);
    expect(isPrivate).toBe(true);
  });

  it('what npm would actually publish contains nothing from dev/, src/ or the tools', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const paths = JSON.parse(out)[0].files.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    const allowed = (path) => path === 'package.json' || /^(README\.md|LICENSE.*)$/i.test(path) || path.startsWith('dist/') || path.startsWith('schema/') || /^web\/[a-z-]+\.(html|js|css)$/.test(path);
    expect(paths.filter((p) => !allowed(p))).toEqual([]);
    expect(paths.filter((p) => /explorer|lab|server-kit|^dev\//.test(p))).toEqual([]);
  });

  it('the web app is published as its files and none of its tests', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const web = JSON.parse(out)[0].files.map((f) => f.path).filter((p) => p.startsWith('web/')).sort();
    expect(web).toEqual(['web/api-client.js', 'web/app.js', 'web/brain-session.js', 'web/capture-session.js', 'web/circle-page.js', 'web/circle-session.js', 'web/circles-client.js', 'web/circles-pages.js', 'web/circles-session.js', 'web/circles-view.js', 'web/forms.js', 'web/index.html', 'web/mount.js', 'web/notes-client.js', 'web/permissions.js', 'web/router.js', 'web/session.js', 'web/style.css', 'web/view.js']);
  });

  it('the library build only compiles src/, so dev code cannot end up in dist/', () => {
    expect(read('tsconfig.json').include).toEqual(['src']);
    const dist = join(root, 'dist');
    if (existsSync(dist)) expect(readdirSync(dist).sort()).toEqual(['api', 'app', 'caci', 'circles', 'graph_store', 'llm', 'service', 'sqlite', 'users']);
  });

  it('nothing in the library imports from the dev tools', () => {
    const offenders = walk(join(root, 'src')).filter((file) => /\.ts$/.test(file) && /\bdev\/|graph-explorer|llm-lab|server-kit/.test(readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*(import|export)\b.*from/.test(l)).join('\n')));
    expect(offenders).toEqual([]);
  });
});

describe('the dev tools only ever listen on this machine', () => {
  it('finds every dev source (so the checks below cannot pass by looking at nothing)', () => {
    const names = devSources().map((f) => relative(dev, f));
    expect(names).toContain(join('shared', 'server-kit.mjs'));
    expect(names).toContain(join('graph-explorer', 'app.mjs'));
  });

  it('the shared kit binds the loopback address and nothing else', () => {
    const kit = readFileSync(join(dev, 'shared', 'server-kit.mjs'), 'utf8');
    expect(kit).toContain("export const LOOPBACK = '127.0.0.1'");
    expect(kit).toContain('server.listen(port, LOOPBACK');
  });

  it('no dev source names a wider address', () => {
    for (const file of devSources()) expect(readFileSync(file, 'utf8'), relative(dev, file)).not.toMatch(/0\.0\.0\.0|'::'|"::"|\blocalhost:\*|listen\(\s*\d+\s*\)/);
  });

  it('only the shared kit touches the network modules, so every tool gets the same checks', () => {
    const creators = devSources()
      .filter((file) => /from\s+['"]node:(?:http|https|http2|net|dgram|tls)['"]|createServer\(/.test(readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')))
      .map((file) => relative(dev, file));
    expect(creators).toEqual([join('shared', 'server-kit.mjs')]);
  });
});
