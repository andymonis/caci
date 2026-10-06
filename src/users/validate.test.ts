import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS, parseDisplayName, parseEmail, parsePassword, parseUsername } from './validate.js';

const fail = (r: { ok: boolean; error?: { code: string; field?: string; message: string } }, field: string) => {
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe('INVALID_INPUT');
  expect(r.error?.field).toBe(field);
  expect(r.error?.message.length).toBeGreaterThan(0);
};
const value = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok).toBe(true);
  return r.value as T;
};
const ch = (...codes: number[]) => String.fromCharCode(...codes);

describe('usernames', () => {
  it('are lower-cased, so Ann and ann are one account', () => {
    expect(value(parseUsername('Ann'))).toBe('ann');
    expect(value(parseUsername('ANN.Smith_01-x'))).toBe('ann.smith_01-x');
  });

  it('may be 3 to 32 characters', () => {
    expect(value(parseUsername('abc'))).toBe('abc');
    expect(value(parseUsername('a'.repeat(32)))).toBe('a'.repeat(32));
    fail(parseUsername('ab'), 'username');
    fail(parseUsername('a'.repeat(33)), 'username');
    fail(parseUsername(''), 'username');
  });

  it.each(['has space', 'a/b', '../x', 'ann@home', 'ünder', 'ann\n', 'a\u0000b', '名前名前', 'ann!', 'a:b', ' ann', 'ann '])('refuses %j', (name) => {
    fail(parseUsername(name), 'username');
  });

  it('refuses anything that is not text', () => {
    for (const bad of [undefined, null, 5, {}, ['ann']]) fail(parseUsername(bad), 'username');
  });

  it('does not let a character that lower-cases to several characters slip through', () => {
    fail(parseUsername(ch(0x130) + 'ab'), 'username'); // dotted capital I
  });
});

describe('display names', () => {
  it('are trimmed, 1 to 80 characters', () => {
    expect(value(parseDisplayName('  Ann Smith  '))).toBe('Ann Smith');
    expect(value(parseDisplayName('名'))).toBe('名');
    expect(value(parseDisplayName('x'.repeat(80)))).toBe('x'.repeat(80));
    fail(parseDisplayName('x'.repeat(81)), 'displayName');
    fail(parseDisplayName(''), 'displayName');
    fail(parseDisplayName('   '), 'displayName');
  });

  it('count characters, not UTF-16 units', () => {
    expect(value(parseDisplayName('😀'.repeat(80)))).toBe('😀'.repeat(80));
    fail(parseDisplayName('😀'.repeat(81)), 'displayName');
  });

  it('refuse control characters, line separators and the byte order mark', () => {
    for (const code of [0, 7, 10, 13, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0xfeff]) fail(parseDisplayName(`Ann${ch(code)}Smith`), 'displayName');
  });

  it('refuse what is not text', () => {
    for (const bad of [undefined, null, 5, {}]) fail(parseDisplayName(bad), 'displayName');
  });
});

describe('email', () => {
  it('is optional', () => {
    expect(value(parseEmail(undefined))).toBeUndefined();
  });

  it('accepts ordinary addresses, trimmed', () => {
    expect(value(parseEmail(' ann@example.com '))).toBe('ann@example.com');
    expect(value(parseEmail('a.b+tag@mail.example.co.uk'))).toBe('a.b+tag@mail.example.co.uk');
  });

  it.each(['', 'ann', 'ann@', '@example.com', 'ann@example', 'ann@.com', 'ann@example.', 'a nn@example.com', 'ann@exa mple.com', 'ann@@example.com', 'ann@example.com\nBcc: x@y.com'])('refuses %j', (email) => {
    fail(parseEmail(email), 'email');
  });

  it('is at most 254 characters', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(180)}.com`;
    expect(long.length).toBeLessThanOrEqual(254);
    expect(value(parseEmail(long))).toBe(long);
    fail(parseEmail(`${'a'.repeat(64)}@${'b'.repeat(190)}.com`), 'email');
  });

  it('is exactly 254 characters at most', () => {
    const at = (n: number) => `${'a'.repeat(64)}@${'b'.repeat(n - 64 - 1 - 4)}.com`;
    expect(at(254)).toHaveLength(254);
    expect(value(parseEmail(at(254)))).toBe(at(254));
    fail(parseEmail(at(255)), 'email');
  });

  it('refuses control characters that are not spaces', () => {
    for (const code of [0, 1, 7, 0x7f, 0x85, 0x2028, 0xfeff]) fail(parseEmail(`ann${ch(code)}x@example.com`), 'email');
  });

  it('refuses what is not text, including null', () => {
    for (const bad of [null, 5, {}, ['a@b.co']]) fail(parseEmail(bad), 'email');
  });
});

describe('passwords', () => {
  const good = 'correct horse 7 staple';

  it('accept a good one and return it normalised (NFKC)', () => {
    expect(value(parsePassword(good))).toBe(good);
    expect(value(parsePassword('ｐａｓｓｗｏｒｄ-ＸＹＺ-1'))).toBe('password-XYZ-1'); // full-width forms fold to ASCII
  });

  it('are 12 to 128 characters, counted after normalisation', () => {
    expect(value(parsePassword('a1b2c3d4e5f6'))).toBe('a1b2c3d4e5f6');
    fail(parsePassword('a1b2c3d4e5f'), 'password');
    expect(value(parsePassword('ab'.repeat(64)))).toBe('ab'.repeat(64));
    fail(parsePassword('ab'.repeat(64) + 'c'), 'password');
    fail(parsePassword('ａｂ'.repeat(5) + 'x'), 'password'); // 11 once folded
  });

  it('count characters, not UTF-16 units', () => {
    expect(value(parsePassword('😀😁😂🤣😃😄😅😆😉😊😋😎'))).toHaveLength(24);
    fail(parsePassword('😀😁😂🤣😃😄😅😆😉😊😋'), 'password');
  });

  it('refuse control characters', () => {
    for (const code of [0, 9, 10, 13, 0x7f, 0x85]) fail(parsePassword(`correct horse${ch(code)}staple`), 'password');
  });

  it('refuse one character repeated', () => {
    fail(parsePassword('aaaaaaaaaaaa'), 'password');
    fail(parsePassword('AaAaAaAaAaAa'.replace(/a/gi, 'a')), 'password');
    fail(parsePassword('111111111111'), 'password');
    expect(value(parsePassword('aaaaaaaaaaab'))).toBe('aaaaaaaaaaab');
  });

  it('refuse the username, whatever its case, but not a password that merely contains it', () => {
    fail(parsePassword('annsmith-account', { username: 'Annsmith-Account' }), 'password');
    fail(parsePassword('ANNSMITH-ACCOUNT', { username: 'annsmith-account' }), 'password');
    expect(value(parsePassword('annsmith-account-77', { username: 'annsmith-account' }))).toBe('annsmith-account-77');
    expect(value(parsePassword('annsmith-account', {}))).toBe('annsmith-account'); // no username given: nothing to compare
  });

  it('refuse every very common password, in any case', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(20);
    for (const common of COMMON_PASSWORDS) {
      expect(common.length).toBeGreaterThanOrEqual(12); // shorter ones are refused by length already
      fail(parsePassword(common), 'password');
      fail(parsePassword(common.toUpperCase()), 'password');
    }
  });

  it('refuse what is not text', () => {
    for (const bad of [undefined, null, 5, {}, ['correct horse staple']]) fail(parsePassword(bad), 'password');
  });

  it('never repeat the password in a message', () => {
    const secret = 'qwertyuiop12'; // refused as common
    const cases = [parsePassword(secret), parsePassword('short'), parsePassword('aaaaaaaaaaaa'), parsePassword(`x${ch(0)}yyyyyyyyyyyy`), parsePassword('annsmith-account', { username: 'annsmith-account' })];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) for (const text of [r.error.message, JSON.stringify(r.error)]) for (const pw of [secret, 'short', 'aaaaaaaaaaaa', 'annsmith-account']) expect(text).not.toContain(pw);
    }
  });
});
