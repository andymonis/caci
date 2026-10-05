import { describe, expect, it } from 'vitest';
import { applyGhosts, describeFailure, FINAL_CODES, proposalHeadline, realModelSwitch } from './public/capture.js';
import { edgeKey, nodeKey } from './public/layout.js';

const graph = () => ({
  items: [{ partition: 'item', id: 'old' }],
  categories: [{ partition: 'category', id: 'health' }, { partition: 'category', id: 'travel' }],
  edges: [{ item: 'old', category: 'health', weight: 1 }],
});
const summary = (extra = {}) => ({ newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [], ...extra });
const proposal = (s, ops = []) => ({ summary: summary(s), ops });

describe('applyGhosts', () => {
  it('adds proposed items, categories and links to the drawing and marks them', () => {
    const p = proposal(
      { newItems: ['n1'], newCategories: ['fresh'], reusedCategories: ['health'], newLinks: [{ item: 'n1', category: 'fresh' }, { item: 'n1', category: 'health' }] },
      [
        { op: 'upsertNode', partition: 'item', id: 'n1', data: { title: 'T' } },
        { op: 'upsertNode', partition: 'category', id: 'fresh', data: { name: 'Fresh' } },
        { op: 'link', item: 'n1', category: 'fresh', weight: 0.8 },
        { op: 'link', item: 'n1', category: 'health', weight: 0.5 },
      ],
    );
    const r = applyGhosts(graph(), p);
    expect(r.graph.items.map((n) => n.id)).toEqual(['old', 'n1']);
    expect(r.graph.categories.map((n) => n.id)).toEqual(['health', 'travel', 'fresh']);
    expect(r.graph.edges).toEqual([{ item: 'old', category: 'health', weight: 1 }, { item: 'n1', category: 'fresh', weight: 0.8 }, { item: 'n1', category: 'health', weight: 0.5 }]);
    expect([...r.ghostNodes].sort()).toEqual([nodeKey('category', 'fresh'), nodeKey('item', 'n1')]);
    expect([...r.ghostEdges].sort()).toEqual([edgeKey('n1', 'fresh'), edgeKey('n1', 'health')].sort());
    expect([...r.reusedNodes]).toEqual([nodeKey('category', 'health')]);
    expect(r.graph.items[1].data).toEqual({ title: 'T' });
  });

  it('does not change the real graph it was given', () => {
    const g = graph();
    const before = JSON.stringify(g);
    applyGhosts(g, proposal({ newItems: ['n1'], newCategories: ['c'], newLinks: [{ item: 'n1', category: 'c' }] }));
    expect(JSON.stringify(g)).toBe(before);
  });

  it('a link to something that exists in neither place is left out of the drawing', () => {
    const r = applyGhosts(graph(), proposal({ newItems: ['n1'], newLinks: [{ item: 'n1', category: 'ghost' }, { item: 'nobody', category: 'health' }] }));
    expect(r.graph.edges).toHaveLength(1);
    expect(r.ghostEdges.size).toBe(0);
  });

  it('a link that already exists is not drawn twice (it would be replaced)', () => {
    const r = applyGhosts(graph(), proposal({ updatedItems: ['old'], newLinks: [{ item: 'old', category: 'health' }] }));
    expect(r.graph.edges).toHaveLength(1);
    expect(r.ghostEdges.size).toBe(0);
  });

  it('a proposed node that already exists is not added again', () => {
    const r = applyGhosts(graph(), proposal({ newItems: ['old'], newCategories: ['health'] }));
    expect(r.graph.items).toHaveLength(1);
    expect(r.graph.categories).toHaveLength(2);
    expect(r.ghostNodes.size).toBe(0);
  });

  it('marks existing nodes the proposal would change', () => {
    const r = applyGhosts(graph(), proposal({ updatedItems: ['old'], updatedCategories: ['travel'] }));
    expect([...r.updatedNodes].sort()).toEqual([nodeKey('category', 'travel'), nodeKey('item', 'old')]);
    expect(r.ghostNodes.size).toBe(0);
  });

  it('works on an empty graph', () => {
    const r = applyGhosts({ items: [], categories: [], edges: [] }, proposal({ newItems: ['n'], newCategories: ['c'], newLinks: [{ item: 'n', category: 'c' }] }));
    expect(r.graph.edges).toEqual([{ item: 'n', category: 'c', weight: undefined }]);
    expect(r.ghostNodes.size).toBe(2);
  });

  it('keeps the rest of the graph object (such as its info) as it was', () => {
    const g = { ...graph(), info: { itemCount: 1 } };
    expect(applyGhosts(g, proposal()).graph.info).toEqual({ itemCount: 1 });
  });
});

describe('proposalHeadline', () => {
  it('says what is proposed, with singulars and plurals', () => {
    expect(proposalHeadline(summary({ newItems: ['a'], newCategories: ['c'], reusedCategories: ['h'], newLinks: [{}, {}] }))).toBe('Proposed: 1 new item, 1 new category, reusing 1 category, 2 links');
    expect(proposalHeadline(summary({ newItems: ['a', 'b'], newCategories: ['c', 'd'], reusedCategories: ['h', 'i'], newLinks: [{}] }))).toBe('Proposed: 2 new items, 2 new categories, reusing 2 categories, 1 link');
    expect(proposalHeadline(summary())).toBe('Proposed: 0 links');
  });
});

describe('describeFailure', () => {
  it('has plain words for the codes a person can act on', () => {
    expect(describeFailure({ code: 'PROPOSAL_EXPIRED' })).toContain('Propose again');
    expect(describeFailure({ code: 'GRAPH_NOT_FOUND' })).toContain('no longer exists');
    expect(describeFailure({ code: 'INVALID_INPUT' })).toBe('Write a note first.');
    expect(describeFailure({ code: 'PROPOSAL_NOT_FOUND' })).toContain('gone');
    expect(describeFailure({ code: 'TOO_MANY_PENDING' })).toContain('Too many');
  });
  it('shows the model\'s own error for a model failure', () => {
    expect(describeFailure({ source: 'llm', code: 'REFUSED', message: 'declined' })).toBe('The model: REFUSED: declined');
  });
  it('falls back to the code and message, and copes with nothing', () => {
    expect(describeFailure({ code: 'STORAGE_ERROR', message: 'disk' })).toBe('STORAGE_ERROR: disk');
    expect(describeFailure(undefined)).toBe('error: something went wrong');
  });
  it('knows which codes mean the proposal is gone', () => {
    expect(FINAL_CODES).toEqual(['PROPOSAL_NOT_FOUND', 'PROPOSAL_EXPIRED']);
  });
});

describe('realModelSwitch', () => {
  it('is off and explained when not available', () => {
    const sw = realModelSwitch({ available: false, on: true });
    expect(sw).toMatchObject({ disabled: true, checked: false, warning: null });
    expect(sw.hint).toContain('--real-model');
    expect(sw.hint).toContain('ANTHROPIC_API_KEY');
  });
  it('warns about cost and what is sent only when on', () => {
    expect(realModelSwitch({ available: true, on: false })).toMatchObject({ disabled: false, checked: false, warning: null });
    const on = realModelSwitch({ available: true, on: true });
    expect(on).toMatchObject({ disabled: false, checked: true });
    expect(on.warning).toContain('Anthropic');
    expect(on.warning).toContain('costs money');
  });
});
