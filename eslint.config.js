import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // NFR-02: no module-level mutable state in library code.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test-util.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program > VariableDeclaration[kind!="const"]',
          message: 'Module-level let/var is mutable state (NFR-02). Use const and pass state in.',
        },
        {
          selector: 'Program > ExportNamedDeclaration > VariableDeclaration[kind!="const"]',
          message: 'Exported let/var is mutable state (NFR-02).',
        },
        ...['Program > VariableDeclaration', 'Program > ExportNamedDeclaration > VariableDeclaration'].flatMap((decl) => [
          {
            selector: `${decl} > VariableDeclarator[init.type="NewExpression"][init.callee.name=/^(Map|Set|WeakMap|WeakSet|Array)$/]`,
            message: 'Module-level Map/Set/Array is shared mutable state (NFR-02). Create it inside a function.',
          },
          {
            selector: `${decl} > VariableDeclarator[init.type="ArrayExpression"]`,
            message: 'Module-level array literal is mutable (NFR-02). Use `as const` or create it inside a function.',
          },
        ]),
      ],
    },
  },
  {
    // Local development tooling (never published): the explorer's Node server and its tests.
    files: ['dev/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', structuredClone: 'readonly', AbortController: 'readonly' },
    },
  },
  {
    // The explorer's browser code.
    files: ['dev/**/public/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        document: 'readonly', window: 'readonly', fetch: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly', console: 'readonly', process: 'readonly', AbortSignal: 'readonly' } },
  },
);
