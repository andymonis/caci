import { describe, expect, it } from 'vitest';
import { compareNodeRefs, isAfter, sortNodeRefs } from './query-order.js';
import type { NodeRef } from './types.js';

const item = (id: string): NodeRef => ({ partition: 'item', id });
const category = (id: string): NodeRef => ({ partition: 'category', id });

describe('result order: items first, then categories, each by id', () => {
  it('puts every item before every category, whatever the ids', () => {
    const sorted = sortNodeRefs([category('a'), item('z'), category('b'), item('a')]);
    expect(sorted).toEqual([item('a'), item('z'), category('a'), category('b')]);
  });

  it('orders ids by UTF-16 code unit, so upper case sorts before lower case', () => {
    expect(sortNodeRefs([item('b'), item('B'), item('a'), item('A')]).map((n) => n.id)).toEqual(['A', 'B', 'a', 'b']);
  });

  it('handles non-ASCII and awkward ids deterministically', () => {
    const ids = ['ünï', 'a/b', '../x', 'a b', 'z', ''];
    expect(sortNodeRefs(ids.map(item))).toEqual(sortNodeRefs([...ids].reverse().map(item)));
  });

  it('is a consistent total order: antisymmetric, transitive, and equal only for the same node', () => {
    const nodes = [item('a'), item('b'), item('B'), category('a'), category('b'), item('a')];
    for (const x of nodes) {
      expect(compareNodeRefs(x, x)).toBe(0);
      for (const y of nodes) {
        expect(Math.sign(compareNodeRefs(x, y)) + Math.sign(compareNodeRefs(y, x))).toBe(0);
        for (const z of nodes) {
          if (compareNodeRefs(x, y) <= 0 && compareNodeRefs(y, z) <= 0) expect(compareNodeRefs(x, z)).toBeLessThanOrEqual(0);
        }
      }
    }
    expect(compareNodeRefs(item('a'), category('a'))).toBeLessThan(0);
    expect(compareNodeRefs(item('a'), item('b'))).not.toBe(0);
  });

  it('does not change the array it is given', () => {
    const input = Object.freeze([category('b'), item('a')]);
    expect(() => sortNodeRefs(input)).not.toThrow();
    expect(input[0]).toEqual(category('b'));
  });

  it('isAfter means strictly after, so a cursor never repeats the node it points at', () => {
    expect(isAfter(item('b'), item('a'))).toBe(true);
    expect(isAfter(item('a'), item('a'))).toBe(false);
    expect(isAfter(item('a'), item('b'))).toBe(false);
    expect(isAfter(category('a'), item('zzz'))).toBe(true);
    expect(isAfter(item('a'), category('a'))).toBe(false);
  });
});
