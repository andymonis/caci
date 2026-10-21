import { closeSync, existsSync, fchmodSync, lstatSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirOf, isInside } from './backup.js';
import { exportBrain, type ExportTarget } from './brain-export.js';

// `npm run export-brain -- --user <username> | --circle <id> --out FILE [--data-dir DIR]` (R-017 D11, D12): writes one brain as
// a JSON document. Like backup and restore it reads the data folder directly and does not rebuild. The file holds real notes, so
// it is created owner-only (0600), an existing file is never overwritten, a folder is never created, a path inside the
// application's own folder is refused (so it cannot be committed by accident), and note text is never printed.

export interface ExportCommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => number;
}

export const EXPORT_USAGE = 'Usage: npm run export-brain -- (--user USERNAME | --circle CIRCLE_ID) --out FILE [--data-dir DIR]   (FILE is a new file in an existing folder outside the project; DIR defaults to CACI_DATA_DIR or ./data)';
const CIRCLE_ID = /^c[a-z0-9]{16}$/;
type Env = Readonly<Record<string, string | undefined>>;

interface Parsed {
  readonly target: ExportTarget;
  readonly out: string;
  readonly dataDir?: string;
}

function parse(args: readonly string[]): Parsed | string {
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!['--user', '--circle', '--out', '--data-dir'].includes(flag)) return `unknown argument "${flag.slice(0, 40)}"`;
    if (seen.has(flag)) return `${flag} was given twice`;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value === '') return `${flag} needs a value`;
    seen.set(flag, value);
    i++;
  }
  const user = seen.get('--user');
  const circle = seen.get('--circle');
  const out = seen.get('--out');
  if ((user === undefined) === (circle === undefined)) return 'give exactly one of --user and --circle';
  if (out === undefined) return '--out is required';
  // eslint-disable-next-line no-control-regex
  if (user !== undefined && (user.length > 64 || /[\u0000-\u001f\u007f]/.test(user))) return '--user is not a username';
  if (circle !== undefined && !CIRCLE_ID.test(circle)) return '--circle is not a circle id';
  if (out.includes('\0')) return '--out is not a path';
  const dataDir = seen.get('--data-dir');
  return { target: user !== undefined ? { kind: 'user', username: user } : { kind: 'circle', circleId: circle as string }, out: resolve(out), ...(dataDir === undefined ? {} : { dataDir: resolve(dataDir) }) };
}

/** The application's own folder (two levels above `src/service` and `dist/service`). */
const projectDir = (): string => fileURLToPath(new URL('../../', import.meta.url));

export async function exportBrainCommand(args: readonly string[], env: Env, io: ExportCommandIo): Promise<0 | 1 | 2> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n${EXPORT_USAGE}\n`);
    return 2;
  }
  const { out } = parsed;
  const dataDir = parsed.dataDir ?? dataDirOf(env);
  if (existsSync(out) || lstatExists(out)) {
    io.stderr('That file already exists; an export never overwrites anything. Choose a new file name.\n');
    return 1;
  }
  if (!existsSync(dirname(out))) {
    io.stderr('The folder for that file does not exist; an export never creates one.\n');
    return 1;
  }
  if (isInside(out, projectDir())) {
    io.stderr('That path is inside the project folder, where the notes could be committed by accident. Choose a place outside it.\n');
    return 1;
  }
  if (isInside(out, dataDir)) {
    io.stderr('That path is inside the data folder. Choose a place outside it.\n');
    return 1;
  }

  const r = await exportBrain({ dataDir, target: parsed.target, ...(io.now === undefined ? {} : { now: io.now }) });
  if (!r.ok) {
    io.stderr(`${r.message}.\n`);
    return 1;
  }
  let fd: number | undefined;
  try {
    fd = openSync(out, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(r.value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(out, { force: true });
    io.stderr('The file could not be written (nothing was kept).\n');
    return 1;
  }
  const c = r.value.counts;
  io.stdout(`Exported the ${r.value.brain.kind === 'personal' ? 'brain of' : 'circle'} "${r.value.brain.name}": ${c.facts} facts, ${c.categories} categories, ${c.links} links, ${c.entries} change-log entries (${c.inputs} with the words typed).\n`);
  io.stdout(`Written to ${out}, readable only by you.\n`);
  io.stdout('This file holds real notes: keep it out of the repository and off shared machines.\n');
  return 0;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
