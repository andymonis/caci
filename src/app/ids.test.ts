import { describe, expect, it } from 'vitest';
import { createItemIdGenerator } from './ids.js';

// The same rules the categoriser applies to the note id, and the library's own id limit.
const SAFE_FOR_PROMPT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sequence = (...values: string[]) => {
  let i = 0;
  return () => values[i++ % values.length] as string;
};

describe('createItemIdGenerator', () => {
  it('is deterministic with a fixed clock and random source', () => {
    const make = () => createItemIdGenerator({ now: () => 1_760_000_000_000, random: sequence('aaaaaa', 'bbbbbb') });
    const a = make();
    const b = make();
    expect([a(), a()]).toEqual([b(), b()]);
    expect(a()).toBe(`note-${(1_760_000_000_000).toString(36).padStart(9, '0')}-02-aaaaaa`);
  });

  it('has the documented shape: prefix, time, counter, random tail', () => {
    const next = createItemIdGenerator({ now: () => 1_000, random: () => 'abc123' });
    expect(next()).toBe(`note-${(1000).toString(36).padStart(9, '0')}-00-abc123`);
    expect(next()).toBe(`note-${(1000).toString(36).padStart(9, '0')}-01-abc123`);
  });

  it('is lowercase, within the id limits, and acceptable to the categoriser and the graph store', () => {
    const next = createItemIdGenerator();
    for (let i = 0; i < 200; i++) {
      const id = next();
      expect(id).toMatch(SAFE_FOR_PROMPT);
      expect(id).toBe(id.toLowerCase());
      expect(id.length).toBeLessThanOrEqual(40);
    }
  });

  it('sorts in creation order, across milliseconds', () => {
    let t = 5_000;
    const next = createItemIdGenerator({ now: () => t, random: () => 'zzzzzz' });
    const ids: string[] = [];
    for (const step of [0, 0, 1, 0, 7, 0, 1000, 0]) {
      t += step;
      ids.push(next());
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never repeats an id when many are made in one millisecond, even with the same random tail', () => {
    const next = createItemIdGenerator({ now: () => 42, random: () => 'same00' });
    const ids = Array.from({ length: 5000 }, next);
    expect(new Set(ids).size).toBe(5000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('borrows the next millisecond after 1,296 ids in one millisecond, and keeps the order', () => {
    const next = createItemIdGenerator({ now: () => 42, random: () => 'same00' });
    const ids = Array.from({ length: 1297 }, next);
    expect(ids[1295]).toContain('-zz-');
    expect(ids[1296]).toBe(`note-${(43).toString(36).padStart(9, '0')}-00-same00`);
  });

  it('keeps order and uniqueness if the clock steps backwards', () => {
    const times = [100, 100, 50, 50, 99, 101];
    let i = 0;
    const next = createItemIdGenerator({ now: () => times[i++] as number, random: () => 'rrrrrr' });
    const ids = times.map(() => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('two generators with different random tails do not collide on the same millisecond', () => {
    const a = createItemIdGenerator({ now: () => 9, random: () => 'aaaaaa' });
    const b = createItemIdGenerator({ now: () => 9, random: () => 'bbbbbb' });
    expect(a()).not.toBe(b());
  });

  it('real random tails differ between ids made at the same time', () => {
    const make = () => createItemIdGenerator({ now: () => 7 });
    expect(make()()).not.toBe(make()());
  });

  it('keeps its counter per generator, not globally', () => {
    const a = createItemIdGenerator({ now: () => 1, random: () => 'qqqqqq' });
    a();
    a();
    const b = createItemIdGenerator({ now: () => 1, random: () => 'qqqqqq' });
    expect(b()).toContain('-00-');
  });

  it('uses the prefix it is given', () => {
    expect(createItemIdGenerator({ prefix: 'memo', now: () => 1, random: () => 'abcdef' })()).toMatch(/^memo-/);
  });

  it.each(['', 'Note', 'a b', 'a/b', '-note', 'x'.repeat(33), 'note.1'])('rejects the prefix %j', (prefix) => {
    expect(() => createItemIdGenerator({ prefix })).toThrow(TypeError);
  });

  it('rejects a clock or random source that is not a function', () => {
    expect(() => createItemIdGenerator({ now: 5 as never })).toThrow(TypeError);
    expect(() => createItemIdGenerator({ random: 'x' as never })).toThrow(TypeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 36 ** 9])('refuses to make an id from the clock value %s', (time) => {
    expect(() => createItemIdGenerator({ now: () => time })()).toThrow(RangeError);
  });

  it('accepts a clock that gives fractional milliseconds by rounding down', () => {
    const next = createItemIdGenerator({ now: () => 1000.9, random: () => 'abcdef' });
    expect(next()).toContain((1000).toString(36).padStart(9, '0'));
  });
});
