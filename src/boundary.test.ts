import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The graph store, the LLM component and the application are separate components. The graph store
// knows nothing about the other two; the LLM component knows nothing about the application; the
// application reaches the other two only through their public entry points; and no capability
// depends on another, so adding one never changes an existing one.

const srcRoot = dirname(fileURLToPath(import.meta.url));

/** Every module specifier a source file imports from or re-exports from, including dynamic imports. */
export function importsOf(source: string): string[] {
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
  return found.filter((specifier) => specifier.startsWith('.'));
}

const stripExtension = (path: string): string => path.replace(/\.(?:ts|js|mjs)$/, '');

/** The files that put the capabilities together; they are the only ones outside `capabilities/` allowed to import them. */
const ASSEMBLY: readonly string[] = Object.freeze(['llm/index.ts', 'llm/create-llm.ts']);

/**
 * The public entry points the application may import. Its tests (and test utilities) may also use
 * the memory and SQLite adapters and the scripted model client, which is how they get a store and a model.
 */
const APP_MAY_USE: readonly string[] = Object.freeze(['graph_store/index']);
const APP_TEST_MAY_USE: readonly string[] = Object.freeze(['graph_store/index', 'graph_store/adapters/memory/index', 'graph_store/adapters/sqlite/index']);
const APP_LLM: readonly string[] = Object.freeze(['llm/index']);
const APP_TEST_LLM: readonly string[] = Object.freeze(['llm/index', 'llm/testing/index']);

/** Describes every dependency that breaks the rules. `files` maps a path under src (like `llm/x.ts`) to its source. */
export function violations(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const specifier of importsOf(source)) {
      const target = stripExtension(relative('/', resolve('/', dirname(file), specifier)));
      if (file.startsWith('graph_store/') && (target === 'llm' || target.startsWith('llm/'))) {
        problems.push(`${file} imports ${specifier}: the graph store must not depend on the LLM component`);
      }
      if (file.startsWith('graph_store/') && (target === 'app' || target.startsWith('app/'))) {
        problems.push(`${file} imports ${specifier}: the graph store must not depend on the application`);
      }
      const appTest = /\.test(?:-util)?\.ts$/.test(file);
      if (file.startsWith('app/') && target.startsWith('graph_store/') && !(appTest ? APP_TEST_MAY_USE : APP_MAY_USE).includes(target)) {
        problems.push(`${file} imports ${specifier}: the application may use the graph store only through its public entry points (${(appTest ? APP_TEST_MAY_USE : APP_MAY_USE).join(', ')})`);
      }
      if (file.startsWith('app/') && target.startsWith('llm/') && !(appTest ? APP_TEST_LLM : APP_LLM).includes(target)) {
        problems.push(`${file} imports ${specifier}: the application may use the LLM component only through its public entry points (${(appTest ? APP_TEST_LLM : APP_LLM).join(', ')})`);
      }
      if (file.startsWith('llm/') && target.startsWith('graph_store/') && target !== 'graph_store/index') {
        problems.push(`${file} imports ${specifier}: the LLM component may use the graph store only through graph_store/index`);
      }
      if (file.startsWith('llm/') && (target === 'app' || target.startsWith('app/'))) {
        problems.push(`${file} imports ${specifier}: the LLM component must not depend on the application`);
      }
      const usersTest = /\.test(?:-util)?\.ts$/.test(file);
      if (file.startsWith('users/') && target.startsWith('graph_store/') && target !== 'graph_store/index' && !(usersTest && (target === 'graph_store/adapters/memory/index' || target === 'graph_store/adapters/sqlite/index'))) {
        problems.push(`${file} imports ${specifier}: the users component may use the graph store only through graph_store/index (its tests may also use the memory and SQLite adapters)`);
      }
      if (file.startsWith('users/') && /^(?:llm|app|api)(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: the users component must not depend on the LLM component, the application or the API`);
      }
      if (/^(?:graph_store|llm|app|sqlite)\//.test(file) && /^users(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: only the API may depend on the users component`);
      }
      if (file.startsWith('service/') && /^(?:llm|app|sqlite)(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: the service must not depend on the LLM component, the application or the SQLite wrapper`);
      }
      if (file.startsWith('service/') && target.startsWith('graph_store/') && !/^graph_store\/(?:index|adapters\/sqlite\/index)$/.test(target)) {
        problems.push(`${file} imports ${specifier}: the service may use the graph store only through graph_store/index and its SQLite adapter's entry point`);
      }
      if (file.startsWith('service/') && target.startsWith('users/') && !/^users\/(?:index|sqlite\/index)$/.test(target)) {
        problems.push(`${file} imports ${specifier}: the service may use the users component only through users/index and users/sqlite/index`);
      }
      if (file.startsWith('service/') && target.startsWith('api/') && target !== 'api/index') {
        problems.push(`${file} imports ${specifier}: the service may use the API only through api/index`);
      }
      if (/^(?:graph_store|llm|app|sqlite|users|api)\//.test(file) && /^service(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: nothing may depend on the service`);
      }
      const apiTest = /\.test(?:-util)?\.ts$/.test(file);
      if (file.startsWith('api/') && /^(?:llm|app|sqlite)(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: the API must not depend on the LLM component, the application or the SQLite wrapper`);
      }
      if (file.startsWith('api/') && target.startsWith('graph_store/') && target !== 'graph_store/index' && !(apiTest && /^graph_store\/adapters\/(?:memory|sqlite)\/index$/.test(target))) {
        problems.push(`${file} imports ${specifier}: the API may use the graph store only through graph_store/index (its tests may also use the adapters)`);
      }
      if (file.startsWith('api/') && target.startsWith('users/') && !/^users\/index$/.test(target) && !(apiTest && /^users\/(?:sqlite\/index|testing\/index)$/.test(target))) {
        problems.push(`${file} imports ${specifier}: the API may use the users component only through users/index (its tests may also use the SQLite store)`);
      }
      if (/^(?:graph_store|llm|app|sqlite|users)\//.test(file) && /^api(?:\/|$)/.test(target)) {
        problems.push(`${file} imports ${specifier}: nothing may depend on the API`);
      }
      if (target.startsWith('sqlite/') && !(file.startsWith('sqlite/') || file.startsWith('graph_store/') || file.startsWith('users/'))) {
        problems.push(`${file} imports ${specifier}: only the graph store and the users component may use the shared SQLite driver wrapper`);
      }
      if (file.startsWith('sqlite/') && !target.startsWith('sqlite/')) {
        problems.push(`${file} imports ${specifier}: the shared SQLite driver wrapper must not depend on any other component`);
      }
      const own = /^llm\/capabilities\/([^/]+)\//.exec(file)?.[1];
      const other = /^llm\/capabilities\/([^/]+)(?:\/|$)/.exec(target)?.[1];
      if (own !== undefined && other !== undefined && other !== own) {
        problems.push(`${file} imports ${specifier}: a capability must not depend on another capability`);
      }
      if (file.startsWith('llm/') && !file.startsWith('llm/capabilities/') && !ASSEMBLY.includes(file) && target.startsWith('llm/capabilities/')) {
        problems.push(`${file} imports ${specifier}: the shared kernel must not depend on a capability (only the assembly files may)`);
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
        'llm/index.ts': `import { y } from './errors.js'; export { categorise } from './capabilities/categorise/index.js';`,
        'app/x.ts': `import { write } from '../graph_store/index.js'; import { createLlm } from '../llm/index.js'; import { y } from './y.js';`,
        'app/x.test.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js'; import { createScriptedModelClient } from '../llm/testing/index.js';`,
        'graph_store/adapters/sqlite/x.ts': `import { openDb } from '../../../sqlite/db.js';`,
        'users/x.ts': `import { openDb } from '../sqlite/db.js'; import { createGraph } from '../graph_store/index.js';`,
        'users/sqlite/y.test.ts': `import { createSqliteAdapter } from '../../graph_store/adapters/sqlite/index.js';`,
        'users/x.test.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';`,
        'api/x.ts': `import { newUserId } from '../users/index.js'; import { write } from '../graph_store/index.js'; import { y } from './y.js';`,
        'service/x.ts': `import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js'; import { createUserController } from '../users/index.js'; import { createSqliteUserStore } from '../users/sqlite/index.js'; import { createApiServer } from '../api/index.js'; import { ok } from '../graph_store/index.js'; import { y } from './y.js';`,
        'api/x.test.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js'; import { createSqliteUserStore } from '../users/sqlite/index.js'; import { runUserStoreConformance } from '../users/testing/index.js';`,
        'sqlite/y.ts': `import { z } from './x.js';`,
        'app/y.test.ts': `import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';`,
        'app/helper.test-util.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';`,
        'llm/create-llm.ts': `import { categorise } from './capabilities/categorise/index.js';`,
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
    ['the config importing a capability', { 'llm/config.ts': `import { categorise } from './capabilities/categorise/index.js';` }],
    ['the graph store importing the application', { 'graph_store/x.ts': `import { app } from '../app/index.js';` }],
    ['the application reaching into graph store internals', { 'app/x.ts': `import { parseMutation } from '../graph_store/parse.js';` }],
    ['the application reaching into the memory adapter\'s internals', { 'app/x.ts': `import { x } from '../graph_store/adapters/memory/memory-adapter.js';` }],
    ['production application code using the memory adapter', { 'app/x.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';` }],
    ['production application code using the SQLite adapter', { 'app/x.ts': `import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';` }],
    ['the application reaching into the SQLite adapter\'s internals', { 'app/x.test.ts': `import { openDb } from '../graph_store/adapters/sqlite/db.js';` }],
    ['the LLM component using the SQLite adapter', { 'llm/x.ts': `import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';` }],
    ['the users component reaching into the graph store\'s internals', { 'users/x.ts': `import { x } from '../graph_store/write-plan.js';` }],
    ['the API reaching into the users component\'s internals', { 'api/x.ts': `import { x } from '../users/controller.js';` }],
    ['the API using the LLM component', { 'api/x.ts': `import { createLlm } from '../llm/index.js';` }],
    ['the API using the application', { 'api/x.ts': `import { createController } from '../app/index.js';` }],
    ['the API reaching into the graph store\'s internals', { 'api/x.ts': `import { x } from '../graph_store/write-plan.js';` }],
    ['production API code using a graph store adapter', { 'api/x.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';` }],
    ['the users component using the API', { 'users/x.ts': `import { createApiServer } from '../api/index.js';` }],
    ['the graph store using the API', { 'graph_store/x.ts': `import { createApiServer } from '../api/index.js';` }],
    ['the service reaching into the users component\'s internals', { 'service/x.ts': `import { x } from '../users/controller.js';` }],
    ['the service using the SQLite wrapper directly', { 'service/x.ts': `import { openDb } from '../sqlite/db.js';` }],
    ['the service using the LLM component', { 'service/x.ts': `import { createLlm } from '../llm/index.js';` }],
    ['the service reaching into the API internals', { 'service/x.ts': `import { x } from '../api/server.js';` }],
    ['the service reaching into the graph store internals', { 'service/x.ts': `import { x } from '../graph_store/write-plan.js';` }],
    ['the API using the service', { 'api/x.ts': `import { serve } from '../service/index.js';` }],
    ['the users component using the service', { 'users/x.ts': `import { serve } from '../service/index.js';` }],
    ['production users code using the memory adapter', { 'users/x.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';` }],
    ['the users component using the LLM component', { 'users/x.ts': `import { createLlm } from '../llm/index.js';` }],
    ['the users component using the application', { 'users/x.ts': `import { createController } from '../app/index.js';` }],
    ['the graph store using the users component', { 'graph_store/x.ts': `import { newUserId } from '../users/index.js';` }],
    ['the application using the users component', { 'app/x.ts': `import { newUserId } from '../users/index.js';` }],
    ['the application using the shared SQLite wrapper', { 'app/x.ts': `import { openDb } from '../sqlite/db.js';` }],
    ['the LLM component using the shared SQLite wrapper', { 'llm/x.ts': `import { openDb } from '../sqlite/db.js';` }],
    ['the API using the shared SQLite wrapper', { 'api/x.ts': `import { openDb } from '../sqlite/db.js';` }],
    ['the shared SQLite wrapper depending on the graph store', { 'sqlite/x.ts': `import { write } from '../graph_store/index.js';` }],
    ['production application code using the scripted model client', { 'app/x.ts': `import { createScriptedModelClient } from '../llm/testing/index.js';` }],
    ['an application test using the LLM component\'s internals', { 'app/x.test.ts': `import { guardReply } from '../llm/capabilities/categorise/guard.js';` }],
    ['the application using the conformance suite', { 'app/x.ts': `import { runAdapterConformance } from '../graph_store/testing/index.js';` }],
    ['the LLM component using the memory adapter', { 'llm/x.ts': `import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';` }],
    ['the application reaching into the LLM component\'s internals', { 'app/x.ts': `import { guardReply } from '../llm/capabilities/categorise/guard.js';` }],
    ['the kernel importing a capability', { 'llm/model-client.ts': `import { categorise } from './capabilities/categorise/index.js';` }],
  ])('catches %s', (_name, files) => {
    expect(violations(files).length).toBeGreaterThan(0);
  });
});

describe('the real source tree', () => {
  it('keeps the components apart', () => {
    const files = { ...sourcesUnder(join(srcRoot, 'graph_store')), ...sourcesUnder(join(srcRoot, 'llm')), ...sourcesUnder(join(srcRoot, 'app')) };
    expect(Object.keys(files).some((f) => f.startsWith('graph_store/'))).toBe(true);
    expect(Object.keys(files).some((f) => f.startsWith('llm/'))).toBe(true);
    expect(Object.keys(files).some((f) => f.startsWith('app/'))).toBe(true);
    expect(violations(files)).toEqual([]);
  });
});

describe('the provider SDK', () => {
  // `@anthropic-ai/sdk` is an optional dependency used by one entry point. Nothing else may import it,
  // so the graph store, the rest of the LLM component and the application work without it.
  const imports = (source: string): boolean => /(?:from|import)\s*\(?\s*['"]@anthropic-ai\/sdk/.test(source);

  it('finds an SDK import (so the check below cannot pass by accident)', () => {
    expect(imports(`import Anthropic from '@anthropic-ai/sdk';`)).toBe(true);
    expect(imports(`import { RateLimitError } from "@anthropic-ai/sdk";`)).toBe(true);
    expect(imports(`const m = await import('@anthropic-ai/sdk/resources');`)).toBe(true);
    expect(imports(`import { x } from './sdk.js';`)).toBe(false);
  });

  it('is imported only inside llm/anthropic', () => {
    const files = { ...sourcesUnder(join(srcRoot, 'graph_store')), ...sourcesUnder(join(srcRoot, 'llm')), ...sourcesUnder(join(srcRoot, 'app')) };
    const offenders = Object.entries(files)
      .filter(([file]) => !file.startsWith('llm/anthropic/'))
      .filter(([file]) => file !== 'boundary.test.ts')
      .filter(([, source]) => imports(source))
      .map(([file]) => file);
    expect(Object.keys(files).some((f) => f.startsWith('llm/anthropic/'))).toBe(true);
    expect(offenders).toEqual([]);
  });

  it('is not reachable from the main LLM entry point', () => {
    const files = sourcesUnder(join(srcRoot, 'llm'));
    const reachable = (from: string, seen: Set<string> = new Set()): Set<string> => {
      if (seen.has(from)) return seen;
      seen.add(from);
      for (const specifier of importsOf(files[from] ?? '')) {
        const target = `${stripExtension(relative('/', resolve('/', dirname(from), specifier)))}.ts`;
        if (target in files) reachable(target, seen);
      }
      return seen;
    };
    const fromIndex = [...reachable('llm/index.ts')];
    expect(fromIndex.length).toBeGreaterThan(5);
    expect(fromIndex.filter((f) => f.startsWith('llm/anthropic/'))).toEqual([]);
  });
});

describe('no ambient input', () => {
  // Reading environment variables or files is the application's and the dev tools' job. The library
  // takes everything it needs as arguments, which keeps it pure and testable.
  const forbidden = [/process\.env/, /from ['"]node:fs/, /from ['"]fs['"]/, /readFileSync|readFile\(/, /process\.argv/];

  it('finds the patterns it forbids (so the check below cannot pass by accident)', () => {
    for (const bad of ['const k = process.env.X;', "import { readFileSync } from 'node:fs';", "import fs from 'fs';", 'process.argv[2]']) {
      expect(forbidden.some((pattern) => pattern.test(bad))).toBe(true);
    }
  });

  it.each(['llm', 'app'])('keeps the %s component free of environment and file access', (component) => {
    const files = sourcesUnder(join(srcRoot, component));
    const offenders = Object.entries(files)
      .filter(([file]) => !file.endsWith('.test.ts'))
      .filter(([, source]) => forbidden.some((pattern) => pattern.test(source)))
      .map(([file]) => file);
    expect(Object.keys(files).length).toBeGreaterThan(2);
    expect(offenders).toEqual([]);
  });
});
