import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function messages(code: string, filePath = 'src/example.ts') {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((m) => m.ruleId === 'no-restricted-syntax') ?? [];
}

describe('purity lint rule (NFR-02)', () => {
  it.each([
    ['module-level let', 'let counter = 0;\nexport const bump = () => counter++;'],
    ['module-level var', 'var cache = 1;\nexport const read = () => cache;'],
    ['exported let', 'export let state = 0;'],
    ['module-level Map', 'const cache = new Map<string, number>();\nexport const size = () => cache.size;'],
    ['exported Set', 'export const seen = new Set<string>();'],
    ['module-level array literal', 'const queue: string[] = [];\nexport const n = () => queue.length;'],
  ])('flags %s', async (_name, code) => {
    expect((await messages(code)).length).toBeGreaterThan(0);
  });

  it.each([
    ['const primitives and functions', 'const limit = 5;\nexport const f = () => limit;'],
    ['frozen objects', 'export const D = Object.freeze({ a: 1 });'],
    ['as-const arrays', 'export const CODES = ["a", "b"] as const;'],
    ['state created inside a function', 'export function make() { let n = 0; const m = new Map(); return () => (n++, m); }'],
  ])('allows %s', async (_name, code) => {
    expect(await messages(code)).toEqual([]);
  });

  it('is not applied to tests', async () => {
    expect(await messages('let x = 0;\nexport { x };', 'src/example.test.ts')).toEqual([]);
  });

  it('currently holds for the whole library', async () => {
    const results = await eslint.lintFiles(['src/**/*.ts']);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map(() => r.filePath),
    );
    expect(offenders).toEqual([]);
  }, 60_000); // lints every source file, so it grows with the code base and slows under load
});
