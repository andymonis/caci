import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './envfile.mjs';

describe('reading a systemd environment file', () => {
  it('reads KEY=VALUE lines, quotes optional, comments and blank lines ignored', () => {
    const env = parseEnvFile(['# a comment', '', 'CACI_PORT=8080', 'CACI_ALLOWED_HOSTS = "pi.local:8080,192.168.1.50:8080"', "NAME='single quoted'", '; also a comment', 'EMPTY=', 'not a setting', '1BAD=x', 'KEY=a=b=c'].join('\n'));
    expect({ ...env }).toEqual({ CACI_PORT: '8080', CACI_ALLOWED_HOSTS: 'pi.local:8080,192.168.1.50:8080', NAME: 'single quoted', EMPTY: '', KEY: 'a=b=c' });
  });
  it('handles Windows line ends, and a lone quote is kept as it is', () => {
    expect({ ...parseEnvFile('A=1\r\nB="x\r\n') }).toEqual({ A: '1', B: '"x' });
  });
  it('has no prototype, so a setting named __proto__ or constructor is just a setting', () => {
    const env = parseEnvFile('__proto__=x\nconstructor=y');
    expect(Object.getPrototypeOf(env)).toBe(null);
    expect(env.constructor).toBe('y');
  });
  it('anything that is not text is an empty file', () => {
    expect({ ...parseEnvFile(undefined) }).toEqual({});
    expect({ ...parseEnvFile('') }).toEqual({});
  });
});
