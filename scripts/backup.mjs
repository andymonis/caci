// `npm run backup -- --dest DIR [--keep N]`: snapshots graphs.db and users.db from CACI_DATA_DIR while the service
// runs. Needs a built dist (a deploy builds it). Deliberately does not rebuild: a rebuild deletes dist.
import process from 'node:process';
import { backupData } from '../dist/service/index.js';

const code = backupData(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exit(code);
