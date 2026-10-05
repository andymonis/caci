import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // src/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}
const MENTIONS = /node:sqlite/;

describe('the SQLite driver stays behind one file', () => {
  it('only sqlite/db.ts mentions node:sqlite in code (tests and comments aside)', () => {
    const offenders = sources(root).filter((file) => {
      if (file.endsWith('.test.ts') || file.endsWith('/sqlite/db.ts')) return false;
      const code = readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      return /(from|import)\s*\(?\s*['"]node:sqlite['"]/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it('db.ts does mention it (the scan would otherwise prove nothing)', () => {
    expect(MENTIONS.test(readFileSync(join(root, 'graph_store', 'adapters', 'sqlite', 'db.ts'), 'utf8'))).toBe(true);
  });

  it('the scan catches an import in the forms people write', () => {
    for (const code of ["import { DatabaseSync } from 'node:sqlite';", 'const m = await import("node:sqlite");']) {
      expect(/(from|import)\s*\(?\s*['"]node:sqlite['"]/.test(code)).toBe(true);
    }
  });
});
