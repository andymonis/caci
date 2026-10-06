import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookies, serialiseCookie } from './cookies.js';

describe('parseCookies', () => {
  it('reads name=value pairs', () => {
    expect({ ...parseCookies('a=1; b=two; session=AbC_-9') }).toEqual({ a: '1', b: 'two', session: 'AbC_-9' });
  });

  it('gives nothing for a missing, empty or non-text header', () => {
    for (const header of [undefined, '', null as never, 5 as never, {} as never]) expect({ ...parseCookies(header) }).toEqual({});
  });

  it('the first of a repeated name wins, so a later one cannot shadow it', () => {
    expect(parseCookies('s=real; s=fake').s).toBe('real');
  });

  it('skips malformed pairs and keeps the good ones', () => {
    expect({ ...parseCookies('=novalue; noequals; ;; a=1; b c=2; d=3 4; e=ok') }).toEqual({ a: '1', e: 'ok' });
  });

  it('refuses names and values that are not safe: separators, control characters, quotes inside, non-ASCII', () => {
    expect({ ...parseCookies('a(b)=1; ok=1; v=a"b; w=a\\b; x=é; y=a,b') }).toEqual({ ok: '1' });
    expect({ ...parseCookies('n\u0000=1; m=\u0001') }).toEqual({});
  });

  it('removes one pair of surrounding double quotes', () => {
    expect(parseCookies('a="quoted"').a).toBe('quoted');
  });

  it('has no prototype, so __proto__, constructor and toString are just names', () => {
    const cookies = parseCookies('__proto__=x; constructor=y; toString=z; hasOwnProperty=w');
    expect(Object.getPrototypeOf(cookies)).toBeNull();
    expect(cookies.constructor).toBe('y');
    expect(cookies['__proto__']).toBe('x');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(cookies).sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(parseCookies('a=1'))).toBe(true);
  });

  it('ignores a header over 8 KB, a value over 4 KB, and keeps at most 50 cookies', () => {
    expect({ ...parseCookies(`a=${'x'.repeat(9000)}`) }).toEqual({});
    expect({ ...parseCookies(`big=${'x'.repeat(4097)}; ok=1`) }).toEqual({ ok: '1' });
    expect(Object.keys(parseCookies(Array.from({ length: 200 }, (_, i) => `c${i}=1`).join('; '))).length).toBe(50);
    expect(parseCookies(`big=${'x'.repeat(4096)}`).big).toHaveLength(4096);
  });

  it('never throws, whatever the header', () => {
    let seed = 3;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 1000; i++) {
      const junk = Array.from({ length: Math.floor(next() * 60) }, () => String.fromCharCode(Math.floor(next() * 300))).join('');
      expect(() => parseCookies(junk)).not.toThrow();
    }
  });
});

describe('serialiseCookie', () => {
  it('is HttpOnly, SameSite=Strict and Path=/ always', () => {
    expect(serialiseCookie('session', 'abc', { secure: false })).toBe('session=abc; Path=/; HttpOnly; SameSite=Strict');
  });

  it('adds Secure only when asked, and Max-Age when given', () => {
    expect(serialiseCookie('s', 'v', { secure: true })).toBe('s=v; Path=/; HttpOnly; SameSite=Strict; Secure');
    expect(serialiseCookie('s', 'v', { secure: true, maxAgeSeconds: 600 })).toBe('s=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=600; Secure');
    expect(serialiseCookie('s', 'v', { secure: false, maxAgeSeconds: 0 })).toContain('Max-Age=0');
  });

  it('writes what parseCookies reads back, for a real token', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
    expect(parseCookies(serialiseCookie('session', token, { secure: false })).session).toBe(token);
  });

  it.each([['bad name'], ['a;b'], [''], ['x='], ['é'], ['n'.repeat(65)]])('refuses the name %j', (name) => {
    expect(() => serialiseCookie(name, 'v', { secure: false })).toThrow(TypeError);
  });

  it.each([['a b'], ['a;b'], ['a,b'], ['a"b'], ['a\\b'], ['line\nbreak'], ['é'], ['x'.repeat(4097)]])('refuses the value %j, so a header cannot be injected', (value) => {
    expect(() => serialiseCookie('s', value, { secure: false })).toThrow(TypeError);
  });

  it('refuses a Max-Age that is not whole seconds', () => {
    for (const maxAgeSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => serialiseCookie('s', 'v', { secure: false, maxAgeSeconds })).toThrow(TypeError);
  });

  it('allows an empty value (used to clear)', () => {
    expect(serialiseCookie('s', '', { secure: false })).toMatch(/^s=; /);
  });
});

describe('clearCookie', () => {
  it('expires the cookie at once, with the same attributes so the browser matches it', () => {
    expect(clearCookie('session', { secure: false })).toBe('session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(clearCookie('session', { secure: true })).toContain('Secure');
  });
});
