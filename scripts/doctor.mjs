// `npm run doctor`: checks the Raspberry Pi service and prints one line per check (R-010). Run it from the
// application folder as the service account or with sudo. It never prints the Anthropic key. Needs a built dist.
import process from 'node:process';
import { runDoctor } from '../deploy/doctor.mjs';
import { createProbes } from '../deploy/doctor-host.mjs';
import { createRunner } from '../deploy/exec.mjs';
import { loadControlsFolder, loadCheckTexts, parseServiceConfig } from '../dist/service/index.js';
import { createPasswordHasher } from '../dist/users/index.js';

const hasher = createPasswordHasher();
const probes = createProbes({ run: createRunner(), parseServiceConfig, loadControls: loadControlsFolder, loadPulse: loadCheckTexts, hashOnce: (password) => hasher.hash(password) });
const { code } = await runDoctor({ probes, log: (line) => process.stdout.write(`${line}\n`) });
process.exit(code);
