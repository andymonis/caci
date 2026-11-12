import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '../usage/index.js';
import { createSqliteUsageStore } from '../usage/sqlite/index.js';
import { createSqliteUserStore } from '../users/sqlite/index.js';
import { DEFAULT_PRICES_FILE, usageCommand, USAGE_USAGE } from './usage-command.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const HAIKU = 'claude-haiku-4-5-20251001';
const PRICES = { asOf: '2026-11-12', currency: 'USD', note: 'test', models: { [HAIKU]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, demo: { input: 0, output: 0 } } };
const NOV = Date.UTC(2026, 10, 15, 12);
const DEC = Date.UTC(2026, 11, 2, 12);

const rec = (extra: Partial<UsageRecord> = {}): UsageRecord => ({ at: NOV, userId: U1, capability: 'categorise', scope: { kind: 'personal' }, model: HAIKU, attempt: 1, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, result: 'ok', latencyMs: 700, ...extra });

async function setup(records: UsageRecord[] = [rec(), rec({ at: NOV + 1, attempt: 2, result: 'ok' }), rec({ userId: U2, capability: 'status', scope: { kind: 'circle', circleId: C1 }, inputTokens: 500_000, outputTokens: 50_000 }), rec({ at: DEC, userId: U2, model: 'demo' })]) {
  const root = mkdtempSync(join(tmpdir(), 'caci-usage-cmd-'));
  dirs.push(root);
  const data = join(root, 'data');
  mkdirSync(data);
  const out = join(root, 'out');
  mkdirSync(out);
  const prices = join(root, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES));
  const file = join(data, 'users.db');
  const users = createSqliteUserStore({ path: file });
  for (const [id, name] of [[U1, 'ann'], [U2, 'bob']] as const) await users.create({ id, username: name, displayName: name, role: 'user', passwordHash: 'h', createdAt: 1 });
  const usage = createSqliteUsageStore({ path: file });
  expect((await usage.append(records)).ok).toBe(true);
  return { root, data, out, prices, file, users, usage, close: () => (users.close(), usage.close()) };
}
async function run(args: string[], env: Record<string, string> = {}, now = Date.UTC(2026, 10, 20)) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await usageCommand(args, env, { stdout: (t) => void stdout.push(t), stderr: (t) => void stderr.push(t), now: () => now });
  return { code, out: stdout.join(''), err: stderr.join('') };
}

describe('the usage command: arguments', () => {
  it.each([
    [['--nope', 'x'], 'unknown argument'],
    [['--by', 'user', '--by', 'model'], 'given twice'],
    [['--month'], 'needs a value'],
    [['--month', '--by'], 'needs a value'],
    [['--by', 'planet'], '--by must be one of'],
    [['--month', '2026-13'], '--month must look like'],
    [['--month', '2026-1'], '--month must look like'],
    [['--month', '2026-11', '--from', '2026-11-01', '--to', '2026-11-30'], 'not both'],
    [['--from', '2026-11-01'], 'go together'],
    [['--to', '2026-11-01'], 'go together'],
    [['--from', '2026-02-30', '--to', '2026-03-01'], 'real dates'],
    [['--from', '2026-11-05', '--to', '2026-11-01'], 'before'],
    [['--top', '0'], '--top must be'],
    [['--top', '1000'], '--top must be'],
    [['--invoice', '-3'], '--invoice must be'],
    [['--invoice', '1,5'], '--invoice must be'],
    [['--csv', 'a\0b'], 'not a path'],
  ])('%j is refused with exit 2 and the usage', async (args, part) => {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(part);
    expect(r.err).toContain(USAGE_USAGE);
    expect(r.out).toBe('');
  });
});

describe('the usage command: reading the records', () => {
  it('reports this month by user, with usernames and exact figures, and leaves the folder as it was', async () => {
    const s = await setup();
    s.close();
    const before = readdirSync(s.data).sort();
    const r = await run(['--prices', s.prices, '--data-dir', s.data], {}, Date.UTC(2026, 10, 20));
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('Usage report by user, 2026-11');
    expect(r.out).toMatch(/ann\s+1\s+2\s+2,000,000\s+200,000/);
    expect(r.out).toMatch(/bob\s+1\s+1\s+500,000\s+50,000/);
    expect(r.out).toContain('Estimated cost in USD');
    // ann: 2M input at 1 and 200k output at 5 is 3.0; bob: 0.5 + 0.25 is 0.75; together 3.75
    expect(r.out).toMatch(/ann.*3\.0000/);
    expect(r.out).toMatch(/bob.*0\.7500/);
    expect(r.out).toMatch(/total.*3\.7500/);
    expect(readdirSync(s.data).sort()).toEqual(before);
  });

  it('--month picks that month only, and the default is the month of the clock', async () => {
    const s = await setup();
    s.close();
    const dec = await run(['--month', '2026-12', '--prices', s.prices, '--data-dir', s.data]);
    expect(dec.out).toContain('Usage report by user, 2026-12');
    expect(dec.out).toMatch(/bob\s+1\s+1/);
    expect(dec.out).not.toContain('ann');
    const defaultDec = await run(['--prices', s.prices, '--data-dir', s.data], {}, Date.UTC(2026, 11, 31, 23, 59));
    expect(defaultDec.out).toContain('2026-12');
    expect(defaultDec.out).not.toContain('ann'); // only December's records
    const empty = await run(['--month', '2027-01', '--prices', s.prices, '--data-dir', s.data]);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('no calls in this period');
  });

  it('--from and --to include the whole of the last day, and a month boundary is exact', async () => {
    const s = await setup([rec({ at: Date.UTC(2026, 10, 30, 23, 59, 59, 999) }), rec({ at: Date.UTC(2026, 11, 1) }), rec({ at: Date.UTC(2026, 10, 1) - 1 })]);
    s.close();
    const nov = await run(['--from', '2026-11-01', '--to', '2026-11-30', '--prices', s.prices, '--data-dir', s.data]);
    expect(nov.out).toContain('2026-11-01 to 2026-11-30');
    expect(nov.out).toMatch(/ann\s+1\s+1/);
    const both = await run(['--from', '2026-11-30', '--to', '2026-12-01', '--prices', s.prices, '--data-dir', s.data]);
    expect(both.out).toMatch(/ann\s+2\s+2/);
    const month = await run(['--month', '2026-11', '--prices', s.prices, '--data-dir', s.data]);
    expect(month.out).toMatch(/ann\s+1\s+1/);
  });

  it('--by groups by call type, model, circle, day or month', async () => {
    const s = await setup();
    s.close();
    const by = async (what: string) => (await run(['--by', what, '--month', '2026-11', '--prices', s.prices, '--data-dir', s.data])).out;
    expect(await by('capability')).toMatch(/categorise\s+1\s+2/);
    expect(await by('model')).toContain(HAIKU);
    expect(await by('circle')).toContain(C1);
    expect(await by('day')).toContain('2026-11-15');
    expect(await by('month')).toMatch(/2026-11\s+2\s+3/);
  });

  it('an account that is gone shows as a deleted account, its totals kept', async () => {
    const s = await setup();
    expect((await s.users.delete(U1)).ok).toBe(true);
    s.close();
    const r = await run(['--month', '2026-11', '--prices', s.prices, '--data-dir', s.data]);
    expect(r.out).toMatch(/deleted account\s+1\s+2\s+2,000,000/);
    expect(r.out).not.toContain('ann');
    expect(r.out).toContain('deleted accounts:');
  });

  it('prints the invoice difference when asked', async () => {
    const s = await setup();
    s.close();
    const r = await run(['--month', '2026-11', '--invoice', '3', '--prices', s.prices, '--data-dir', s.data]);
    expect(r.out).toContain('Invoice: you gave 3.0000 USD; the estimate is 3.7500; the difference is +0.7500 (+25.0%).');
  });

  it('works while the service holds the database open, and does not change a record', async () => {
    const s = await setup();
    const r = await run(['--month', '2026-11', '--prices', s.prices, '--data-dir', s.data]);
    expect(r.code).toBe(0);
    expect((await s.usage.aggregate({ from: 0, to: Date.UTC(2100, 0, 1) })).reduce((n, a) => n + a.attempts, 0)).toBe(4);
    s.close();
  });

  it('reads CACI_DATA_DIR when no folder is given, and says where it looked when there is no database, creating nothing', async () => {
    const s = await setup();
    s.close();
    const viaEnv = await run(['--month', '2026-11', '--prices', s.prices], { CACI_DATA_DIR: s.data });
    expect(viaEnv.code).toBe(0);
    const empty = join(s.root, 'nothing-here');
    mkdirSync(empty);
    const none = await run(['--prices', s.prices, '--data-dir', empty]);
    expect(none.code).toBe(1);
    expect(none.err).toContain(join(empty, 'users.db'));
    expect(readdirSync(empty)).toEqual([]);
  });

  it('the price table in the repository is the default, and it prices the demo and the cheap model', async () => {
    expect(existsSync(DEFAULT_PRICES_FILE)).toBe(true);
    const s = await setup();
    s.close();
    const r = await run(['--month', '2026-11', '--by', 'model', '--data-dir', s.data]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('prices as of 2026-11-12');
    expect(r.out).not.toContain('Models with no price');
  });

  it('a model with no price is listed as unpriced and its cost is not counted', async () => {
    const s = await setup([rec({ model: 'mystery-model' })]);
    s.close();
    const r = await run(['--month', '2026-11', '--prices', s.prices, '--data-dir', s.data]);
    expect(r.out).toContain('Models with no price');
    expect(r.out).toContain('mystery-model: 1 attempts');
    expect(r.out).toContain('0.0000*');
  });

  it('a price table that is missing, not JSON or not valid is exit 1 with the problems, and nothing is printed as a report', async () => {
    const s = await setup();
    s.close();
    const missing = await run(['--prices', join(s.root, 'nope.json'), '--data-dir', s.data]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('could not be read as JSON');
    writeFileSync(s.prices, '{ not json');
    expect((await run(['--prices', s.prices, '--data-dir', s.data])).err).toContain('could not be read as JSON');
    writeFileSync(s.prices, JSON.stringify({ asOf: 'x', currency: 'USD', note: '', models: {}, extra: 1 }));
    const bad = await run(['--prices', s.prices, '--data-dir', s.data]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('asOf must be a real date');
    expect(bad.err).toContain('no field "extra"');
    expect(bad.out).toBe('');
  });

  it('a database that is not a user database is refused with a plain message', async () => {
    const s = await setup();
    s.close();
    writeFileSync(s.file, 'this is not a database');
    const r = await run(['--prices', s.prices, '--data-dir', s.data]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not be read');
    expect(r.err).not.toMatch(/SQLITE|at .*\.ts/);
  });
});

describe('the usage command: the CSV file', () => {
  it('writes a new owner-only file with the groups and a total, and says so', async () => {
    const s = await setup();
    s.close();
    const csv = join(s.out, 'november.csv');
    const r = await run(['--month', '2026-11', '--csv', csv, '--prices', s.prices, '--data-dir', s.data]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`CSV written to ${csv}`);
    const lines = readFileSync(csv, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toBe('user,calls,attempts,rejected,failed,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,latencyMs,costUSD,unpricedAttempts');
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[1]).toMatch(/^ann,1,2,0,0,2000000,200000,0,0,1400,3\.000000,0$/);
    expect(lines.at(-1)).toMatch(/^total,2,3,0,0,2500000,250000,0,0,2100,3\.750000,0$/);
    if (process.platform !== 'win32') expect(statSync(csv).mode & 0o777).toBe(0o600);
  });

  it('never overwrites, never creates a folder, and refuses a place inside the project or the data folder', async () => {
    const s = await setup();
    s.close();
    const csv = join(s.out, 'x.csv');
    writeFileSync(csv, 'keep me');
    const exists = await run(['--csv', csv, '--prices', s.prices, '--data-dir', s.data]);
    expect(exists.code).toBe(1);
    expect(exists.err).toContain('already exists');
    expect(readFileSync(csv, 'utf8')).toBe('keep me');
    const noFolder = await run(['--csv', join(s.out, 'missing', 'x.csv'), '--prices', s.prices, '--data-dir', s.data]);
    expect(noFolder.code).toBe(1);
    expect(noFolder.err).toContain('does not exist');
    expect(existsSync(join(s.out, 'missing'))).toBe(false);
    const inData = await run(['--csv', join(s.data, 'x.csv'), '--prices', s.prices, '--data-dir', s.data]);
    expect(inData.code).toBe(1);
    expect(inData.err).toContain('inside the data folder');
    expect(existsSync(join(s.data, 'x.csv'))).toBe(false);
    const inProject = await run(['--csv', join(process.cwd(), 'usage-test-should-not-exist.csv'), '--prices', s.prices, '--data-dir', s.data]);
    expect(inProject.code).toBe(1);
    expect(inProject.err).toContain('inside the project folder');
    expect(existsSync(join(process.cwd(), 'usage-test-should-not-exist.csv'))).toBe(false);
    expect(exists.out + noFolder.out + inData.out + inProject.out).toBe(''); // a refusal prints no report
  });
});
