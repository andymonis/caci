import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden.mjs';
import { idealReply } from './scripted.mjs';

const linksOf = (reply) => reply.ops.filter((o) => o.op === 'link').map((o) => o.category);
const newOf = (reply) => reply.ops.filter((o) => o.op === 'upsertNode' && o.partition === 'category').map((o) => o.id);
const cats = (...ids) => ids.map((id) => ({ id }));

describe('idealReply', () => {
  it('always creates the note\'s item with the id it was given', () => {
    const reply = idealReply({ categories: cats('a'), expect: {} }, 'note-9');
    expect(reply.ops[0]).toMatchObject({ op: 'upsertNode', partition: 'item', id: 'note-9' });
    expect(reply.ops.filter((o) => o.op === 'link').every((o) => o.item === 'note-9')).toBe(true);
    expect(reply.rationale).toBeTruthy();
  });
  it('links what must be reused, creating nothing', () => {
    const reply = idealReply({ categories: cats('a', 'b', 'c'), expect: { reuse: ['b', 'c'] } }, 'n');
    expect(linksOf(reply)).toEqual(['b', 'c']);
    expect(newOf(reply)).toEqual([]);
  });
  it('with nothing required, links the first category that is not to be avoided', () => {
    expect(linksOf(idealReply({ categories: cats('a', 'b'), expect: {} }, 'n'))).toEqual(['a']);
    expect(linksOf(idealReply({ categories: cats('a', 'b'), expect: { avoidReuse: ['a'] } }, 'n'))).toEqual(['b']);
  });
  it('creates a category when the case asks for one, or when there is nothing to link to', () => {
    const asked = idealReply({ categories: cats('a'), expect: { newCategories: { min: 1 } } }, 'n');
    expect(newOf(asked)).toEqual(['eval-new-category']);
    expect(linksOf(asked)).toEqual(['eval-new-category']);
    const empty = idealReply({ categories: [], expect: {} }, 'n');
    expect(newOf(empty)).toEqual(['eval-new-category']);
    const allAvoided = idealReply({ categories: cats('a'), expect: { avoidReuse: ['a'] } }, 'n');
    expect(newOf(allAvoided)).toEqual(['eval-new-category']);
  });
  it('creates the category before it links to it', () => {
    const ops = idealReply({ categories: [], expect: {} }, 'n').ops;
    expect(ops.findIndex((o) => o.partition === 'category')).toBeLessThan(ops.findIndex((o) => o.op === 'link'));
  });
  it('never makes more links than the case allows', () => {
    const reply = idealReply({ categories: cats('a', 'b'), expect: { reuse: ['a', 'b'], newCategories: { min: 1 }, links: { max: 2 } } }, 'n');
    expect(linksOf(reply)).toHaveLength(2);
    expect(linksOf(idealReply({ categories: cats('a', 'b'), expect: { reuse: ['a', 'b'], links: { max: 1 } } }, 'n'))).toHaveLength(1);
  });
  it('allows three links by default', () => {
    expect(linksOf(idealReply({ categories: cats('a', 'b', 'c', 'd'), expect: { reuse: ['a', 'b', 'c', 'd'] } }, 'n'))).toHaveLength(3);
  });
  it('is the same every time and does not change the case', () => {
    const c = GOLDEN[0];
    const before = JSON.stringify(c);
    expect(idealReply(c, 'n')).toEqual(idealReply(c, 'n'));
    expect(JSON.stringify(c)).toBe(before);
  });
});
