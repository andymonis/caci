import { err, ok, type Result } from '../graph_store/index.js';
import { ANTHROPIC_KEY_VARIABLE, readAnthropicKey } from '../llm/index.js';

export interface ServiceConfig {
  /** `CACI_PORT`: 0 to 65535 (0 picks a free one). Default 8080. */
  readonly port: number;
  /** `CACI_BIND`: the address to listen on. Default `127.0.0.1`. */
  readonly bind: string;
  /** `CACI_DATA_DIR`: where `graphs.db` and `users.db` live. Default `./data`. */
  readonly dataDir: string;
  /** `CACI_ALLOW_REGISTRATION`: default true. */
  readonly allowRegistration: boolean;
  /** `CACI_COOKIE_SECURE`: send the session cookie only over HTTPS. Default false. */
  readonly cookieSecure: boolean;
  /** `CACI_TRUSTED_PROXIES`: reverse proxies in front, 0 to 5. Default 0. */
  readonly trustedProxies: number;
  /** `CACI_ALLOWED_HOSTS`: names the server answers to, comma separated. Default: none given. */
  readonly allowedHosts?: readonly string[];
  /** `CACI_ALLOW_INSECURE`: accept a non-loopback address with plain cookies. Default false. */
  readonly allowInsecure: boolean;
  /**
   * `CACI_LLM`: which model files notes. `demo` (the default) is free and sends nothing anywhere; `anthropic` uses the real
   * model and needs `ANTHROPIC_API_KEY`. The key itself is deliberately **not** part of this object (it would leak
   * into anything that prints a config); whoever starts the model reads it from the environment at that moment.
   */
  readonly llm: 'demo' | 'anthropic';
  /** `CACI_PROPOSALS_PER_HOUR`: new proposals one account may start in an hour, 1 to 10,000. Default 30. */
  readonly proposalsPerHour: number;
  /** `CACI_MAX_PENDING_PER_USER`: proposals one account may have waiting, 1 to 100. Default 10. */
  readonly maxPendingPerUser: number;
}

/** One thing wrong with the settings: which variable, and what to do. Never the value given. */
export interface ConfigError {
  readonly variable: string;
  readonly message: string;
}

export const VARIABLES: readonly string[] = Object.freeze([
  'CACI_PORT',
  'CACI_BIND',
  'CACI_DATA_DIR',
  'CACI_ALLOW_REGISTRATION',
  'CACI_COOKIE_SECURE',
  'CACI_TRUSTED_PROXIES',
  'CACI_ALLOWED_HOSTS',
  'CACI_ALLOW_INSECURE',
  'CACI_LLM',
  'CACI_PROPOSALS_PER_HOUR',
  'CACI_MAX_PENDING_PER_USER',
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^(?=.*:)[0-9A-Fa-f:]{2,45}$/;
const validBind = (bind: string): boolean => bind === 'localhost' || IPV6.test(bind) || (IPV4.exec(bind)?.slice(1).every((part) => Number(part) <= 255) ?? false);
const HOST = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

export const isLoopbackAddress = (bind: string): boolean => bind === 'localhost' || bind === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bind) && validBind(bind);

/**
 * Reads the service settings from environment variables (passed in: nothing here reads `process.env`).
 * Reports every problem, not just the first, and refuses a setting it does not know (a typo in a
 * variable name must not be silently ignored when the setting protects someone).
 */
export function parseServiceConfig(env: Readonly<Record<string, string | undefined>>): Result<ServiceConfig, readonly ConfigError[]> {
  const errors: ConfigError[] = [];
  const bad = (variable: string, message: string): void => void errors.push({ variable, message });

  for (const name of Object.keys(env)) {
    if (name.startsWith('CACI_') && !VARIABLES.includes(name) && env[name] !== undefined) bad(name, 'is not a setting this service knows (check the spelling)');
  }

  const text = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
  };
  const whole = (name: string, fallback: number, min: number, max: number): number => {
    const value = text(name);
    if (value === undefined) return fallback;
    if (!/^\d{1,5}$/.test(value) || Number(value) < min || Number(value) > max) {
      bad(name, `must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return Number(value);
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const value = text(name);
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    bad(name, 'must be true or false');
    return fallback;
  };

  const port = whole('CACI_PORT', 8080, 0, 65535);
  const bindGiven = text('CACI_BIND');
  let bind = '127.0.0.1';
  if (bindGiven !== undefined) {
    if (validBind(bindGiven)) bind = bindGiven;
    else bad('CACI_BIND', 'must be an IP address or localhost');
  }
  const dirGiven = text('CACI_DATA_DIR');
  let dataDir = './data';
  if (dirGiven !== undefined) {
    if (dirGiven.length > 1024 || dirGiven.includes('\0')) bad('CACI_DATA_DIR', 'must be a folder path of at most 1,024 characters');
    else dataDir = dirGiven;
  }
  const allowRegistration = flag('CACI_ALLOW_REGISTRATION', true);
  const cookieSecure = flag('CACI_COOKIE_SECURE', false);
  const trustedProxies = whole('CACI_TRUSTED_PROXIES', 0, 0, 5);
  const allowInsecure = flag('CACI_ALLOW_INSECURE', false);
  const proposalsPerHour = whole('CACI_PROPOSALS_PER_HOUR', 30, 1, 10_000);
  const maxPendingPerUser = whole('CACI_MAX_PENDING_PER_USER', 10, 1, 100);

  let llm: 'demo' | 'anthropic' = 'demo';
  const llmGiven = text('CACI_LLM');
  if (llmGiven !== undefined) {
    if (llmGiven === 'demo' || llmGiven === 'anthropic') llm = llmGiven;
    else bad('CACI_LLM', 'must be demo or anthropic');
  }
  // the real model needs its key, checked here so a missing or malformed key stops the start, and never repeated in the message
  if (llm === 'anthropic') {
    const key = readAnthropicKey(env);
    if (!key.ok) bad(ANTHROPIC_KEY_VARIABLE, key.error.message);
  }

  let allowedHosts: string[] | undefined;
  const hostsGiven = text('CACI_ALLOWED_HOSTS');
  if (hostsGiven !== undefined) {
    const hosts = hostsGiven.split(',').map((h) => h.trim());
    if (hosts.length > 20 || hosts.some((h) => !HOST.test(h))) bad('CACI_ALLOWED_HOSTS', 'must be up to 20 host names (with a port if not the default), separated by commas');
    else allowedHosts = hosts;
  }

  if (errors.length === 0 && !isLoopbackAddress(bind) && !cookieSecure && !allowInsecure) {
    bad('CACI_COOKIE_SECURE', 'must be true when CACI_BIND is not a loopback address (put HTTPS in front), or set CACI_ALLOW_INSECURE=true to accept sending session cookies in the clear');
  }
  if (errors.length > 0) return err(errors);
  return ok({ port, bind, dataDir, allowRegistration, cookieSecure, trustedProxies, ...(allowedHosts === undefined ? {} : { allowedHosts }), allowInsecure, llm, proposalsPerHour, maxPendingPerUser });
}
