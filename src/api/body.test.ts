import { describe, expect, it } from 'vitest';
import { isJsonContentType, parseBody } from './body.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const JSON_TYPE = 'application/json';

describe('isJsonContentType', () => {
  it('accepts application/json, in any case, with an optional UTF-8 charset', () => {
    for (const type of ['application/json', 'Application/JSON', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'application/json; charset="utf-8"', ' application/json ']) expect(isJsonContentType(type), type).toBe(true);
  });

  it('refuses everything else', () => {
    for (const type of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'application/json-patch+json', 'text/json', 'application/json; charset=latin1', 'application/json; boundary=x', 'json']) expect(isJsonContentType(type), String(type)).toBe(false);
  });
});

describe('parseBody', () => {
  it('an empty body is no body, whatever the type (logout has none)', () => {
    expect(parseBody(new Uint8Array(0), undefined)).toEqual({ ok: true, body: undefined });
    expect(parseBody(new Uint8Array(0), 'text/plain')).toEqual({ ok: true, body: undefined });
  });

  it('parses a JSON object, frozen', () => {
    const r = parseBody(bytes('{"a":1,"b":{"c":[1,2,{"d":null}]},"e":"é😀"}'), JSON_TYPE);
    expect(r).toEqual({ ok: true, body: { a: 1, b: { c: [1, 2, { d: null }] }, e: 'é😀' } });
    expect(r.ok && Object.isFrozen(r.body)).toBe(true);
  });

  it('refuses a body that is not JSON-typed with 415', () => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) expect(parseBody(bytes('{"a":1}'), type)).toMatchObject({ ok: false, status: 415 });
  });

  it('refuses invalid JSON with 400', () => {
    for (const text of ['{', '{"a":}', "{'a':1}", '{"a":1,}', 'undefined', '{"a":1}{"b":2}', '\u0000', '{"a":NaN}']) expect(parseBody(bytes(text), JSON_TYPE), text).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses invalid UTF-8 with 400', () => {
    expect(parseBody(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]), JSON_TYPE)).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('UTF-8') });
  });

  it('refuses anything that is not an object: arrays, strings, numbers, null, booleans', () => {
    for (const text of ['[]', '[{"a":1}]', '"text"', '5', 'null', 'true']) expect(parseBody(bytes(text), JSON_TYPE), text).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('object') });
  });

  it('refuses prototype-poisoning keys at any depth, in objects and inside arrays', () => {
    for (const text of ['{"__proto__":{"admin":true}}', '{"a":{"__proto__":1}}', '{"a":[{"constructor":{}}]}', '{"prototype":1}', '{"a":{"b":{"c":{"__proto__":{}}}}}']) {
      expect(parseBody(bytes(text), JSON_TYPE), text).toMatchObject({ ok: false, status: 400 });
    }
    expect(Object.prototype).not.toHaveProperty('admin');
    expect(parseBody(bytes('{"proto":1,"constructors":2,"__proto":3}'), JSON_TYPE)).toMatchObject({ ok: true });
  });

  it('refuses nesting deeper than 16, and accepts 16', () => {
    const nest = (depth: number) => '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    expect(parseBody(bytes(nest(15)), JSON_TYPE)).toMatchObject({ ok: true });
    expect(parseBody(bytes(nest(40)), JSON_TYPE)).toMatchObject({ ok: false, status: 400 });
    expect(parseBody(bytes(nest(5000)), JSON_TYPE)).toMatchObject({ ok: false, status: 400 }); // a stack-busting depth is just refused
  });

  it('does not let a key called toString or hasOwnProperty confuse anything', () => {
    expect(parseBody(bytes('{"toString":"x","hasOwnProperty":1}'), JSON_TYPE)).toMatchObject({ ok: true, body: { toString: 'x', hasOwnProperty: 1 } });
  });
});
