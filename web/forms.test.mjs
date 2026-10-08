import { describe, expect, it } from 'vitest';
import { checkLogin, checkRegister, DISPLAY_NAME_MAX, EMAIL_MAX, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from './forms.js';

const GOOD = { username: 'Ann', displayName: '  Ann A  ', email: ' ann@example.com ', password: 'correct horse 7 staple' };
const chr = String.fromCharCode;
const withField = (field, value) => ({ ...GOOD, [field]: value });
const errorsOf = (input) => {
  const r = checkRegister(input);
  expect(r.ok).toBe(false);
  return r.errors;
};

describe('registering: what is accepted', () => {
  it('cleans the values: the username lower-cased and trimmed, the display name and email trimmed, the password untouched', () => {
    const r = checkRegister(GOOD);
    expect(r).toEqual({ ok: true, value: { username: 'ann', displayName: 'Ann A', email: 'ann@example.com', password: 'correct horse 7 staple' } });
    expect(Object.isFrozen(r.value)).toBe(true);
  });

  it('the email is optional: left out, empty, spaces or null all mean none, and the key is not there', () => {
    for (const email of [undefined, null, '', '   ']) {
      const r = checkRegister(withField('email', email));
      expect(r.ok).toBe(true);
      expect('email' in r.value).toBe(false);
    }
  });

  it('the password is never trimmed or changed, and spaces inside and around it count', () => {
    const r = checkRegister(withField('password', '  twelve chars  '));
    expect(r.ok).toBe(true);
    expect(r.value.password).toBe('  twelve chars  ');
  });
});

describe('registering: the username', () => {
  it('is 3 to 32 characters', () => {
    expect(USERNAME_MIN).toBe(3);
    expect(USERNAME_MAX).toBe(32);
    expect(checkRegister(withField('username', 'abc')).ok).toBe(true);
    expect(checkRegister(withField('username', 'a'.repeat(32))).ok).toBe(true);
    expect(errorsOf(withField('username', 'ab')).username).toBe('A username is 3 to 32 characters.');
    expect(errorsOf(withField('username', 'a'.repeat(33))).username).toBe('A username is 3 to 32 characters.');
  });

  it('uses letters, digits and . _ - only, whatever the case it is typed in', () => {
    expect(checkRegister(withField('username', 'A.b_c-9')).value.username).toBe('a.b_c-9');
    for (const bad of ['has space', 'ann!', 'ann@home', 'añn', 'an/n', 'ann\nx', '<b>x</b>', 'ａｎｎ']) expect(errorsOf(withField('username', bad)).username, JSON.stringify(bad)).toBe('A username can use letters, digits, ".", "_" and "-" only.');
  });

  it('must be there', () => {
    for (const bad of [undefined, null, 5, '', '   ', {}]) expect(errorsOf(withField('username', bad)).username, String(bad)).toBe('Enter a username.');
  });
});

describe('registering: the display name', () => {
  it('is 1 to 80 characters counted as characters, not code units', () => {
    expect(DISPLAY_NAME_MAX).toBe(80);
    expect(checkRegister(withField('displayName', 'x'.repeat(80))).ok).toBe(true);
    expect(checkRegister(withField('displayName', '😀'.repeat(80))).ok).toBe(true);
    expect(errorsOf(withField('displayName', 'x'.repeat(81))).displayName).toBe('A display name is at most 80 characters.');
    expect(errorsOf(withField('displayName', '😀'.repeat(81))).displayName).toBe('A display name is at most 80 characters.');
  });

  it('must be there, and may not hold control characters', () => {
    for (const bad of [undefined, null, 5, '', '   ']) expect(errorsOf(withField('displayName', bad)).displayName, String(bad)).toBe('Enter the name to show.');
    for (const code of [0, 7, 9, 10, 13, 0x7f, 0x85, 0x2028, 0x2029, 0xfeff]) expect(errorsOf(withField('displayName', `a${chr(code)}b`)).displayName, String(code)).toBe('A display name cannot contain control characters.');
  });

  it('markup is just text here: it is accepted and kept exactly as typed (the page only ever shows it as text)', () => {
    expect(checkRegister(withField('displayName', '<img src=x onerror=alert(1)>')).value.displayName).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('registering: the email', () => {
  it('needs the shape a@b.c, no spaces, at most 254 characters', () => {
    expect(EMAIL_MAX).toBe(254);
    for (const good of ['a@b.co', 'first.last+tag@sub.example.org']) expect(checkRegister(withField('email', good)).ok, good).toBe(true);
    for (const bad of ['plain', 'a@b', 'a@.co', '@b.co', 'a b@c.co', 'a@b.', 5, {}, `a@${'b'.repeat(250)}.co`]) expect(errorsOf(withField('email', bad)).email, String(bad)).toBe('That does not look like an email address.');
    const edge = `${'a'.repeat(EMAIL_MAX - 5)}@b.co`;
    expect(edge).toHaveLength(EMAIL_MAX);
    expect(checkRegister(withField('email', edge)).ok).toBe(true);
    expect(checkRegister(withField('email', `a${edge}`)).ok).toBe(false);
  });

  it('no control characters', () => {
    expect(errorsOf(withField('email', `a${chr(7)}@b.co`)).email).toBe('That does not look like an email address.');
  });
});

describe('registering: the password', () => {
  it('is 12 to 128 characters, counted as the service counts them (after normalising, by character)', () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
    expect(checkRegister(withField('password', 'x'.repeat(12))).ok).toBe(true);
    expect(checkRegister(withField('password', 'x'.repeat(128))).ok).toBe(true);
    expect(errorsOf(withField('password', 'x'.repeat(11))).password).toBe('A password needs at least 12 characters.');
    expect(errorsOf(withField('password', 'x'.repeat(129))).password).toBe('A password can have at most 128 characters.');
    expect(checkRegister(withField('password', '😀'.repeat(12))).ok).toBe(true); // 12 characters, 24 code units
    expect(errorsOf(withField('password', '😀'.repeat(11))).password).toBe('A password needs at least 12 characters.');
    expect(checkRegister(withField('password', 'ａ'.repeat(12))).ok).toBe(true); // full-width letters normalise to the same count
  });

  it('counts what the service counts after normalising: a ligature is two characters, a letter with a separate accent is one', () => {
    const accent = chr(0x301);
    expect(checkRegister(withField('password', '\ufb01'.repeat(6))).ok).toBe(true); // six ligatures are twelve characters once normalised
    expect(errorsOf(withField('password', '\ufb01'.repeat(5))).password).toBe('A password needs at least 12 characters.');
    expect(checkRegister(withField('password', `e${accent}`.repeat(12))).ok).toBe(true);
    expect(errorsOf(withField('password', `e${accent}`.repeat(11))).password).toBe('A password needs at least 12 characters.'); // 22 code points, 11 characters
  });

  it('must be there', () => {
    for (const bad of [undefined, null, 5, '']) expect(errorsOf(withField('password', bad)).password, String(bad)).toBe('Choose a password of 12 to 128 characters.');
  });

  it('is never put in a message', () => {
    const secret = 'short secret';
    const errors = errorsOf(withField('password', secret.slice(0, 5)));
    expect(JSON.stringify(errors)).not.toContain(secret.slice(0, 5));
  });
});

describe('registering: everything at once', () => {
  it('reports every field that is wrong, and only those', () => {
    const errors = errorsOf({ username: 'a', displayName: '', email: 'x', password: 'short' });
    expect(Object.keys(errors).sort()).toEqual(['displayName', 'email', 'password', 'username']);
    expect(Object.keys(errorsOf(withField('username', 'a')))).toEqual(['username']);
    expect(Object.isFrozen(errors)).toBe(true);
  });

  it('copes with anything: no input, no object, odd values', () => {
    for (const input of [undefined, null, 5, 'x', [], () => 0]) {
      const r = checkRegister(input);
      expect(r.ok).toBe(false);
      expect(Object.keys(r.errors).sort()).toEqual(['displayName', 'password', 'username']);
    }
  });
});

describe('signing in', () => {
  it('needs a username (trimmed, lower-cased) and a password (as typed); there is no password policy here', () => {
    expect(checkLogin({ username: ' Ann ', password: 'x' })).toEqual({ ok: true, value: { username: 'ann', password: 'x' } });
    expect(checkLogin({ username: 'ann', password: '  ' }).value.password).toBe('  ');
  });

  it('says what is missing', () => {
    expect(checkLogin({ username: '', password: '' })).toEqual({ ok: false, errors: { username: 'Enter your username.', password: 'Enter your password.' } });
    expect(checkLogin({ username: 'ann' }).errors).toEqual({ password: 'Enter your password.' });
    expect(checkLogin({ password: 'x' }).errors).toEqual({ username: 'Enter your username.' });
    for (const input of [undefined, null, 5]) expect(checkLogin(input).ok).toBe(false);
    expect(checkLogin({ username: 5, password: 5 }).ok).toBe(false);
  });
});
