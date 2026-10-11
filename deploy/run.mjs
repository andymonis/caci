// `sudo node deploy/run.mjs [ref]`: updates the service on the Pi (R-010). Run as root; git and npm run as the service
// account. The sequence and the exit codes are in deploy.mjs: 0 deployed, 10 failed and rolled back, 11 failed and
// the rollback failed, 12 refused before anything changed.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runDeploy, validateRef } from './deploy.mjs';
import { parseEnvFile } from './envfile.mjs';
import { createRunner } from './exec.mjs';
import { createHost } from './host.mjs';
import { LAYOUT } from './layout.mjs';

export const USAGE = `Usage: sudo node deploy/run.mjs [ref]   (a branch, tag or commit; default ${LAYOUT.defaultRef})`;

/**
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { stdout, stderr, layout = LAYOUT, run = createRunner(), isRoot = process.getuid?.() === 0, readFile = (path) => readFileSync(path, 'utf8'), hostOptions = {} } = {}) {
  if (argv.length > 1) {
    stderr(`${USAGE}\n`);
    return 12;
  }
  const ref = argv[0] ?? layout.defaultRef;
  const problem = validateRef(ref);
  if (problem !== undefined) {
    stderr(`Refused: ${problem}.\n${USAGE}\n`);
    return 12;
  }
  if (!isRoot) {
    stderr(`Refused: run this as root (sudo node deploy/run.mjs), so it can restart the service and act as ${layout.user}.\n`);
    return 12;
  }
  let settings;
  try {
    settings = parseEnvFile(readFile(layout.envFile));
  } catch {
    stderr(`Refused: cannot read ${layout.envFile}. Has the install script been run?\n`);
    return 12;
  }
  const secrets = Object.entries(settings).filter(([k]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k)).map(([, v]) => v);
  const host = createHost({ run, layout, settings, ...hostOptions });
  const result = await runDeploy({ ref, host, log: (line) => stdout(`${line}\n`), secrets });
  return result.code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }));
}
