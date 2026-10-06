import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, parseServiceConfig, VARIABLES } from './config.js';

const good = (env: Record<string, string | undefined>) => {
  const r = parseServiceConfig(env);
  if (!r.ok) throw new Error(`expected valid settings, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errorsOf = (env: Record<string, string | undefined>) => {
  const r = parseServiceConfig(env);
  if (r.ok) throw new Error('expected invalid settings');
  return r.error;
};

describe('defaults', () => {
  it('an empty environment gives the safe local setup', () => {
    expect(good({})).toEqual({ port: 8080, bind: '127.0.0.1', dataDir: './data', allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false });
  });

  it('unset and empty are the same thing', () => {
    expect(good(Object.fromEntries(VARIABLES.map((v) => [v, ''])))).toEqual(good({}));
    expect(good(Object.fromEntries(VARIABLES.map((v) => [v, undefined])))).toEqual(good({}));
  });

  it('other environment variables are none of its business', () => {
    expect(good({ PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'production', ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxx' })).toEqual(good({}));
  });
});

describe('each setting', () => {
  it('CACI_PORT: 0 to 65535', () => {
    expect(good({ CACI_PORT: '3000' }).port).toBe(3000);
    expect(good({ CACI_PORT: '0' }).port).toBe(0);
    expect(good({ CACI_PORT: '65535' }).port).toBe(65535);
    for (const bad of ['65536', '-1', '80.5', 'abc', '1e3', ' 80', '080a', '999999']) expect(errorsOf({ CACI_PORT: bad }).map((e) => e.variable), bad).toEqual(['CACI_PORT']);
  });

  it('CACI_BIND: an address or localhost', () => {
    for (const bind of ['127.0.0.1', '0.0.0.0', '192.168.1.5', '::1', '::', 'fe80::1', 'localhost']) expect(good({ CACI_BIND: bind, CACI_COOKIE_SECURE: 'true' }).bind).toBe(bind);
    for (const bad of ['example.com', 'http://127.0.0.1', '127.0.0.1:80', 'a b', '999', '../x', '256.0.0.1', '1.2.3', '1.2.3.4.5', 'abcd', '1.2.3.4 ']) expect(errorsOf({ CACI_BIND: bad }).map((e) => e.variable), bad).toEqual(['CACI_BIND']);
  });

  it('CACI_DATA_DIR: any path of reasonable length', () => {
    expect(good({ CACI_DATA_DIR: '/var/lib/caci' }).dataDir).toBe('/var/lib/caci');
    expect(good({ CACI_DATA_DIR: 'relative/dir' }).dataDir).toBe('relative/dir');
    expect(errorsOf({ CACI_DATA_DIR: 'x'.repeat(1025) }).map((e) => e.variable)).toEqual(['CACI_DATA_DIR']);
    expect(errorsOf({ CACI_DATA_DIR: 'a\0b' }).map((e) => e.variable)).toEqual(['CACI_DATA_DIR']);
  });

  it.each([['CACI_ALLOW_REGISTRATION', 'allowRegistration', true], ['CACI_COOKIE_SECURE', 'cookieSecure', false], ['CACI_ALLOW_INSECURE', 'allowInsecure', false]] as const)('%s: true or false, nothing else', (variable, key, fallback) => {
    expect(good({ [variable]: 'true' })[key]).toBe(true);
    expect(good({ [variable]: 'false' })[key]).toBe(false);
    expect(good({})[key]).toBe(fallback);
    for (const bad of ['TRUE', 'yes', '1', '0', 'on', 'True', 'false ', 'no']) expect(errorsOf({ [variable]: bad }).map((e) => e.variable), bad).toEqual([variable]);
  });

  it('CACI_TRUSTED_PROXIES: 0 to 5', () => {
    for (const n of [0, 1, 5]) expect(good({ CACI_TRUSTED_PROXIES: String(n) }).trustedProxies).toBe(n);
    for (const bad of ['6', '-1', '1.5', 'x', '99999']) expect(errorsOf({ CACI_TRUSTED_PROXIES: bad }).map((e) => e.variable), bad).toEqual(['CACI_TRUSTED_PROXIES']);
  });

  it('CACI_ALLOWED_HOSTS: a comma separated list of host names, trimmed', () => {
    expect(good({ CACI_ALLOWED_HOSTS: 'notes.home.example' }).allowedHosts).toEqual(['notes.home.example']);
    expect(good({ CACI_ALLOWED_HOSTS: ' a.example , b.example:8443,[::1]:80 ' }).allowedHosts).toEqual(['a.example', 'b.example:8443', '[::1]:80']);
    expect('allowedHosts' in good({})).toBe(false);
    for (const bad of ['a.example,,b.example', 'a b', 'http://a.example', 'a.example/', 'x'.repeat(300), Array.from({ length: 21 }, (_, i) => `h${i}.example`).join(',')]) {
      expect(errorsOf({ CACI_ALLOWED_HOSTS: bad }).map((e) => e.variable), bad.slice(0, 30)).toEqual(['CACI_ALLOWED_HOSTS']);
    }
  });
});

describe('the rule about plain cookies on a network', () => {
  it('a loopback address is fine with plain cookies (local use)', () => {
    for (const bind of ['127.0.0.1', '127.0.0.5', '::1', 'localhost']) expect(parseServiceConfig({ CACI_BIND: bind }).ok, bind).toBe(true);
  });

  it('any other address needs secure cookies, or an explicit acceptance of the risk', () => {
    for (const bind of ['0.0.0.0', '192.168.1.5', '::', '10.0.0.2']) {
      expect(errorsOf({ CACI_BIND: bind }), bind).toEqual([{ variable: 'CACI_COOKIE_SECURE', message: expect.stringContaining('CACI_ALLOW_INSECURE') }]);
      expect(parseServiceConfig({ CACI_BIND: bind, CACI_COOKIE_SECURE: 'true' }).ok, bind).toBe(true);
      expect(parseServiceConfig({ CACI_BIND: bind, CACI_ALLOW_INSECURE: 'true' }).ok, bind).toBe(true);
    }
  });

  it('secure cookies on loopback are fine too (HTTPS terminated by a proxy on this machine)', () => {
    expect(good({ CACI_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });

  it('is isLoopbackAddress, and is exact about it', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['0.0.0.0', '128.0.0.1', '1127.0.0.1', '::', '::2', 'localhost.evil', '']) expect(isLoopbackAddress(a), a).toBe(false);
  });
});

describe('mistakes are reported, all of them, by variable name', () => {
  it('lists every problem at once', () => {
    const errors = errorsOf({ CACI_PORT: 'x', CACI_BIND: 'nope', CACI_ALLOW_REGISTRATION: 'maybe', CACI_TRUSTED_PROXIES: '9' });
    expect(errors.map((e) => e.variable)).toEqual(['CACI_PORT', 'CACI_BIND', 'CACI_ALLOW_REGISTRATION', 'CACI_TRUSTED_PROXIES']);
    for (const e of errors) expect(e.message.length).toBeGreaterThan(10);
  });

  it('refuses a CACI_ variable it does not know, so a typo is not silently ignored', () => {
    expect(errorsOf({ CACI_ALLOW_REGISTERATION: 'false' })).toEqual([{ variable: 'CACI_ALLOW_REGISTERATION', message: expect.stringContaining('spelling') }]);
    expect(errorsOf({ CACI_COOKIE_SECUR: 'true' }).map((e) => e.variable)).toEqual(['CACI_COOKIE_SECUR']);
    expect(parseServiceConfig({ CACI_SOMETHING: undefined }).ok).toBe(true); // set to nothing: not set
    expect(parseServiceConfig({ caci_port: '1' }).ok).toBe(true); // a different (lower case) name is not one of ours
  });

  it('never repeats what was given in a message', () => {
    const odd = 'SECRET-LOOKING-VALUE-sk-ant-12345';
    const all = errorsOf({ CACI_PORT: odd, CACI_BIND: odd, CACI_DATA_DIR: `${odd}\0`, CACI_ALLOW_REGISTRATION: odd, CACI_COOKIE_SECURE: odd, CACI_TRUSTED_PROXIES: odd, CACI_ALLOWED_HOSTS: odd + ' x', CACI_ALLOW_INSECURE: odd, CACI_ODD: odd });
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(all)).not.toContain('SECRET');
    expect(JSON.stringify(all)).not.toContain('sk-ant');
  });

  it('the list of variables is the list the README will name', () => {
    expect([...VARIABLES].sort()).toEqual(['CACI_ALLOWED_HOSTS', 'CACI_ALLOW_INSECURE', 'CACI_ALLOW_REGISTRATION', 'CACI_BIND', 'CACI_COOKIE_SECURE', 'CACI_DATA_DIR', 'CACI_PORT', 'CACI_TRUSTED_PROXIES']);
  });
});
