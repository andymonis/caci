// Pure layout and diff helpers for the explorer. No DOM here, so they run in the browser and in tests.

export const nodeKey = (partition, id) => `${partition}:${id}`;
export const edgeKey = (item, category) => `${item}\u0000${category}`;

/**
 * A label that fits beside a node: long ids (like the ones the controller mints) keep their start and
 * their end, which is where they differ, with an ellipsis between. The full id stays in the tooltip.
 */
export function shortLabel(id, max = 18) {
  const text = String(id);
  const chars = [...text];
  if (chars.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`;
}

/**
 * Keeps ids in the order they were first seen: ids still present keep their place, new ids are
 * appended (sorted among themselves). Nodes therefore never jump when something else is added.
 */
export function mergeOrder(previous, currentIds) {
  const present = new Set(currentIds);
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = currentIds.filter((id) => !known.has(id)).sort();
  return [...kept, ...added];
}

/**
 * Bipartite layout: items in a left column, categories in a right column, each centred vertically
 * in the order given. Returns node and edge geometry keyed for the renderer.
 */
export function computeLayout(graph, options = {}) {
  const { width = 900, minHeight = 420, top = 48, bottom = 32, left = 150, right = 150, gap = 48 } = options;
  const rows = Math.max(graph.items.length, graph.categories.length, 1);
  const height = Math.max(minHeight, top + bottom + rows * gap);
  const innerHeight = height - top - bottom;

  const column = (nodes, partition, x) =>
    nodes.map((node, index) => {
      const used = nodes.length * gap;
      const y = top + (innerHeight - used) / 2 + gap / 2 + index * gap;
      return { key: nodeKey(partition, node.id), partition, id: node.id, data: node.data, x, y };
    });

  const nodes = new Map();
  for (const n of column(graph.items, 'item', left)) nodes.set(n.key, n);
  for (const n of column(graph.categories, 'category', width - right)) nodes.set(n.key, n);

  const edges = [];
  for (const e of graph.edges) {
    const from = nodes.get(nodeKey('item', e.item));
    const to = nodes.get(nodeKey('category', e.category));
    if (from === undefined || to === undefined) continue; // would be a dangling edge; the library never produces one
    edges.push({ key: edgeKey(e.item, e.category), item: e.item, category: e.category, weight: e.weight, data: e.data, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }
  return { width, height, nodes, edges };
}

/** SVG path for an edge: a smooth curve leaving horizontally from the item and arriving horizontally at the category. */
export function edgePath(x1, y1, x2, y2) {
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between two snapshots of a graph, as sets of keys. `prev` may be null for a first load. */
export function diffGraphs(prev, next) {
  const empty = { items: [], categories: [], edges: [] };
  const before = prev ?? empty;
  const index = (rows, keyOf) => new Map(rows.map((row) => [keyOf(row), row]));
  const result = { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } };

  for (const [partition, list] of [['item', 'items'], ['category', 'categories']]) {
    const was = index(before[list], (n) => nodeKey(partition, n.id));
    const now = index(next[list], (n) => nodeKey(partition, n.id));
    for (const [key, node] of now) {
      if (!was.has(key)) result.nodes.added.push(key);
      else if (!same(was.get(key).data, node.data)) result.nodes.changed.push(key);
    }
    for (const key of was.keys()) if (!now.has(key)) result.nodes.removed.push(key);
  }

  const was = index(before.edges, (e) => edgeKey(e.item, e.category));
  const now = index(next.edges, (e) => edgeKey(e.item, e.category));
  for (const [key, edge] of now) {
    if (!was.has(key)) result.edges.added.push(key);
    else if (!same({ w: was.get(key).weight, d: was.get(key).data }, { w: edge.weight, d: edge.data })) result.edges.changed.push(key);
  }
  for (const key of was.keys()) if (!now.has(key)) result.edges.removed.push(key);
  return result;
}

/** A short human summary of a diff, e.g. "+2 nodes, -1 edge". */
export function describeDiff(diff) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (diff.nodes.added.length) parts.push(`+${plural(diff.nodes.added.length, 'node')}`);
  if (diff.nodes.removed.length) parts.push(`-${plural(diff.nodes.removed.length, 'node')}`);
  if (diff.nodes.changed.length) parts.push(`~${plural(diff.nodes.changed.length, 'node')} updated`);
  if (diff.edges.added.length) parts.push(`+${plural(diff.edges.added.length, 'edge')}`);
  if (diff.edges.removed.length) parts.push(`-${plural(diff.edges.removed.length, 'edge')}`);
  if (diff.edges.changed.length) parts.push(`~${plural(diff.edges.changed.length, 'edge')} updated`);
  return parts.length ? parts.join(', ') : 'no change';
}
