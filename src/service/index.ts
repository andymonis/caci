// Puts the pieces together into a running service: configuration from environment variables, two
// SQLite databases, the user controller and the HTTP API. `npm run serve` is a thin script around `serve`.

export { isLoopbackAddress, parseServiceConfig, VARIABLES } from './config.js';
export type { ConfigError, ServiceConfig } from './config.js';
export { startService } from './service.js';
export type { RunningService, ServiceOptions } from './service.js';
export { serve } from './cli.js';
export type { ServeIo, ServeResult } from './cli.js';
