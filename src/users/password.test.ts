import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPasswordHasher, DEFAULT_SCRYPT, type Derive } from './password.js';

const CHEAP = { N: 16, r: 1, p: 1 };
const hasher = createPasswordHasher({ params: CHEAP });

/** The second test vector of RFC 7914 (scrypt("password", "NaCl", N=1024, r=8, p=16)), first 32 bytes. */
const RFC_STORED = `scrypt$1024$8$16$${Buffer.from('NaCl').toString('base64url')}$${Buffer.from('fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162', 'hex').toString('base64url')}`;

/** A derive that records its calls and is cheap, so counts can be compared. */
function counting() {
  const calls: Array<{ password: string; salt: string; params: object }> = [];
  const derive: Derive = async (password, salt, params, keyBytes) => {
    calls.push({ password, salt: Buffer.from(salt).toString('hex'), params: { ...params } });
    return Buffer.alloc(keyBytes, password.length % 251);
  };
  return { calls, derive };
}

describe('hashing', () => {
  it('gives the self-describing format with the cost, a 16-byte salt and a 32-byte key', async () => {
    const stored = await hasher.hash('correct horse 7 staple');
    const [scheme, n, r, p, salt, key] = stored.split('$');
    expect([scheme, n, r, p]).toEqual(['scrypt', '16', '1', '1']);
    expect(Buffer.from(salt as string, 'base64url')).toHaveLength(16);
    expect(Buffer.from(key as string, 'base64url')).toHaveLength(32);
    expect(stored).not.toContain('correct');
  });

  it('uses a fresh salt every time, so the same password never gives the same string', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => hasher.hash('correct horse 7 staple')));
    expect(new Set(all).size).toBe(20);
    expect(new Set(all.map((s) => s.split('$')[4])).size).toBe(20);
  });

  it('takes its salt from the random source it is given', async () => {
    const fixed = createPasswordHasher({ params: CHEAP, randomBytes: (n) => new Uint8Array(n).fill(7) });
    expect(await fixed.hash('same same same')).toBe(await fixed.hash('same same same'));
    expect((await fixed.hash('same same same')).split('$')[4]).toBe(Buffer.alloc(16, 7).toString('base64url'));
  });

  it('refuses a password that is not text', async () => {
    await expect(hasher.hash(5 as unknown as string)).rejects.toThrow(TypeError);
    await expect(hasher.hash(undefined as unknown as string)).rejects.toThrow(TypeError);
  });

  it('works with the default cost (32 MiB of memory is allowed through)', async () => {
    const real = createPasswordHasher();
    expect(real.params).toEqual({ N: 32768, r: 8, p: 1 });
    const stored = await real.hash('correct horse 7 staple');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await real.verify('correct horse 7 staple', stored)).toBe(true);
    expect(await real.verify('correct horse 7 stapler', stored)).toBe(false);
  });

  it('the default cost is at least the documented one', () => {
    expect(DEFAULT_SCRYPT.N).toBeGreaterThanOrEqual(2 ** 15);
    expect(DEFAULT_SCRYPT.r).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_SCRYPT.p).toBeGreaterThanOrEqual(1);
  });
});

describe('verifying', () => {
  it('accepts the right password and refuses a wrong one', async () => {
    const stored = await hasher.hash('correct horse 7 staple');
    expect(await hasher.verify('correct horse 7 staple', stored)).toBe(true);
    for (const wrong of ['correct horse 7 stapl', 'Correct horse 7 staple', 'correct horse 7 staple ', '', 'x']) expect(await hasher.verify(wrong, stored), wrong).toBe(false);
  });

  it('agrees with a published scrypt test vector (RFC 7914), so the format and the maths are the real ones', async () => {
    expect(await hasher.verify('password', RFC_STORED)).toBe(true);
    expect(await hasher.verify('passwore', RFC_STORED)).toBe(false);
  });

  it('treats a password in another Unicode form as the same one (NFKC)', async () => {
    const stored = await hasher.hash('ｐａｓｓｗｏｒｄ-ＸＹＺ-1'); // full-width
    expect(await hasher.verify('password-XYZ-1', stored)).toBe(true);
    const accented = await hasher.hash('café au lait 12');
    expect(await hasher.verify('café au lait 12', accented)).toBe(true);
  });

  it('works for 128-character and non-ASCII passwords', async () => {
    for (const password of ['a'.repeat(128), '名前を忘れないように1234', '😀😁😂🤣😃😄😅😆😉😊😋😎']) {
      expect(await hasher.verify(password, await hasher.hash(password))).toBe(true);
    }
  });

  it('refuses a password that is not text, or absurdly long, without hashing', async () => {
    const c = counting();
    const h = createPasswordHasher({ params: CHEAP, derive: c.derive });
    const stored = await h.hash('correct horse 7 staple');
    c.calls.length = 0;
    for (const bad of [5, null, undefined, {}, ['a'], 'a'.repeat(1025)]) expect(await h.verify(bad as unknown as string, stored)).toBe(false);
    expect(c.calls).toEqual([]);
    expect(await h.verify('a'.repeat(1024), stored)).toBe(false);
    expect(c.calls).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['not a hash', 'hunter2'],
    ['another scheme', 'bcrypt$16$1$1$AAAAAAAA$AAAAAAAA'],
    ['missing parts', 'scrypt$16$1$1$AAAAAAAA'],
    ['extra part', `${RFC_STORED}$x`],
    ['a number that is not a number', RFC_STORED.replace('$1024$', '$10x4$')],
    ['N not a power of two', RFC_STORED.replace('$1024$', '$1000$')],
    ['N too small', RFC_STORED.replace('$1024$', '$8$')],
    ['r zero', RFC_STORED.replace('$8$16$', '$0$16$')],
    ['p zero', RFC_STORED.replace('$8$16$', '$8$0$')],
    ['p too large', RFC_STORED.replace('$8$16$', '$8$17$')],
    ['asks for more than 64 MiB', RFC_STORED.replace('$1024$8$', '$1048576$8$')],
    ['a salt that is too short', `scrypt$16$1$1$AAA$${Buffer.alloc(32).toString('base64url')}`],
    ['a salt that is too long', `scrypt$16$1$1$${Buffer.alloc(65).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`],
    ['a key of the wrong length', `scrypt$16$1$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(31).toString('base64url')}`],
    ['characters outside base64url', `scrypt$16$1$1$${Buffer.alloc(16).toString('base64url')}$${'+'.repeat(43)}`],
    ['a second spelling of the key', RFC_STORED.slice(0, -1) + (RFC_STORED.endsWith('Y') ? 'Z' : 'Y')],
    ['a very long string', 'scrypt$16$1$1$' + 'A'.repeat(600)],
  ])('treats %s as not a match and never throws', async (_name, stored) => {
    expect(await hasher.verify('password', stored)).toBe(false);
    expect(hasher.needsRehash(stored)).toBe(false);
  });

  describe('a string that would verify but is not in our form is still refused', () => {
    /** A real scrypt hash of 'password' (N=16, r=1, p=1) with the salt and key lengths asked for. */
    const real = (saltBytes: number, keyBytes: number): { salt: string; key: Buffer; stored: (key?: string) => string } => {
      const salt = Buffer.alloc(saltBytes, 3);
      const key = scryptSync('password', salt, keyBytes, { N: 16, r: 1, p: 1 });
      return { salt: salt.toString('base64url'), key, stored: (k = key.toString('base64url')) => `scrypt$16$1$1$${salt.toString('base64url')}$${k}` };
    };

    it('the control: a real hash in the right form verifies', async () => {
      expect(await hasher.verify('password', real(16, 32).stored())).toBe(true);
      expect(await hasher.verify('password', real(4, 32).stored())).toBe(true);
      expect(await hasher.verify('password', real(64, 32).stored())).toBe(true);
    });

    it('a salt shorter than 4 bytes or longer than 64', async () => {
      expect(await hasher.verify('password', real(3, 32).stored())).toBe(false);
      expect(await hasher.verify('password', real(65, 32).stored())).toBe(false);
    });

    it('a key that is not 32 bytes', async () => {
      expect(await hasher.verify('password', real(16, 31).stored())).toBe(false);
      expect(await hasher.verify('password', real(16, 33).stored())).toBe(false);
    });

    it('a second spelling of the same bytes (the spare bits of the last character)', async () => {
      const { key, stored } = real(16, 32);
      const text = key.toString('base64url');
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const lastIndex = alphabet.indexOf(text.at(-1) as string);
      const sibling = text.slice(0, -1) + (alphabet[lastIndex ^ 1] as string); // differs only in a bit that decoding ignores
      expect(Buffer.from(sibling, 'base64url').equals(key)).toBe(true);
      expect(await hasher.verify('password', stored(text))).toBe(true);
      expect(await hasher.verify('password', stored(sibling))).toBe(false);
    });
  });

  it('refuses stored values that are not text', async () => {
    for (const bad of [undefined, null, 5, {}]) expect(await hasher.verify('password', bad as unknown as string)).toBe(false);
  });

  it('never throws, whatever the stored string', async () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 500; i++) {
      const junk = Array.from({ length: Math.floor(next() * 80) }, () => String.fromCharCode(32 + Math.floor(next() * 95))).join('');
      expect(await hasher.verify('password', junk)).toBe(false);
      expect(await hasher.verify('password', `scrypt$${junk}`)).toBe(false);
    }
  });
});

describe('the work a login does', () => {
  it('a wrong password and a missing user do exactly the same work: one derivation at the current cost', async () => {
    const c = counting();
    const h = createPasswordHasher({ params: CHEAP, derive: c.derive });
    const stored = await h.hash('correct horse 7 staple');
    c.calls.length = 0;
    await h.verify('wrong wrong wrong', stored);
    const wrong = c.calls.splice(0);
    expect(await h.verifyAbsent('wrong wrong wrong')).toBe(false);
    const absent = c.calls.splice(0);
    expect(wrong).toHaveLength(1);
    expect(absent).toHaveLength(1);
    expect(absent[0]?.params).toEqual(wrong[0]?.params);
    expect(absent[0]?.password).toBe(wrong[0]?.password);
  });

  it('a missing user is always false, even if the "password" is a real one', async () => {
    expect(await hasher.verifyAbsent('correct horse 7 staple')).toBe(false);
    expect(await hasher.verifyAbsent(5 as unknown as string)).toBe(false);
  });

  it('a stored hash with weaker parameters is verified at its own cost, not the current one', async () => {
    const c = counting();
    const strong = createPasswordHasher({ params: { N: 32, r: 1, p: 1 }, derive: c.derive });
    await strong.verify('x'.repeat(12), `scrypt$16$1$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32, 12).toString('base64url')}`);
    expect(c.calls[0]?.params).toEqual({ N: 16, r: 1, p: 1 });
  });
});

describe('upgrading old hashes', () => {
  it('says a hash made with a weaker cost needs a rehash, and a current or stronger one does not', async () => {
    const weak = createPasswordHasher({ params: { N: 16, r: 1, p: 1 } });
    const current = createPasswordHasher({ params: { N: 32, r: 2, p: 1 } });
    const strong = createPasswordHasher({ params: { N: 64, r: 4, p: 2 } });
    const old = await weak.hash('correct horse 7 staple');
    expect(current.needsRehash(old)).toBe(true);
    expect(current.needsRehash(await current.hash('correct horse 7 staple'))).toBe(false);
    expect(current.needsRehash(await strong.hash('correct horse 7 staple'))).toBe(false);
  });

  it('each parameter counts on its own', async () => {
    const current = createPasswordHasher({ params: { N: 32, r: 2, p: 2 } });
    const make = (N: number, r: number, p: number) => `scrypt$${N}$${r}$${p}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;
    expect(current.needsRehash(make(32, 2, 2))).toBe(false);
    expect(current.needsRehash(make(16, 2, 2))).toBe(true);
    expect(current.needsRehash(make(32, 1, 2))).toBe(true);
    expect(current.needsRehash(make(32, 2, 1))).toBe(true);
  });
});

describe('settings', () => {
  it.each([
    [{ N: 15, r: 1, p: 1 }],
    [{ N: 24, r: 1, p: 1 }],
    [{ N: 8, r: 1, p: 1 }],
    [{ N: 16, r: 0, p: 1 }],
    [{ N: 16, r: 1, p: 0 }],
    [{ N: 16, r: 1, p: 17 }],
    [{ N: 16, r: 1.5, p: 1 }],
    [{ N: 2 ** 20, r: 8, p: 1 }],
  ])('refuses the cost %j', (params) => {
    expect(() => createPasswordHasher({ params })).toThrow(TypeError);
  });

  it('keeps its own copy of the cost', () => {
    const params = { N: 16, r: 1, p: 1 };
    const h = createPasswordHasher({ params });
    params.N = 2 ** 30;
    expect(h.params.N).toBe(16);
    expect(Object.isFrozen(h.params)).toBe(true);
  });
});

describe('secrets stay secret', () => {
  it('no error message contains the password, even when the derivation itself fails with a message that does', async () => {
    const secret = 'my very secret passphrase 42';
    const failing = createPasswordHasher({
      params: CHEAP,
      derive: async (password) => {
        throw new Error(`out of memory while hashing ${password}`);
      },
    });
    for (const attempt of [failing.hash(secret), failing.verify(secret, RFC_STORED), failing.verifyAbsent(secret)]) {
      const error = await attempt.then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain(secret);
      expect(String(error?.stack)).not.toContain(secret);
    }
  });

  it('the stored string never contains the password', async () => {
    const secret = 'my very secret passphrase 42';
    expect(await hasher.hash(secret)).not.toContain(secret);
    expect(await hasher.hash(secret)).not.toContain(Buffer.from(secret).toString('base64url'));
  });

  it('hands the derivation the normalised password, once, with a salt of 16 bytes', async () => {
    const c = counting();
    const h = createPasswordHasher({ params: CHEAP, derive: c.derive });
    await h.hash('ｐａｓｓｗｏｒｄ-ＸＹＺ-1');
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.password).toBe('password-XYZ-1');
    expect(c.calls[0]?.salt).toHaveLength(32);
  });
});
