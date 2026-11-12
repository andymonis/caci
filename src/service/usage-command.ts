import { closeSync, existsSync, fchmodSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, GROUP_BYS, invoiceDifference, parsePrices, renderReport, reportCsv, type GroupBy, type PriceTable } from '../usage/index.js';
import { createSqliteUsageStore } from '../usage/sqlite/index.js';
import { createSqliteUserStore } from '../users/sqlite/index.js';
import { dataDirOf, isInside } from './backup.js';

// `npm run usage -- [--month YYYY-MM | --from YYYY-MM-DD --to YYYY-MM-DD] [--by ...] [--csv FILE] [--invoice AMOUNT]` (R-024 D3):
// what the model calls cost, from the records in `users.db`. Like backup and export it reads the data folder directly, does not
// rebuild, and works while the service runs. Records hold no text. A CSV file is created owner-only and never overwrites anything.

export interface UsageCommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => number;
}

export const USAGE_USAGE = `Usage: npm run usage -- [--month YYYY-MM | --from YYYY-MM-DD --to YYYY-MM-DD] [--by ${GROUP_BYS.join('|')}] [--top N] [--csv FILE] [--invoice AMOUNT] [--prices FILE] [--data-dir DIR]   (default: this month, by user; --to is included; FILE is a new file in an existing folder outside the project; DIR defaults to CACI_DATA_DIR or ./data)`;

const DAY = 86_400_000;
type Env = Readonly<Record<string, string | undefined>>;

interface Parsed {
  readonly from: number;
  readonly to: number;
  readonly period: string;
  readonly by: GroupBy;
  readonly top: number;
  readonly csv?: string;
  readonly invoice?: number;
  readonly prices?: string;
  readonly dataDir?: string;
}

const realDay = (text: string): number | undefined => {
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text ? undefined : at;
};

function parse(args: readonly string[], now: number): Parsed | string {
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!['--month', '--from', '--to', '--by', '--top', '--csv', '--invoice', '--prices', '--data-dir'].includes(flag)) return `unknown argument "${flag.slice(0, 40)}"`;
    if (seen.has(flag)) return `${flag} was given twice`;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value === '') return `${flag} needs a value`;
    seen.set(flag, value);
    i++;
  }
  const by = (seen.get('--by') ?? 'user') as GroupBy;
  if (!(GROUP_BYS as readonly string[]).includes(by)) return `--by must be one of ${GROUP_BYS.join(', ')}`;
  const topText = seen.get('--top');
  if (topText !== undefined && !/^[1-9]\d{0,2}$/.test(topText)) return '--top must be a whole number from 1 to 999';
  const invoiceText = seen.get('--invoice');
  if (invoiceText !== undefined && !/^\d{1,9}(\.\d{1,6})?$/.test(invoiceText)) return '--invoice must be an amount such as 12.34';
  for (const flag of ['--csv', '--prices', '--data-dir']) if (seen.get(flag)?.includes('\0')) return `${flag} is not a path`;
  let from: number;
  let to: number;
  let period: string;
  const month = seen.get('--month');
  if (month !== undefined) {
    if (seen.has('--from') || seen.has('--to')) return 'give --month or --from and --to, not both';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return '--month must look like 2026-11';
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    from = Date.UTC(y, m - 1, 1);
    to = Date.UTC(y, m, 1);
    period = month;
  } else if (seen.has('--from') || seen.has('--to')) {
    const a = seen.get('--from');
    const b = seen.get('--to');
    if (a === undefined || b === undefined) return '--from and --to go together';
    const start = realDay(a);
    const end = realDay(b);
    if (start === undefined || end === undefined) return '--from and --to must be real dates written YYYY-MM-DD';
    if (end < start) return '--to is before --from';
    from = start;
    to = end + DAY;
    period = `${a} to ${b}`;
  } else {
    const d = new Date(now);
    from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const csv = seen.get('--csv');
  const prices = seen.get('--prices');
  const dataDir = seen.get('--data-dir');
  return { from, to, period, by, top: topText === undefined ? 10 : Number(topText), ...(csv === undefined ? {} : { csv: resolve(csv) }), ...(invoiceText === undefined ? {} : { invoice: Number(invoiceText) }), ...(prices === undefined ? {} : { prices: resolve(prices) }), ...(dataDir === undefined ? {} : { dataDir: resolve(dataDir) }) };
}

/** The application's own folder (two levels above `src/service` and `dist/service`). */
const projectDir = (): string => fileURLToPath(new URL('../../', import.meta.url));
/** Where the price table is kept unless `--prices` says otherwise. */
export const DEFAULT_PRICES_FILE = join(projectDir(), 'usage-prices.json');

function loadPrices(path: string): { ok: true; value: PriceTable } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, message: `The price table ${path} could not be read as JSON.` };
  }
  const parsed = parsePrices(json);
  return parsed.ok ? parsed : { ok: false, message: `The price table ${path} is not valid:\n${parsed.problems.map((p) => `  ${p}`).join('\n')}` };
}

const exists = (path: string): boolean => {
  if (existsSync(path)) return true;
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** @returns 0 done, 1 could not, 2 wrong arguments */
export async function usageCommand(args: readonly string[], env: Env, io: UsageCommandIo): Promise<0 | 1 | 2> {
  const now = (io.now ?? Date.now)();
  const parsed = parse(args, now);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n${USAGE_USAGE}\n`);
    return 2;
  }
  const dataDir = parsed.dataDir ?? dataDirOf(env);
  const file = join(dataDir, 'users.db');
  if (parsed.csv !== undefined) {
    if (exists(parsed.csv)) {
      io.stderr('That file already exists; a report never overwrites anything. Choose a new file name.\n');
      return 1;
    }
    if (!existsSync(dirname(parsed.csv))) {
      io.stderr('The folder for that file does not exist; a report never creates one.\n');
      return 1;
    }
    if (isInside(parsed.csv, projectDir())) {
      io.stderr('That path is inside the project folder, where it could be committed by accident. Choose a place outside it.\n');
      return 1;
    }
    if (isInside(parsed.csv, dataDir)) {
      io.stderr('That path is inside the data folder. Choose a place outside it.\n');
      return 1;
    }
  }
  if (!existsSync(file)) {
    io.stderr(`There is no user database at ${file}. Check CACI_DATA_DIR.\n`);
    return 1;
  }
  const prices = loadPrices(parsed.prices ?? DEFAULT_PRICES_FILE);
  if (!prices.ok) {
    io.stderr(`${prices.message}\n`);
    return 1;
  }

  let usage: ReturnType<typeof createSqliteUsageStore> | undefined;
  let users: ReturnType<typeof createSqliteUserStore> | undefined;
  try {
    usage = createSqliteUsageStore({ path: file });
    users = createSqliteUserStore({ path: file });
    const rows = await usage.aggregate({ from: parsed.from, to: parsed.to });
    const names = new Map<string, string>();
    for (const id of new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])))) {
      const user = await users.get(id);
      if (user !== undefined) names.set(id, user.username);
    }
    const report = buildReport(rows, prices.value, { by: parsed.by, top: parsed.top, label: (id) => names.get(id) });
    io.stdout(renderReport(report, { period: parsed.period, ...(parsed.invoice === undefined ? {} : { invoice: invoiceDifference(report.totals.cost, parsed.invoice) }) }));
    if (parsed.csv !== undefined) {
      let fd: number | undefined;
      try {
        fd = openSync(parsed.csv, 'wx', 0o600);
        fchmodSync(fd, 0o600);
        writeSync(fd, reportCsv(report));
        closeSync(fd);
        fd = undefined;
      } catch {
        if (fd !== undefined) closeSync(fd);
        rmSync(parsed.csv, { force: true });
        io.stderr('The CSV file could not be written (nothing was kept).\n');
        return 1;
      }
      io.stdout(`CSV written to ${parsed.csv}, readable only by you.\n`);
    }
    return 0;
  } catch {
    io.stderr('The usage records could not be read (is another program holding the database?).\n');
    return 1;
  } finally {
    usage?.close();
    users?.close();
  }
}
