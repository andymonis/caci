// `npm run bench:sqlite`: build the NFR-05 graph and time it. Everything is passed in (see run.mjs).
import { SIZES } from './dataset.mjs';
import { runBench } from './bench.mjs';
import { formatReport, overTarget } from './report.mjs';

export const USAGE = `Usage: npm run bench:sqlite -- [options]
  --size full|smoke     full = 10,000 items, 1,000 categories, 100,000 edges (default); smoke = tiny, checks the plumbing
  --adapters a,b        sqlite, memory (default: sqlite,memory; memory is only a reference)
  --samples N           samples per operation (default 30)
  --seed N              seed of the generated graph (default 1)
  --no-save             do not write a results file
  --help`;

export function parseArgs(argv) {
  const out = { size: 'full', adapters: ['sqlite', 'memory'], samples: 30, seed: 1, save: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help') out.help = true;
    else if (a === '--no-save') out.save = false;
    else if (a === '--size') {
      out.size = value();
      if (!(out.size in SIZES)) throw new Error(`--size must be full or smoke, not "${out.size}"`);
    } else if (a === '--adapters') {
      out.adapters = value().split(',');
      for (const name of out.adapters) if (name !== 'sqlite' && name !== 'memory') throw new Error(`unknown adapter "${name}": use sqlite or memory`);
    } else if (a === '--samples' || a === '--seed') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < (a === '--samples' ? 1 : 0)) throw new Error(`${a} must be a whole number${a === '--samples' ? ' of at least 1' : ''}`);
      out[a.slice(2)] = n;
    } else throw new Error(`unknown option ${a}`);
  }
  return out;
}

/** @returns the exit code */
export async function main(io) {
  let args;
  try {
    args = parseArgs(io.argv);
  } catch (error) {
    io.stderr(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const runs = [];
  for (const name of args.adapters) {
    io.stdout(`${name}\n`);
    runs.push(await runBench({ lib: io.lib, makeAdapter: () => io.makeAdapter(name), size: SIZES[args.size], seed: args.seed, samples: args.samples, now: io.now, progress: io.stdout }));
  }
  io.stdout(`\n${formatReport(runs, { nodeVersion: io.nodeVersion })}\n`);
  const over = overTarget(runs.filter((r) => r.adapter !== 'memory'));
  if (over.length > 0) io.stdout(`\nOver target (record each as a Backlog item with its number):\n${over.map((l) => `  ${l}`).join('\n')}\n`);
  if (args.save) io.stdout(`\nSaved ${await io.save({ when: io.stamp?.(), nodeVersion: io.nodeVersion, args, runs })}\n`);
  return 0;
}
