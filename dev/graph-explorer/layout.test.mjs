import { describe, expect, it } from 'vitest';
import { computeLayout, describeDiff, diffGraphs, edgeKey, edgePath, mergeOrder, nodeKey, shortLabel } from './public/layout.js';

const graph = (items = [], categories = [], edges = []) => ({
  items: items.map((id) => ({ partition: 'item', id })),
  categories: categories.map((id) => ({ partition: 'category', id })),
  edges: edges.map(([item, category, weight]) => ({ item, category, ...(weight === undefined ? {} : { weight }) })),
});

describe('mergeOrder', () => {
  it('keeps existing ids in place and appends new ones (sorted), so nodes never jump', () => {
    expect(mergeOrder(['b', 'a'], ['a', 'b', 'd', 'c'])).toEqual(['b', 'a', 'c', 'd']);
  });

  it('drops ids that are gone and does not bring them back in the old position', () => {
    const afterDelete = mergeOrder(['a', 'b', 'c'], ['a', 'c']);
    expect(afterDelete).toEqual(['a', 'c']);
    expect(mergeOrder(afterDelete, ['a', 'b', 'c'])).toEqual(['a', 'c', 'b']);
  });

  it('handles empty input', () => {
    expect(mergeOrder([], [])).toEqual([]);
    expect(mergeOrder([], ['z', 'a'])).toEqual(['a', 'z']);
  });
});

describe('computeLayout', () => {
  it('puts items in the left column and categories in the right column', () => {
    const { nodes, width } = computeLayout(graph(['a', 'b'], ['x']));
    expect(nodes.get(nodeKey('item', 'a')).x).toBeLessThan(width / 2);
    expect(nodes.get(nodeKey('category', 'x')).x).toBeGreaterThan(width / 2);
    expect(nodes.get(nodeKey('item', 'a')).x).toBe(nodes.get(nodeKey('item', 'b')).x);
  });

  it('keeps the given order top to bottom with an even gap', () => {
    const { nodes } = computeLayout(graph(['c', 'a', 'b'], []), { gap: 40 });
    const ys = ['c', 'a', 'b'].map((id) => nodes.get(nodeKey('item', id)).y);
    expect(ys[1] - ys[0]).toBe(40);
    expect(ys[2] - ys[1]).toBe(40);
  });

  it('keeps nodes inside the canvas, however many there are', () => {
    const many = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const { nodes, height } = computeLayout(graph(many, ['c']));
    for (const node of nodes.values()) {
      expect(node.y).toBeGreaterThan(0);
      expect(node.y).toBeLessThan(height);
    }
  });

  it('centres a short column against a taller one', () => {
    const { nodes } = computeLayout(graph(['a', 'b', 'c'], ['only']), { minHeight: 300, top: 0, bottom: 0, gap: 50 });
    const only = nodes.get(nodeKey('category', 'only')).y;
    const middle = nodes.get(nodeKey('item', 'b')).y;
    expect(only).toBe(middle);
  });

  it('draws an edge between the exact positions of its two nodes', () => {
    const { nodes, edges } = computeLayout(graph(['a'], ['x'], [['a', 'x', 2]]));
    const [edge] = edges;
    expect(edge.key).toBe(edgeKey('a', 'x'));
    expect([edge.x1, edge.y1]).toEqual([nodes.get('item:a').x, nodes.get('item:a').y]);
    expect([edge.x2, edge.y2]).toEqual([nodes.get('category:x').x, nodes.get('category:x').y]);
    expect(edge.weight).toBe(2);
  });

  it('skips an edge whose end is missing instead of drawing it to nowhere', () => {
    expect(computeLayout(graph(['a'], [], [['a', 'ghost']])).edges).toEqual([]);
  });

  it('copes with an empty graph', () => {
    const layout = computeLayout(graph());
    expect(layout.nodes.size).toBe(0);
    expect(layout.edges).toEqual([]);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const g = graph(['a', 'b'], ['x', 'y'], [['a', 'x'], ['b', 'y']]);
    expect(computeLayout(g)).toEqual(computeLayout(g));
  });
});

describe('edgePath', () => {
  it('is a cubic curve from the item to the category', () => {
    expect(edgePath(10, 20, 110, 80)).toBe('M 10 20 C 60 20, 60 80, 110 80');
  });
});

describe('diffGraphs', () => {
  it('treats everything as added when there is no previous snapshot', () => {
    const diff = diffGraphs(null, graph(['a'], ['x'], [['a', 'x']]));
    expect(diff.nodes.added.sort()).toEqual(['category:x', 'item:a']);
    expect(diff.edges.added).toEqual([edgeKey('a', 'x')]);
  });

  it('reports added, removed and changed nodes and edges', () => {
    const before = {
      items: [{ id: 'a', data: { v: 1 } }, { id: 'b' }],
      categories: [{ id: 'x' }],
      edges: [{ item: 'a', category: 'x', weight: 1 }, { item: 'b', category: 'x' }],
    };
    const after = {
      items: [{ id: 'a', data: { v: 2 } }, { id: 'c' }],
      categories: [{ id: 'x' }],
      edges: [{ item: 'a', category: 'x', weight: 5 }, { item: 'c', category: 'x' }],
    };
    const diff = diffGraphs(before, after);
    expect(diff.nodes).toEqual({ added: ['item:c'], removed: ['item:b'], changed: ['item:a'] });
    expect(diff.edges).toEqual({ added: [edgeKey('c', 'x')], removed: [edgeKey('b', 'x')], changed: [edgeKey('a', 'x')] });
  });

  it('reports nothing when nothing changed', () => {
    const g = graph(['a'], ['x'], [['a', 'x', 1]]);
    const diff = diffGraphs(g, structuredClone(g));
    expect(describeDiff(diff)).toBe('no change');
  });
});

describe('describeDiff', () => {
  it('summarises in plain words', () => {
    const diff = {
      nodes: { added: ['a', 'b'], removed: ['c'], changed: [] },
      edges: { added: ['e'], removed: ['f', 'g'], changed: ['h'] },
    };
    expect(describeDiff(diff)).toBe('+2 nodes, -1 node, +1 edge, -2 edges, ~1 edge updated');
  });
});

describe('shortLabel', () => {
  it('leaves short ids alone', () => {
    expect(shortLabel('health')).toBe('health');
    expect(shortLabel('a'.repeat(18))).toBe('a'.repeat(18));
    expect(shortLabel('')).toBe('');
  });
  it('shortens long ids to the limit, keeping the start and the end', () => {
    const label = shortLabel('note-0muv2wl8o-00-tqymze');
    expect([...label]).toHaveLength(18);
    expect(label).toBe('note-0muv…0-tqymze'); // 9 characters of the start, an ellipsis, 8 of the end
    expect(label.startsWith('note-0mu')).toBe(true);
    expect(label.endsWith('-tqymze')).toBe(true);
    expect(label).toContain('…');
  });
  it('two ids that differ only at the end stay distinguishable', () => {
    expect(shortLabel('note-0muv2wl8o-00-tqymze')).not.toBe(shortLabel('note-0muv2wl8o-00-tqymzf'));
  });
  it('respects a different limit and never splits a character', () => {
    expect([...shortLabel('abcdefghij', 5)]).toHaveLength(5);
    const emoji = shortLabel('😀'.repeat(30), 10);
    expect([...emoji]).toHaveLength(10);
    expect(emoji).not.toMatch(/\ufffd/);
  });
  it('turns anything into text', () => {
    expect(shortLabel(42)).toBe('42');
  });
});
