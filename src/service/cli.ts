import { parseServiceConfig, type ConfigError } from './config.js';
import { startService, type RunningService } from './service.js';

export interface ServeIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type ServeResult = { readonly code: 0; readonly service: RunningService } | { readonly code: 1 | 2 };

const describe = (errors: readonly ConfigError[]): string => errors.map((e) => `  ${e.variable}: ${e.message}`).join('\n');

/**
 * What `npm run serve` does, with the environment and the output passed in so it can be tested:
 * read the settings, start the service, say where it is. Exit code 2 means the settings are wrong,
 * 1 means it could not start; in both nothing is left running. Prints nothing secret.
 */
export async function serve(env: Readonly<Record<string, string | undefined>>, io: ServeIo): Promise<ServeResult> {
  const config = parseServiceConfig(env);
  if (!config.ok) {
    io.stderr(`The settings are not valid:\n${describe(config.error)}\n`);
    return { code: 2 };
  }
  try {
    const service = await startService(config.value);
    const shown = service.host.includes(':') ? `[${service.host}]` : service.host;
    io.stdout(`Listening on http://${shown}:${service.port}\n`);
    io.stdout(`Data is kept in ${service.dataDir} (graphs.db and users.db, not encrypted).\n`);
    io.stdout(config.value.allowRegistration ? 'Registration is open: the first account made becomes the admin, so register yourself first.\n' : 'Registration is closed.\n');
    if (!config.value.cookieSecure) io.stdout('Session cookies are not marked Secure: use this on this machine only, or behind HTTPS.\n');
    return { code: 0, service };
  } catch (cause) {
    io.stderr(`Could not start: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return { code: 1 };
  }
}
