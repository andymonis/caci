// `npm run serve`: starts the user accounts service from the built library. Settings come from
// CACI_* environment variables (see the README, "User accounts and the login API").
import process from 'node:process';
import { serve } from '../dist/service/index.js';

// Listen on loopback and the machine's IPv4 interfaces for trusted-LAN use. Override either setting for HTTPS deployments.
process.env.CACI_BIND ??= '0.0.0.0';
process.env.CACI_ALLOW_INSECURE ??= 'true';

const result = await serve(process.env, { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
if (result.code !== 0) process.exit(result.code);

let stopping = false;
const stop = async (signal) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`\n${signal}: closing...\n`);
  await result.service.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
