import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The LLM component and the graph store are separate components. The graph store knows nothing
// about the LLM; the LLM component reaches the graph store only through its public entry point; and
// no capability depends on another, so adding one never changes an existing one.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module specifier a source file imports from or re-exports from, including dynamic imports. */
export function importsOf(source: string): string[] {
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
  return found.filter((specifier) => specifier.startsWith('.'));
}

const stripExtension = (path: string): string => path.replace(/\.(?:ts|js|mjs)$/, '');

/** Describes every dependency that breaks the rules. `files` maps a path under src (like `llm/x.ts`) to its source. */
export function violations(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const specifier of importsOf(source)) {
      const target = stripExtension(relative('/', resolve('/', dirname(file), specifier)));
      if (file.startsWith('graph_store/') && (target === 'llm' || target.startsWith('llm/'))) {
        problems.push(`${file} imports ${specifier}: the graph store must not depend on the LLM component`);
      }
      if (file.startsWith('llm/') && target.startsWith('graph_store/') && target !== 'graph_store/index') {
        problems.push(`${file} imports ${specifier}: the LLM component may use the graph store only through graph_store/index`);
      }
      if (file.startsWith('llm/') && (target === 'app' || target.startsWith('app/'))) {
        problems.push(`${file} imports ${specifier}: the LLM component must not depend on the application`);
      }
      const own = /^llm\/capabilities\/([^/]+)\//.exec(file)?.[1];
      const other = /^llm\/capabilities\/([^/]+)(?:\/|$)/.exec(target)?.[1];
      if (own !== undefined && other !== undefined && other !== own) {
        problems.push(`${file} imports ${specifier}: a capability must not depend on another capability`);
      }
      if (file.startsWith('llm/') && !file.startsWith('llm/capabilities/') && target.startsWith('llm/capabilities/')) {
        problems.push(`${file} imports ${specifier}: the shared kernel must not depend on a capability`);
      }
    }
  }
  return problems;
}

function sourcesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) out[relative(srcRoot, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('the checker itself (so the real check below cannot pass by accident)', () => {
  it('finds imports of every kind', () => {
    const source = `import a from './a.js';\nimport type { B } from "../b.js";\nexport * from './c.js';\nconst d = await import('./d.js');\nimport z from 'zod';`;
    expect(importsOf(source)).toEqual(['./a.js', '../b.js', './c.js', './d.js']);
  });

  it('accepts a clean layout', () => {
    expect(
      violations({
        'graph_store/parse.ts': `import { x } from './result.js';`,
        'llm/index.ts': `import { y } from './errors.js';`,
        'llm/model-client.ts': `import type { Result } from '../graph_store/index.js';`,
        'llm/capabilities/categorise/guard.ts': `import { llmError } from '../../errors.js'; import { parseMutation } from '../../../graph_store/index.js'; import { c } from './context.js';`,
      }),
    ).toEqual([]);
  });

  it.each([
    ['the graph store importing the LLM component', { 'graph_store/x.ts': `import { llmError } from '../llm/errors.js';` }],
    ['the graph store importing the LLM entry point', { 'graph_store/x.ts': `import '../llm/index.js';` }],
    ['the graph store re-exporting from the LLM component', { 'graph_store/index.ts': `export * from '../llm/index.js';` }],
    ['the LLM component reaching into graph store internals', { 'llm/x.ts': `import { parseMutation } from '../graph_store/parse.js';` }],
    ['a capability reaching into graph store internals', { 'llm/capabilities/categorise/x.ts': `import { y } from '../../../graph_store/limits.js';` }],
    ['the LLM component importing the application', { 'llm/x.ts': `import { app } from '../app/index.js';` }],
    ['one capability importing another', { 'llm/capabilities/categorise/x.ts': `import { answer } from '../answer/index.js';` }],
    ['the kernel importing a capability', { 'llm/model-client.ts': `import { categorise } from './capabilities/categorise/index.js';` }],
  ])('catches %s', (_name, files) => {
    expect(violations(files).length).toBeGreaterThan(0);
  });
});

describe('the real source tree', () => {
  it('keeps the components apart', () => {
    const files = { ...sourcesUnder(join(srcRoot, 'graph_store')), ...sourcesUnder(join(srcRoot, 'llm')) };
    delete files['llm/boundary.test.ts']; // its sample violations are text inside this very file
    expect(Object.keys(files).some((f) => f.startsWith('graph_store/'))).toBe(true);
    expect(Object.keys(files).some((f) => f.startsWith('llm/'))).toBe(true);
    expect(violations(files)).toEqual([]);
  });
});
