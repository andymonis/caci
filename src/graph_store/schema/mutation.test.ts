import { describe, expect, it } from 'vitest';
import { mutationSchema } from './mutation.js';

const specExample = {
  version: 1,
  kind: 'mutation',
  graphId: 'user_42',
  requestId: 'b7c1-1',
  createIfMissing: true,
  ops: [
    { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Q3 plan' } },
    { op: 'upsertNode', partition: 'category', id: 'planning' },
    { op: 'link', item: 'note-1', category: 'planning', weight: 0.8 },
    { op: 'unlink', item: 'note-1', category: 'drafts' },
    { op: 'deleteNode', partition: 'item', id: 'note-0' },
  ],
};

function failurePath(input: unknown) {
  const r = mutationSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.error?.issues[0]?.path;
}

describe('mutationSchema', () => {
  it("parses the spec's mutation example", () => {
    expect(mutationSchema.safeParse(specExample).success).toBe(true);
  });

  it('defaults mode to replace and ensureNodes to false', () => {
    const r = mutationSchema.parse({
      version: 1,
      kind: 'mutation',
      graphId: 'g',
      ops: [
        { op: 'upsertNode', partition: 'item', id: 'a' },
        { op: 'link', item: 'a', category: 'c' },
      ],
    });
    expect(r.createIfMissing).toBe(false);
    expect(r.ops[0]).toMatchObject({ op: 'upsertNode', mode: 'replace' });
    expect(r.ops[1]).toMatchObject({ op: 'link', ensureNodes: false });
  });

  it('rejects an unknown op with a path to it', () => {
    const bad = { ...specExample, ops: [specExample.ops[0], { op: 'explode', id: 'x' }] };
    expect(failurePath(bad)?.slice(0, 2)).toEqual(['ops', 1]);
  });

  it('rejects a missing field with a path to it', () => {
    const bad = {
      ...specExample,
      ops: [{ op: 'link', item: 'note-1' }],
    };
    expect(failurePath(bad)).toEqual(['ops', 0, 'category']);
  });

  it('rejects kind: query', () => {
    expect(failurePath({ ...specExample, kind: 'query' })).toEqual(['kind']);
  });

  it('rejects unknown keys so typos do not pass silently', () => {
    const bad = { ...specExample, ops: [{ op: 'link', item: 'a', category: 'c', ensureNode: true }] };
    expect(mutationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a bad partition, empty id and non-finite weight', () => {
    const ops = (op: object) => ({ ...specExample, ops: [op] });
    expect(mutationSchema.safeParse(ops({ op: 'deleteNode', partition: 'edge', id: 'a' })).success).toBe(false);
    expect(mutationSchema.safeParse(ops({ op: 'deleteNode', partition: 'item', id: '' })).success).toBe(false);
    expect(
      mutationSchema.safeParse(ops({ op: 'link', item: 'a', category: 'c', weight: Infinity })).success,
    ).toBe(false);
  });

  describe('graphId character set (safe for file names)', () => {
    const withGraphId = (graphId: unknown) => ({ ...specExample, graphId });

    it.each(['a', '0', 'user_42', 'a-b_c-9', 'x'.repeat(128)])('accepts %s', (id) => {
      expect(mutationSchema.safeParse(withGraphId(id)).success).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['upper case', 'Graph'],
      ['a slash', 'a/b'],
      ['a parent path', '../x'],
      ['a dot', 'a.b'],
      ['a space', 'a b'],
      ['non-ASCII text', 'ünï'],
      ['a leading dash', '-a'],
      ['a leading underscore', '_a'],
      ['129 characters', 'x'.repeat(129)],
      ['a number', 7],
    ])('rejects %s with a path to graphId', (_name, bad) => {
      const r = mutationSchema.safeParse(withGraphId(bad));
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['graphId']);
    });
  });

});
