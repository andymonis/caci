import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CIRCLE_STATUS_OF, createAccountRoutes, createCaptureRoutes, createCircleRoutes, createInvitationRoutes, createReadRoutes, mapCaciError, STATUS_OF, WEB_POLICY } from '../api/index.js';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_ROLES, DEFAULT_CIRCLE_LIMITS, DEFAULT_PAGE_SIZE as CIRCLE_PAGE } from '../circles/index.js';
import { CACI_ERROR_CODES, caciError, MAX_DATA_CHARS, MAX_NOTE_CHARS, MAX_PAGE, DEFAULT_PAGE } from '../caci/index.js';
import { DEFAULT_CONTROLLER_OPTIONS } from '../app/index.js';
import { DEFAULT_CLIENT_RULE, DEFAULT_USERNAME_RULE, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from '../users/index.js';
import { parseServiceConfig, VARIABLES } from './config.js';
import { WEB_FILE_SPECS } from './web-app.js';

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
const DOCUMENTED = [...VARIABLES];

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
      CACI_LLM: `\`${d.llm}\``,
      CACI_PROPOSALS_PER_HOUR: `\`${d.proposalsPerHour}\``,
      CACI_MAX_PENDING_PER_USER: `\`${d.maxPendingPerUser}\``,
      CACI_MAX_CIRCLES_PER_USER: `\`${d.maxCirclesPerUser}\``,
      CACI_MAX_MEMBERS_PER_CIRCLE: `\`${d.maxMembersPerCircle}\``,
      CACI_INVITATION_DAYS: `\`${d.invitationDays}\``,
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

const capture = section('Capturing notes through the API');

describe('the capturing section of the README', () => {
  it('is there, with its parts', () => {
    expect(capture.length).toBeGreaterThan(3000);
    for (const heading of ['### Which model files the notes', '### The routes', '### Limits and lifetimes', '### What is not protected']) expect(capture).toContain(heading);
  });

  it('lists exactly the capture and read routes the server has', () => {
    const real = [...createCaptureRoutes({ caci: {} as never }), ...createReadRoutes({ caci: {} as never })].map((r) => `${r.method} ${r.path}`);
    const documented = [...capture.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...real].sort());
  });

  it('mentions exactly the statuses the error mapping produces', () => {
    const samples = [
      ...CACI_ERROR_CODES.map((code) => caciError(code, 'x', code === 'INVALID_INPUT' ? { field: 'text' } : {})),
      { source: 'llm', error: { code: 'RATE_LIMITED', retryable: true, message: 'x' } },
      { source: 'llm', error: { code: 'TIMEOUT', retryable: true, message: 'x' } },
      { source: 'llm', error: { code: 'REFUSED', retryable: false, message: 'x' } },
      { source: 'graph', error: { code: 'NODE_NOT_FOUND', message: 'x' } },
      { source: 'graph', error: { code: 'STORAGE_ERROR', message: 'x' } },
    ];
    const produced = new Set(samples.map((e) => mapCaciError(e as never).status));
    const line = capture.match(/Failures are[^\n]*/)?.[0] ?? '';
    const mentioned = [...line.matchAll(/\b([45]\d\d)\b/g)].map((m) => Number(m[1]));
    expect(mentioned.sort()).toEqual([401, 404, 409, 410, 422, 429, 500, 502, 503]);
    expect([...produced].sort()).toEqual(mentioned.sort());
  });

  it('states the numbers that are in the code', () => {
    expect(capture).toContain(`at most ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters`);
    expect(capture).toContain(`${MAX_DATA_CHARS.toLocaleString('en-US')} characters is shortened`);
    expect(capture).toContain(`(1 to ${MAX_PAGE}, default ${DEFAULT_PAGE})`);
    expect(capture).toContain(`expires after ${DEFAULT_CONTROLLER_OPTIONS.ttlMs / 60_000} minutes`);
    expect(capture).toContain(`**${defaults.ok ? defaults.value.maxPendingPerUser : 0} pending and ${defaults.ok ? defaults.value.proposalsPerHour : 0} an hour per account**`);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['nothing is written until the person approves', '`ANTHROPIC_API_KEY`', 'every account at once', 'nothing is anonymised or pseudonymised', 'nothing leaves this machine', 'There is no per-account consent', 'Pending proposals live in memory', 'plain text', 'never contains the prompt', 'identical to the one for a made-up id']) {
      expect(capture.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('every command and every setting it names exists', () => {
    for (const v of capture.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    for (const c of [...capture.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1] as string)) expect(pkg.scripts[c], c).toBeDefined();
  });
});

const circlesSection = section('Circles');

describe('the circles section of the README', () => {
  it('is there, with its parts', () => {
    expect(circlesSection.length).toBeGreaterThan(3500);
    for (const heading of ['### Roles', '### Invitations', '### The routes', '### Limits', '### When an account is deleted', '### What is not protected']) expect(circlesSection).toContain(heading);
  });

  it('lists exactly the circle and invitation routes the server has', () => {
    const real = [...createCircleRoutes({ circles: {} as never }), ...createInvitationRoutes({ circles: {} as never })].map((r) => `${r.method} ${r.path}`);
    const documented = [...circlesSection.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...real].sort());
    expect(real).toHaveLength(15);
  });

  it('names exactly the roles there are, each in the roles table', () => {
    const table = circlesSection.slice(circlesSection.indexOf('### Roles'), circlesSection.indexOf('### Invitations'));
    const named = [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    expect(named).toEqual([...CIRCLE_ROLES]);
  });

  it('mentions exactly the statuses the circle routes can send', () => {
    const line = circlesSection.match(/Failures are[^\n]*/)?.[0] ?? '';
    const mentioned = [...line.matchAll(/\b([45]\d\d)\b/g)].map((m) => Number(m[1]));
    expect(mentioned.sort()).toEqual([...new Set(Object.values(CIRCLE_STATUS_OF))].sort());
  });

  it('states the numbers that are in the code', () => {
    expect(circlesSection).toContain(`**${DEFAULT_CIRCLE_LIMITS.maxCirclesPerUser} circles**`);
    expect(circlesSection).toContain(`**${DEFAULT_CIRCLE_LIMITS.maxMembersPerCircle} people**`);
    expect(circlesSection).toContain(`**${DEFAULT_CIRCLE_LIMITS.maxOpenInvitationsPerCircle} open invitations**`);
    expect(circlesSection).toContain(`**${DEFAULT_CIRCLE_LIMITS.invitationsPerHour} invitations an hour**`);
    expect(circlesSection).toContain(`An invitation lasts ${DEFAULT_CIRCLE_LIMITS.invitationDays} days`);
    expect(circlesSection).toContain(`1 to ${CIRCLE_NAME_MAX} characters and a description up to ${CIRCLE_DESCRIPTION_MAX}`);
    expect(CIRCLE_PAGE).toBe(50);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['Circles share no data yet', 'no power over circles', 'nothing happens until that person accepts', 'the same whether or not that account exists', 'exactly the answer for a circle that does not exist', 'A circle always has an owner', 'Nobody changes their own role', 'plain text', 'Nobody is told about an invitation']) {
      expect(circlesSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('every setting and command it names exists, and the settings table has them', () => {
    for (const v of circlesSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    for (const v of ['CACI_MAX_CIRCLES_PER_USER', 'CACI_MAX_MEMBERS_PER_CIRCLE', 'CACI_INVITATION_DAYS']) expect(accounts, v).toContain(`| \`${v}\` |`);
    for (const c of [...circlesSection.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1] as string)) expect(pkg.scripts[c], c).toBeDefined();
  });
});

const webSection = section('Using the web app');

// The page's own files are plain JavaScript without type declarations, so they are loaded by address and given the shape the test needs.
const loadWeb = async <T>(name: string): Promise<T> => (await import(new URL(`../../web/${name}`, import.meta.url).href)) as T;
type Route = { name: string };

describe('the web app section of the README', () => {
  it('is there, with its parts', () => {
    expect(webSection.length).toBeGreaterThan(3000);
    for (const heading of ['### Open it', '### What it is made of', '### What it sends and keeps', '### Circles in the web app', '### The policy on every page', '### Browsers and limits']) expect(webSection).toContain(heading);
  });

  it('lists exactly the files the service serves, each by its own name', () => {
    const documented = [...webSection.matchAll(/^\| `([a-z-]+\.(?:html|js|css))` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual(WEB_FILE_SPECS.map((s) => s.file).sort());
    expect(documented).toHaveLength(WEB_FILE_SPECS.length);
    expect(webSection).toContain(`only these ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen'][WEB_FILE_SPECS.length]}`);
  });

  it('prints exactly the policy the service sends, and its other headers', () => {
    expect(webSection).toContain(`\`\`\`\n${WEB_POLICY}\n\`\`\``);
    for (const header of ['Cache-Control: no-store', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer']) expect(webSection, header).toContain(header);
  });

  it('names exactly the four account routes the page uses, and they exist', () => {
    const named = [...webSection.matchAll(/`((?:GET|POST) \/api\/[a-z]+)`/g)].map((m) => m[1] as string).sort();
    expect(named).toEqual(['GET /api/me', 'POST /api/login', 'POST /api/logout', 'POST /api/register']);
    const real = createAccountRoutes({ controller: {} as never }).map((r) => `${r.method} ${r.path}`);
    for (const route of named) expect(real, route).toContain(route);
  });

  it('says it uses the fifteen circle and invitation routes, and there are fifteen', () => {
    const real = [...createCircleRoutes({ circles: {} as never }), ...createInvitationRoutes({ circles: {} as never })];
    expect(real).toHaveLength(15);
    expect(webSection).toContain('the fifteen circle and invitation routes');
  });

  it('lists exactly the four addresses the router knows, and each one is a screen the router returns', async () => {
    const { parseHash } = await loadWeb<{ parseHash: (hash: string) => Route }>('router.js');
    const documented = [...webSection.matchAll(/^\| `(#\/[^`]*)` \|/gm)].map((m) => m[1] as string);
    expect(documented).toEqual(['#/', '#/circles', '#/circles/<id>', '#/invitations']);
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/circles')).toEqual({ name: 'circles' });
    expect(parseHash('#/circles/c0123456789abcdef')).toMatchObject({ name: 'circle' });
    expect(parseHash('#/invitations')).toEqual({ name: 'invitations' });
    expect(parseHash('#/circles/<id>')).toEqual({ name: 'home' });
  });

  it('describes each role in exactly the words the page uses, and names exactly the four roles', async () => {
    const { ROLE_WORDS, ROLES: WEB_ROLES } = await loadWeb<{ ROLE_WORDS: Record<string, string>; ROLES: string[] }>('permissions.js');
    const rows = [...webSection.matchAll(/^\| `(owner|manager|member|observer)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]);
    expect(rows.map((r) => r[0])).toEqual([...WEB_ROLES]);
    for (const [role, words] of rows) expect(words, role).toBe(ROLE_WORDS[role as string]);
    expect(Object.keys(ROLE_WORDS).sort()).toEqual(['manager', 'member', 'observer', 'owner']);
  });

  it('every command and setting it names exists, and there is no build step for the web files', () => {
    for (const c of [...webSection.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1] as string)) expect(pkg.scripts[c], c).toBeDefined();
    for (const v of webSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    expect(Object.keys(pkg.scripts).filter((name) => /web|bundle|vite|webpack/i.test(name) || /\b(vite|webpack|esbuild|rollup)\b/.test(pkg.scripts[name] ?? ''))).toEqual([]);
    expect(webSection).toContain('no build step and no dependency');
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['Nothing else is built yet', 'does not capture notes', 'does not browse a graph', 'use circles', 'Register yourself first', 'becomes the administrator', 'not an installable app', 'no service worker', 'as text, never as markup', 'Nothing in the browser', 'to the same address, because the session cookie', 'no HTTPS of its own', 'pass the service\'s headers through unchanged', 'the main heading takes the focus', 'The **service decides**', 'Leaving, deleting a circle and removing someone ask first', 'never a browser dialog', 'never says whether such an account exists', 'No such circle, or you are not in it.', 'circles share no data yet', 'everyone in a circle sees everyone\'s username and display name', 'nobody is notified of an invitation', 'nothing is live', 'two tabs do not know about each other']) {
      expect(webSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });
});
