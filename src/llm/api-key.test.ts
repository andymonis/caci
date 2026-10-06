import { describe, expect, it } from 'vitest';
import { ANTHROPIC_KEY_SHAPE, ANTHROPIC_KEY_VARIABLE, readAnthropicKey } from './api-key.js';

const KEY = 'sk-ant-api03-ABCDEFGHIJ-0123456789';

describe('readAnthropicKey', () => {
  it('reads the key from the variable it names, trimmed', () => {
    expect(ANTHROPIC_KEY_VARIABLE).toBe('ANTHROPIC_API_KEY');
    expect(readAnthropicKey({ ANTHROPIC_API_KEY: KEY })).toEqual({ ok: true, value: KEY });
    expect(readAnthropicKey({ ANTHROPIC_API_KEY: `  ${KEY}\n` })).toEqual({ ok: true, value: KEY });
  });

  it('says it is not set for a missing, empty or blank variable', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: undefined }, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '  \t' }]) {
      expect(readAnthropicKey(env)).toMatchObject({ ok: false, error: { code: 'CONFIG', message: 'ANTHROPIC_API_KEY is not set' } });
    }
  });

  it('refuses a key of the wrong shape, without repeating it', () => {
    for (const bad of ['short', 'has space inside it!!', 'x'.repeat(513), 'tab\tinside-the-key', 'é'.repeat(20)]) {
      const r = readAnthropicKey({ ANTHROPIC_API_KEY: bad });
      expect(r, bad.slice(0, 10)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
      if (!r.ok) expect(r.error.message).not.toContain(bad.slice(0, 8));
    }
  });

  it('shape: 8 to 512 printable characters, no spaces', () => {
    expect(ANTHROPIC_KEY_SHAPE.test('x'.repeat(8))).toBe(true);
    expect(ANTHROPIC_KEY_SHAPE.test('x'.repeat(512))).toBe(true);
    expect(ANTHROPIC_KEY_SHAPE.test('x'.repeat(7))).toBe(false);
    expect(ANTHROPIC_KEY_SHAPE.test('x'.repeat(513))).toBe(false);
  });

  it('reads only the variable it is given, never the process environment', () => {
    process.env.ANTHROPIC_API_KEY = KEY;
    try {
      expect(readAnthropicKey({})).toMatchObject({ ok: false });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
