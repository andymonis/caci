import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner } from './exec.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const run = createRunner();
const node = (code, options) => run(process.execPath, ['-e', code], options);

describe('running a program', () => {
  it('reports success with the output', async () => {
    const r = await node("process.stdout.write('hello'); process.stderr.write('warn')");
    expect(r).toMatchObject({ ok: true, code: 0, stdout: 'hello', stderr: 'warn', detail: 'hello' });
  });
  it('reports a non-zero exit with the code and the error text', async () => {
    const r = await node("process.stderr.write('it broke'); process.exit(3)");
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.detail).toContain('exited with 3');
    expect(r.detail).toContain('it broke');
  });
  it('reports a program that does not exist, without throwing', async () => {
    const r = await run('/definitely/not/here', []);
    expect(r).toMatchObject({ ok: false, code: null });
    expect(r.detail).toContain('could not be run');
  });
  it('stops a program that runs too long', async () => {
    const started = Date.now();
    const r = await node('setInterval(() => {}, 1000)', { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('was stopped after');
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it('passes arguments literally: nothing goes through a shell', async () => {
    const d = mkdtempSync(join(tmpdir(), 'caci-exec-'));
    dirs.push(d);
    const marker = join(d, 'pwned');
    const r = await run(process.execPath, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', `; touch ${marker}`, '$(touch x)', '`id`', '--flag=a b']);
    expect(r.stdout).toBe(`; touch ${marker}|$(touch x)|\`id\`|--flag=a b`);
    expect(() => readFileSync(marker)).toThrow();
  });
  it('runs in the folder it is given, with only the environment it is given', async () => {
    const d = mkdtempSync(join(tmpdir(), 'caci-exec-'));
    dirs.push(d);
    writeFileSync(join(d, 'probe.mjs'), "process.stdout.write(JSON.stringify([process.cwd(), process.env.ONLY, process.env.HOME ?? null]))");
    const r = await run(process.execPath, ['probe.mjs'], { cwd: d, env: { ONLY: 'yes', PATH: process.env.PATH } });
    const [cwd, only, home] = JSON.parse(r.stdout);
    expect(cwd.endsWith(d.split('/').pop())).toBe(true);
    expect(only).toBe('yes');
    expect(home).toBe(null);
  });
  it('keeps only the end of very long output as the detail', async () => {
    const r = await node("process.stdout.write('x'.repeat(10000) + 'END')");
    expect(r.detail.length).toBeLessThan(2100);
    expect(r.detail.endsWith('END')).toBe(true);
    expect(r.stdout.length).toBe(10003);
  });
  it('a launcher that throws is a failure, not a crash', async () => {
    const r = await createRunner({ execFileFn: () => { throw new Error('boom'); } })('x', []);
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain('boom');
  });
  it('an executable script runs by path', async () => {
    const d = mkdtempSync(join(tmpdir(), 'caci-exec-'));
    dirs.push(d);
    const script = join(d, 'hi.sh');
    writeFileSync(script, '#!/bin/sh\necho "hi $1"\n');
    chmodSync(script, 0o755);
    expect((await run(script, ['there'])).stdout).toBe('hi there\n');
  });
});
