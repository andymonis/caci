import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAccountRoutes, STATUS_OF } from '../api/index.js';
import { DEFAULT_CLIENT_RULE, DEFAULT_USERNAME_RULE, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from '../users/index.js';
import { parseServiceConfig, VARIABLES } from './config.js';

// The README says what the service does. These checks make it fail the build when the README and the
// code disagree: every variable, route, command and number it names must be real.

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

function section(title: string): string {
  const start = readme.indexOf(`## ${title}\n`);
  expect(start, `README has no "## ${title}" section`).toBeGreaterThanOrEqual(0);
  const end = readme.indexOf('\n## ', start + 3);
  return readme.slice(start, end === -1 ? undefined : end);
}
const accounts = section('User accounts and the login API');
const defaults = parseServiceConfig({});
/** Settings that are read and checked but do nothing yet: T-093 wires them in and T-094 documents them, so the README does not describe them. Remove them from this list when it does (the test below fails if they are documented early or left out late). */
const NOT_DOCUMENTED_YET: readonly string[] = ['CACI_LLM', 'CACI_PROPOSALS_PER_HOUR', 'CACI_MAX_PENDING_PER_USER'];
const DOCUMENTED = [...VARIABLES].filter((v) => !NOT_DOCUMENTED_YET.includes(v));

describe('the user accounts section of the README', () => {
  it('is there, and long enough to be the real thing', () => {
    expect(accounts.length).toBeGreaterThan(3000);
    for (const heading of ['### Settings', '### The routes', '### What protects it, and what does not', '### Forgotten passwords']) expect(accounts).toContain(heading);
  });

  it('names every setting the service reads, and no other', () => {
    const named = new Set(accounts.match(/CACI_[A-Z_]+/g) ?? []);
    expect([...named].sort()).toEqual([...DOCUMENTED].sort());
  });

  it('gives the right default for each setting', () => {
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    const rows: Record<string, string> = {};
    for (const line of accounts.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 5 && cells[1]?.startsWith('`CACI_')) rows[cells[1].replace(/`/g, '')] = cells[3] as string;
    }
    const d = defaults.value;
    expect(rows).toMatchObject({
      CACI_PORT: `\`${d.port}\``,
      CACI_ALLOW_REGISTRATION: `\`${d.allowRegistration}\``,
      CACI_COOKIE_SECURE: `\`${d.cookieSecure}\``,
      CACI_TRUSTED_PROXIES: `\`${d.trustedProxies}\``,
      CACI_ALLOW_INSECURE: `\`${d.allowInsecure}\``,
      CACI_DATA_DIR: `\`${d.dataDir}\``,
    });
    expect(rows.CACI_BIND).toContain(d.bind);
    expect(rows.CACI_ALLOWED_HOSTS).toBe('not set');
    expect(Object.keys(rows).sort()).toEqual([...DOCUMENTED].sort());
  });

  it('lists exactly the routes the server has', () => {
    const real = createAccountRoutes({ controller: {} as never }).map((r) => `${r.method} ${r.path}`);
    const documented = [...accounts.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...real].sort());
  });

  it('every command it tells you to run exists as a script', () => {
    const commands = [...accounts.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1] as string);
    expect(new Set(commands)).toEqual(new Set(['serve', 'users']));
    for (const c of commands) expect(pkg.scripts[c], c).toBeDefined();
  });

  it('every status code it mentions is one the routes can send', () => {
    const sent = new Set(Object.values(STATUS_OF));
    const mentioned = [...(accounts.match(/Failures are[^\n]*/)?.[0] ?? '').matchAll(/\b(4\d\d)\b/g)].map((m) => Number(m[1]));
    expect(mentioned.length).toBeGreaterThanOrEqual(6);
    for (const code of mentioned) expect(sent.has(code), String(code)).toBe(true);
    for (const code of sent) if (code !== 500) expect(mentioned, `README does not mention ${code}`).toContain(code);
  });

  it('states the numbers that are in the code', () => {
    expect(accounts).toContain(`${USERNAME_MIN} to ${USERNAME_MAX} of`);
    expect(accounts).toContain(`${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
    expect(accounts).toContain(`After ${DEFAULT_USERNAME_RULE.threshold} wrong passwords`);
    expect(accounts).toContain(`one address gets ${DEFAULT_CLIENT_RULE.threshold} tries`);
    expect(accounts).toContain('10 an hour');
    expect(accounts).toContain('at most 16 KB');
    expect(accounts).toContain('up to 15 minutes');
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['Register yourself first', 'first account ever created becomes the admin', 'not encrypted', 'No HTTPS here', 'there is no emailed reset', 'never takes the password as an argument', 'only credential']) {
      expect(accounts, phrase).toContain(phrase);
    }
  });
});
