// `npm run export-brain -- (--user USERNAME | --circle CIRCLE_ID) --out FILE [--data-dir DIR]`: writes one brain (facts, categories,
// links and the change log with the words typed) as JSON, from a consistent copy of the databases, while the service runs. Needs a
// built dist (a deploy builds it). Deliberately does not rebuild: a rebuild deletes dist.
import process from 'node:process';
import { exportBrainCommand } from '../dist/service/index.js';

const code = await exportBrainCommand(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exit(code);
