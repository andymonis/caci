import { describe, expect, it } from 'vitest';
import { INPUT_KINDS, parseInput } from './input.js';

const bytes = new Uint8Array([1, 2, 3]);

describe('parseInput: valid inputs', () => {
  it('accepts text', () => {
    expect(parseInput({ kind: 'text', text: 'hello' })).toEqual({ ok: true, value: { kind: 'text', text: 'hello' } });
  });

  it('accepts text that is empty (the normaliser decides what is a usable note)', () => {
    expect(parseInput({ kind: 'text', text: '' }).ok).toBe(true);
  });

  it.each(['image', 'audio'] as const)('accepts %s with a media type and bytes', (kind) => {
    const r = parseInput({ kind, mediaType: 'x/y', data: bytes });
    expect(r).toEqual({ ok: true, value: { kind, mediaType: 'x/y', data: bytes } });
  });

  it('lists the kinds', () => {
    expect(INPUT_KINDS).toEqual(['text', 'image', 'audio']);
    expect(Object.isFrozen(INPUT_KINDS)).toBe(true);
  });

  it('returns a frozen copy, not the caller\'s object', () => {
    const original = { kind: 'text', text: 'hello' };
    const r = parseInput(original);
    expect(r.ok && r.value).not.toBe(original);
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });
});

describe('parseInput: what is refused', () => {
  const cases: Array<[string, unknown, string]> = [
    ['a string', 'a note', 'must be an object'],
    ['null', null, 'must be an object'],
    ['a list', [], 'must be an object'],
    ['no kind', { text: 'hi' }, 'input.kind'],
    ['an unknown kind', { kind: 'video', data: bytes }, '"video"'],
    ['a kind that is not text', { kind: 5 }, 'input.kind'],
    ['a prototype-style kind', { kind: 'constructor' }, 'input.kind'],
    ['text with no text', { kind: 'text' }, 'input.text'],
    ['text that is not text', { kind: 'text', text: 5 }, 'input.text'],
    ['text with an extra field', { kind: 'text', text: 'hi', language: 'en' }, 'unknown field "language"'],
    ['text carrying image fields', { kind: 'text', text: 'hi', data: bytes }, 'unknown field "data"'],
    ['an image with no media type', { kind: 'image', data: bytes }, 'mediaType'],
    ['an image with an empty media type', { kind: 'image', mediaType: '', data: bytes }, 'mediaType'],
    ['an image with no bytes', { kind: 'image', mediaType: 'image/png' }, 'Uint8Array'],
    ['an image whose bytes are a list', { kind: 'image', mediaType: 'image/png', data: [1, 2] }, 'Uint8Array'],
    ['audio with text in it', { kind: 'audio', mediaType: 'audio/mp3', data: bytes, text: 'hi' }, 'unknown field "text"'],
  ];
  it.each(cases)('%s', (_n, value, text) => {
    const r = parseInput(value);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    if (!r.ok) expect(r.error.message).toContain(text);
  });

  it('never throws, even for hostile objects', () => {
    const getter = { kind: 'text', get text(): never { throw new Error('boom'); } };
    expect(parseInput(getter)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    expect(parseInput(proxy)).toMatchObject({ ok: false });
  });
});
