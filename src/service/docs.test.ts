import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CIRCLE_STATUS_OF, createAccountRoutes, createBrainRoutes, createCaptureRoutes, createCircleRoutes, createInvitationRoutes, createReadRoutes, createSharingRoutes, createStatusRoutes, mapCaciError, STATUS_OF, WEB_POLICY } from '../api/index.js';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_ROLES, DEFAULT_CIRCLE_LIMITS, DEFAULT_PAGE_SIZE as CIRCLE_PAGE } from '../circles/index.js';
import { CACI_ERROR_CODES, caciError, DEFAULT_STATUS_CONTEXT_LIMITS, MAX_STATUS_REQUEST_CHARS, MAX_DATA_CHARS, MAX_NOTE_CHARS, MAX_PAGE, DEFAULT_PAGE } from '../caci/index.js';
import { DEFAULT_CANDIDATE_OPTIONS, DEFAULT_CONTROLLER_OPTIONS } from '../app/index.js';
import { createLedgerRoutes } from '../api/index.js';
import { DEFAULT_CLIENT_RULE, DEFAULT_USERNAME_RULE, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from '../users/index.js';
import { DEFAULT_GRANT_LIMITS } from '../sharing/index.js';
import { CONTROL_FILES, SETTING_RANGES, SLOT_RULES } from '../llm/index.js';
import { authoriseBrain } from '../scopes/index.js';
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
/** Settings the service reads that the README does not describe yet (emptied by the README task, T-194). */
const NOT_DOCUMENTED_YET: readonly string[] = [];
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
    for (const phrase of ['A circle shares nothing by itself', 'no power over circles', 'nothing happens until that person accepts', 'the same whether or not that account exists', 'exactly the answer for a circle that does not exist', 'A circle always has an owner', 'Nobody changes their own role', 'plain text', 'Nobody is told about an invitation']) {
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
    for (const heading of ['### Open it', '### What it is made of', '### What it sends and keeps', '### Circles in the web app', '### Notes in the web app', '### The policy on every page', '### Browsers and limits']) expect(webSection).toContain(heading);
  });

  it('lists exactly the files the service serves, each by its own name', () => {
    const documented = [...webSection.matchAll(/^\| `([a-z-]+\.(?:html|js|css))` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual(WEB_FILE_SPECS.map((s) => s.file).sort());
    expect(documented).toHaveLength(WEB_FILE_SPECS.length);
    expect(webSection).toContain(`only these ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty', 'thirty-one', 'thirty-two', 'thirty-three', 'thirty-four', 'thirty-five', 'thirty-six'][WEB_FILE_SPECS.length]}`);
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

  it('lists exactly the seven addresses the router knows, and each one is a screen the router returns', async () => {
    const { parseHash } = await loadWeb<{ parseHash: (hash: string) => Route }>('router.js');
    const documented = [...webSection.matchAll(/^\| `(#\/[^`]*)` \|/gm)].map((m) => m[1] as string);
    expect(documented).toEqual(['#/', '#/circles', '#/circles/<id>', '#/invitations', '#/status', '#/capture', '#/brain', '#/ledger']);
    expect(parseHash('#/status')).toEqual({ name: 'status' });
    expect(parseHash('#/capture')).toEqual({ name: 'capture' });
    expect(parseHash('#/brain')).toEqual({ name: 'brain' });
    expect(parseHash('#/ledger')).toEqual({ name: 'ledger' });
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

  it('names exactly the capture and browse routes the page uses, and they all exist', () => {
    const real = [...createCaptureRoutes({ caci: {} as never }), ...createReadRoutes({ caci: {} as never })].map((r) => `${r.method} ${r.path}`);
    const named = [...new Set([...webSection.matchAll(/`((?:GET|POST) \/api\/(?:capture|graph)[^`\s]*)`/g)].map((m) => m[1] as string))].sort();
    expect(named).toEqual(['GET /api/capture/mode', 'GET /api/graph/categories', 'GET /api/graph/category', 'GET /api/graph/item', 'POST /api/capture/propose', 'POST /api/capture/proposals/:id/approve', 'POST /api/capture/proposals/:id/reject', 'GET /api/capture/proposals/:id'].sort());
    for (const route of named) expect(real, route).toContain(route);
  });

  it('prints the model notice in exactly the words the page uses, for both modes and for not known', async () => {
    const { MODE_WORDS, MODE_UNKNOWN } = await loadWeb<{ MODE_WORDS: Record<string, string>; MODE_UNKNOWN: string }>('capture-view.js');
    const rows = [...webSection.matchAll(/^\| `(demo|anthropic)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]);
    expect(rows.map((r) => r[0])).toEqual(['demo', 'anthropic']);
    for (const [mode, words] of rows) expect(words, String(mode)).toBe(MODE_WORDS[mode as string]);
    expect(webSection).toContain(`| not known | ${MODE_UNKNOWN} |`);
  });

  it('the note limit it states is the one the page enforces', async () => {
    const { NOTE_MAX } = await loadWeb<{ NOTE_MAX: number }>('notes-client.js');
    expect(webSection).toContain(`1 to ${NOTE_MAX.toLocaleString('en-GB')} characters`);
  });

  it('every command and setting it names exists, and there is no build step for the web files', () => {
    for (const c of [...webSection.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1] as string)) expect(pkg.scripts[c], c).toBeDefined();
    for (const v of webSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    expect(Object.keys(pkg.scripts).filter((name) => /web|bundle|vite|webpack/i.test(name) || /\b(vite|webpack|esbuild|rollup)\b/.test(pkg.scripts[name] ?? ''))).toEqual([]);
    expect(webSection).toContain('no build step and no dependency');
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['Nothing else is built yet', 'cannot edit, delete or search what you filed', 'file notes and look through them', 'use circles', 'Register yourself first', 'becomes the administrator', 'not an installable app', 'no service worker', 'as text, never as markup', 'Nothing in the browser', 'to the same address, because the session cookie', 'no HTTPS of its own', 'pass the service\'s headers through unchanged', 'the main heading takes the focus', 'The **service decides**', 'Leaving, deleting a circle and removing someone ask first', 'never a browser dialog', 'never says whether such an account exists', 'No such circle, or you are not in it.', 'What you share', 'Shared with you', 'everyone in a circle sees everyone\'s username and display name', 'nobody is notified of an invitation', 'nothing is live', 'two tabs do not know about each other', 'The page says which model files the note, before it is sent', 'keeps the Propose button disabled until it knows', 'nothing is written until you press Approve', 'the note stays in the box', 'Browsing is read-only', 'page state, not part of the address', 'it does not update by itself', 'hold more than one proposal at a time', 'specs/R-007-web-notes.md', 'the capture and browse routes listed under **Notes in the web app**']) {
      expect(webSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });
});

const sharedSection = section('Shared circle brains');

describe('the shared circle brains section of the README', () => {
  it('lists exactly the sharing routes the server has', () => {
    const real = createSharingRoutes({ sharing: {} as never }).map((r) => `${r.method} ${r.path}`);
    const documented = [...sharedSection.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => (m[1] as string).replace(/\?id=$/, ''));
    expect(documented.sort()).toEqual([...real].sort());
    expect(real).toHaveLength(7);
  });

  it('states the number that is in the code, and names its specification, which exists', () => {
    expect(sharedSection).toContain(`at most **${DEFAULT_GRANT_LIMITS.maxCategoriesPerGrant} categories**`);
    expect(sharedSection).toContain('specs/R-008-shared-brains.md');
    expect(existsSync(new URL('../../specs/R-008-shared-brains.md', import.meta.url))).toBe(true);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['**Read-only.** The person who receives a share can read and cannot change anything', 'One direction, one person', 'Roles in the circle carry no access', 'Nothing is copied', 'narrowing or withdrawing takes effect on the next request', 'It ends by itself', 'Coming back by invitation brings nothing back', 'exactly the same not-found answer', 'The platform admin has no access', 'in the query string, never in the path', 'Nobody is told', 'A member can copy what they see by hand', 'The release gates are not met', 'pseudonymisation', 'a data processing agreement', 'a lawful basis', 'a risk assessment', 'Do not use sharing with other people', 'the real model still receives every note', 'Show what I share', 'Show what is shared with me']) {
      expect(sharedSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('is linked from the web app part, and every command and setting it names exists', () => {
    expect(webSection).toContain('Shared with you');
    for (const v of sharedSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
  });
});

const brainSection = section('The shared circle brain');

describe('the shared circle brain section of the README', () => {
  it('lists exactly the brain routes the server has', () => {
    const real = createBrainRoutes({ caci: {} as never }).map((r) => `${r.method} ${r.path}`);
    const documented = [...brainSection.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...real].sort());
    expect(real).toHaveLength(5);
  });

  it('prints the authorisation matrix exactly as the code decides it', () => {
    for (const role of CIRCLE_ROLES) {
      const row = brainSection.split('\n').find((l) => l.startsWith(`| ${role} |`));
      expect(row, role).toBeDefined();
      const [, , capture, read] = (row as string).split('|').map((c) => c.trim());
      expect(capture, `${role} capture`).toBe(authoriseBrain(role, 'capture') ? 'yes' : 'no');
      expect(read, `${role} read`).toBe(authoriseBrain(role, 'read') ? 'yes' : 'no');
    }
    expect(CIRCLE_ROLES).toHaveLength(4);
  });

  it('states the scope limit that is in the code, and names its specification, which exists', () => {
    expect(brainSection).toContain(`default 25 brains including their own`);
    expect(defaults.ok ? defaults.value.maxBrainScopes : 0).toBe(25);
    expect(brainSection).toContain(`default ${defaults.ok ? defaults.value.maxBrainScopes : 0} brains`);
    expect(brainSection).toContain('specs/R-009-shared-circle-brains.md');
    expect(existsSync(new URL('../../specs/R-009-shared-circle-brains.md', import.meta.url))).toBe(true);
    expect(readme).toMatch(/\| `CACI_MAX_BRAIN_SCOPES` \|[^|]*\| `25` \|/);
  });

  it('prints the circle notice in exactly the words the page uses', async () => {
    const view = (await import(new URL('../../web/capture-view.js', import.meta.url).href)) as { circleNotice: (name: string, mode: string) => string };
    const demo = view.circleNotice('Name', 'demo');
    expect(brainSection).toContain(demo.replace('"Name"', '"Name"'));
    const real = view.circleNotice('Name', 'anthropic');
    expect(real.startsWith(demo)).toBe(true);
    expect(brainSection).toContain("the note and the names of the circle's categories are sent to Anthropic and are not anonymised");
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['separate from the per-member read-only shares', 'never takes a graph id from a request', 'exactly the same answer as a circle that does not exist', 'read from the store on every request', 'discarded and writes nothing', 'every circle you are in, together', 'stays two separate rows', 'never given a partial one', 'who added it and when', 'can set or forge them', 'bound to that scope when it is made', 'Where should this note go?', 'Which notes?', 'cannot be taken back once approved', 'What a member has read cannot be taken back', 'no edit and no delete', 'have no account', 'not pseudonymisation', 'unanonymised', 'Nobody is told', 'The release gates are not met', 'pseudonymisation', 'a data processing agreement', 'a lawful basis', 'a risk assessment', 'Do not use circle brains with other people']) {
      expect(brainSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('is linked from the circles and web parts, and every setting and command it names exists', () => {
    expect(section('Circles')).toContain('The shared circle brain');
    expect(webSection).toContain('The shared circle brain');
    for (const v of brainSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    for (const m of brainSection.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1] as string);
  });
});

const statusSection = section('Asking for a status update');

describe('the status update section of the README', () => {
  it('lists exactly the status route the server has', () => {
    const real = createStatusRoutes({ caci: {} as never }).map((r) => `${r.method} ${r.path}`);
    const documented = [...statusSection.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented).toEqual(real);
    expect(real).toEqual(['POST /api/status']);
  });

  it('states the numbers that are in the code, and the setting with its default', () => {
    expect(MAX_STATUS_REQUEST_CHARS).toBe(500);
    expect(statusSection).toContain(`at most ${MAX_STATUS_REQUEST_CHARS} characters`);
    expect(defaults.ok ? defaults.value.statusPerHour : 0).toBe(20);
    expect(statusSection).toContain(`(default ${defaults.ok ? defaults.value.statusPerHour : 0}, counted`);
    expect(statusSection).toContain(`up to ${DEFAULT_STATUS_CONTEXT_LIMITS.maxPerScope} per scope and ${DEFAULT_STATUS_CONTEXT_LIMITS.maxTotalChars.toLocaleString('en-US')} characters in all`);
    expect(readme).toMatch(/\| `CACI_STATUS_PER_HOUR` \|[^|]*\| `20` \|/);
    expect(statusSection).toContain(`default ${defaults.ok ? defaults.value.maxBrainScopes : 0} brains including their own`);
  });

  it('prints the notices in exactly the words the page uses, and names its specification, which exists', async () => {
    const view = await loadWeb<{ STATUS_MODE_WORDS: Record<string, string>; STATUS_CONTEXT: string; STATUS_NOTHING: string; STATUS_LEFT_OUT: string }>('status-view.js');
    for (const words of [view.STATUS_MODE_WORDS.demo, view.STATUS_MODE_WORDS.anthropic, view.STATUS_CONTEXT, view.STATUS_NOTHING, view.STATUS_LEFT_OUT]) expect(statusSection).toContain(words as string);
    expect(statusSection).toContain('specs/R-011-status-updates.md');
    expect(existsSync(new URL('../../specs/R-011-status-updates.md', import.meta.url))).toBe(true);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['It is not a question to another person', 'nothing you ask or get back is filed in any brain', 'no history is kept', 'everything you can read', 'observers included', 'you alone', 'never carries who wrote it', 'nothing leaves the machine', 'are not anonymised', 'for every account at once', 'the service turns those into where each came from', 'repaired once and then refused', 'any other field or query parameter is refused by name', 'one status in progress at a time', 'before anything is asked', 'is not saved anywhere', 'gone when you leave the screen or sign out', 'The model can still state something wrongly', 'The release gates (pseudonymisation', 'a data processing agreement', 'a lawful basis', 'a risk assessment', 'do not use it with other people', 'location, weather or calendars']) {
      expect(statusSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('is linked from the web part, and every setting and command it names exists', () => {
    expect(webSection).toContain('Asking for a status update');
    for (const v of statusSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    for (const m of statusSection.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1] as string);
    expect(webSection).toContain('`#/status`');
    expect(webSection).toContain('and **ask CaCi for a status update** (see **Asking for a status update** below)');
  });
});

const controlsSection = section('Controlling what the model is told');

describe('the controls section of the README', () => {
  it('lists exactly the six files the service reads, and says nothing else is read', () => {
    const documented = [...controlsSection.matchAll(/^\| `(controls\/[a-z]+\/[a-z]+\.(?:txt|json))` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual(CONTROL_FILES.map((f) => `controls/${f}`).sort());
    expect(controlsSection).toContain('Exactly these six files are read, and nothing else in the folder');
  });

  it('names exactly the slots each template may use, and which are required', () => {
    for (const [name, rules] of Object.entries(SLOT_RULES)) {
      const row = controlsSection.split('\n').find((l) => l.startsWith(`| \`controls/${name}\``));
      expect(row, name).toBeDefined();
      const slots = [...(row as string).matchAll(/\{\{([A-Za-z0-9]+)\}\}/g)].map((m) => m[1] as string);
      expect(slots.sort(), name).toEqual([...rules.allowed].sort());
      const once = (rules as { once?: readonly string[] }).once ?? [];
      const required = (rules as { required?: readonly string[] }).required ?? [];
      for (const slot of required) expect(row, `${name} ${slot}`).toContain(`{{${slot}}}\` (required)`);
      if (once.length > 0) expect(row, name).toContain('each exactly once');
    }
  });

  it('prints every setting with its shipped value and its range, as the code has them', () => {
    for (const capability of ['categorise', 'status'] as const) {
      const shipped = JSON.parse(readFileSync(new URL(`../../controls/${capability}/settings.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
      for (const [setting, [lo, hi]] of Object.entries(SETTING_RANGES[capability])) {
        const rows = controlsSection.split('\n').filter((l) => l.startsWith(`| \`${setting}\` |`));
        const row = rows.find((l) => l.includes(`\`${String(shipped[setting])}\``) && l.includes(`${lo.toLocaleString('en-US')} to ${hi.toLocaleString('en-US')}`));
        expect(row, `${capability} ${setting}`).toBeDefined();
      }
    }
    expect(Object.keys(SETTING_RANGES.categorise)).toHaveLength(11);
    expect(Object.keys(SETTING_RANGES.status)).toHaveLength(9);
  });

  it('states the API limits the controls may not go below, and they are the ones in the code', () => {
    expect(MAX_NOTE_CHARS).toBe(8000);
    expect(MAX_STATUS_REQUEST_CHARS).toBe(500);
    expect(controlsSection).toContain("must not be below the service's own 8,000");
    expect(controlsSection).toContain("must not be below the service's own 500");
  });

  it('shows the commands, and every npm script and setting it names exists', () => {
    for (const command of ['npm run eval -- --scripted --controls /tmp/candidate', 'npm run eval -- --controls /tmp/candidate --yes', 'npm run dev:lab -- --controls /tmp/candidate']) expect(controlsSection).toContain(command);
    for (const m of controlsSection.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1] as string);
    for (const v of controlsSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    expect(controlsSection).toContain('specs/R-012-controllable-llm.md');
    expect(existsSync(new URL('../../specs/R-012-controllable-llm.md', import.meta.url))).toBe(true);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['three separate parts', 'plain text files in the `controls/` folder', 'never reads it again for slots', 'stays plain text', 'between their own delimiters', 'the guard and the instructions are all built from these same numbers', 'Some combinations are refused', 'The service **refuses to start** if the controls allow less', 'Reply again with the corrected JSON object only', 'A bad folder stops with every problem listed before any call is made', '**A bad file stops the service from starting**', 'There is **no versioning**', 'a change applies only after a restart', 'Edit the files in `controls/`, commit them, and update as usual', 'Anyone who can edit the repository', 'not caught until you compare runs', 'never served over HTTP']) {
      expect(controlsSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('the Pi runbook points at it', () => {
    expect(section('Running on a Raspberry Pi')).toContain('Controlling what the model is told');
  });
});

const viewSection = section('The current-view brain and its change log');

describe('the current-view brain section of the README', () => {
  it('lists exactly the change-log route the server has, and the setting with its default and range', () => {
    const real = createLedgerRoutes({ caci: {} as never }).map((r) => `${r.method} ${r.path}`);
    const documented = [...viewSection.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) \/api\/[^`]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented).toEqual(real);
    expect(real).toEqual(['GET /api/ledger']);
    expect(defaults.ok ? defaults.value.ledgerDays : 0).toBe(90);
    expect(viewSection).toContain(`\`CACI_LEDGER_DAYS\` days (default ${defaults.ok ? defaults.value.ledgerDays : 0}, 1 to 3650`);
    expect(readme).toMatch(/\| `CACI_LEDGER_DAYS` \|[^|]*\| `90` \|/);
    expect(parseServiceConfig({ CACI_LEDGER_DAYS: '3650' }).ok).toBe(true);
    expect(parseServiceConfig({ CACI_LEDGER_DAYS: '3651' }).ok).toBe(false);
    expect(parseServiceConfig({ CACI_LEDGER_DAYS: '0' }).ok).toBe(false);
  });

  it('states the limits that are in the code and the controls: 8 candidates, 5 replaces, 200 and 400 characters', () => {
    expect(DEFAULT_CANDIDATE_OPTIONS.maxCandidates).toBe(8);
    expect(viewSection).toContain(`up to ${DEFAULT_CANDIDATE_OPTIONS.maxCandidates} notes`);
    const shipped = JSON.parse(readFileSync(new URL('../../controls/categorise/settings.json', import.meta.url), 'utf8')) as { maxReplaces: number };
    expect(shipped.maxReplaces).toBe(5);
    expect(viewSection).toContain(`more than ${shipped.maxReplaces} is refused`);
    expect(SETTING_RANGES.categorise.maxReplaces).toEqual([0, 20]);
    expect(viewSection).toContain('`maxReplaces` to `0`');
    expect(viewSection).toContain('cut to 200 and 400 characters');
  });

  it('prints the warning in the exact words the service prints, and the preview words the page uses', async () => {
    expect(readFileSync(new URL('../caci/controller.ts', import.meta.url), 'utf8')).toContain('the change was made but could not be recorded in the change log');
    expect(viewSection).toContain('the change was made but could not be recorded in the change log');
    const view = await loadWeb<{ replaceLines: (s: unknown) => string[] }>('capture-view.js');
    const line = view.replaceLines({ removed: [{ id: 'x', title: 'TITLE', summary: '' }] })[0] as string;
    const [head, tail] = line.split('TITLE.') as [string, string];
    expect(viewSection).toContain(`"${head}`);
    expect(viewSection).toContain(tail.trim());
  });

  it('names its specification, which exists, the screen address and the commands', () => {
    expect(viewSection).toContain('specs/R-014-current-view-brain.md');
    expect(existsSync(new URL('../../specs/R-014-current-view-brain.md', import.meta.url))).toBe(true);
    expect(viewSection).toContain('`#/ledger`');
    for (const v of viewSection.match(/CACI_[A-Z_]+/g) ?? []) expect([...VARIABLES], v).toContain(v);
    for (const m of viewSection.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1] as string);
    expect(viewSection).toContain('--no-replace');
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of ['only the current view', 'The model never writes a delete', 'without their ids', 'a number that was not shown, a repeat, or more than 5 is refused and repaired once', 'The service turns the numbers into ids', 'Only notes are replaced directly', 'The preview says so before you approve', 'A note that only adds a different fact replaces nothing', 'A note is a whole item', 'takes with it any detail the old note held', 'anyone who may capture', 'an observer cannot capture', 'the removed title and summary', 'a review log, not a history', 'is not used to answer questions', 'A stranger, the administrator who is not a member, and a made-up circle all get the same 404', 'not one transaction', 'never undoes the change', 'nothing is requested until you open it', 'A model can choose wrongly', 'They do not prevent it', 'misses a paraphrase', 'plain text in `users.db`', 'Restoring from the log and questions about history are not built']) {
      expect(viewSection.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });
});
