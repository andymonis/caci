// The explorer is a local development tool. These tests fail if it could ever leak into a release.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

describe('the explorer is never part of a release', () => {
  it('the package only publishes an allow-list that does not include dev/', () => {
    const { files, private: isPrivate } = read('package.json');
    expect(files).toEqual(['dist', 'schema']);
    expect(isPrivate).toBe(true);
  });

  it('what npm would actually publish contains nothing from dev/, src/ or the explorer', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const paths = JSON.parse(out)[0].files.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    const allowed = (path) => path === 'package.json' || /^(README\.md|LICENSE.*)$/i.test(path) || path.startsWith('dist/') || path.startsWith('schema/');
    expect(paths.filter((p) => !allowed(p))).toEqual([]);
    expect(paths.filter((p) => /explorer|^dev\//.test(p))).toEqual([]);
  });

  it('the library build only compiles src/, so dev code cannot end up in dist/', () => {
    expect(read('tsconfig.json').include).toEqual(['src']);
    const dist = join(root, 'dist');
    if (existsSync(dist)) expect(readdirSync(dist)).toEqual(['graph_store']);
  });

  it('nothing in the library imports from the explorer', () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const offenders = walk(join(root, 'src')).filter((file) => /\.ts$/.test(file) && /\bdev\/|graph-explorer/.test(readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*(import|export)\b.*from/.test(l)).join('\n')));
    expect(offenders).toEqual([]);
  });

  it('the dev server entry point refuses to bind anything but loopback', () => {
    const app = readFileSync(join(root, 'dev', 'graph-explorer', 'app.mjs'), 'utf8');
    expect(app).toContain("const LOOPBACK = '127.0.0.1'");
    expect(app).not.toMatch(/0\.0\.0\.0|'::'/);
  });
});
