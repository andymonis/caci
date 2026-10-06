import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // src/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

/** Every module that lets a program listen on, or talk over, a network. */
const NETWORK = /(?:from|import)\s*\(?\s*['"]node:(?:http|https|http2|net|tls|dgram|dns|cluster|worker_threads|child_process)['"]/;

const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

describe('only the API touches the network', () => {
  it('no source outside src/api imports a network or process module (tests that spawn child processes aside)', () => {
    const offenders = sources(root)
      .filter((file) => !relative(root, file).startsWith('api/'))
      .filter((file) => !file.endsWith('.test.ts')) // tests may start child processes to prove crash behaviour; the library may not
      .filter((file) => NETWORK.test(code(file)))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('the scan sees the API server (so it cannot pass by looking at nothing)', () => {
    expect(NETWORK.test(code(join(root, 'api', 'server.ts')))).toBe(true);
  });

  it('the scan recognises each way of importing', () => {
    for (const text of ["import { createServer } from 'node:http';", 'const net = await import("node:net");', "import { spawn } from 'node:child_process';", "import https from 'node:https'"]) expect(NETWORK.test(text), text).toBe(true);
    for (const text of ["import { join } from 'node:path';", "// import http from 'node:http'", "import { readFile } from 'node:fs/promises';"]) expect(NETWORK.test(code2(text)), text).toBe(false);
  });
});

/** Same comment stripping as `code`, for a string. */
const code2 = (text: string): string => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
