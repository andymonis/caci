// `npm run restore -- <snapshot folder> --yes`: puts a snapshot back into CACI_DATA_DIR. Stop the service first.
// Needs a built dist; does not rebuild.
import process from 'node:process';
import { restoreData } from '../dist/service/index.js';

const code = restoreData(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exit(code);
