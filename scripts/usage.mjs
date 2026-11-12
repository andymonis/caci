// `npm run usage -- [--month YYYY-MM] [--by user|capability|model|circle|day|month] [--csv FILE] [--invoice AMOUNT]`: what each
// account's model calls cost, estimated from the usage records in users.db while the service runs. Needs a built dist (a deploy
// builds it). Deliberately does not rebuild: a rebuild deletes dist.
import process from 'node:process';
import { usageCommand } from '../dist/service/index.js';

const code = await usageCommand(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exit(code);
