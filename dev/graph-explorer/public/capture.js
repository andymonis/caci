// Pure helpers for the capture panel: how a pending proposal is drawn on top of the real graph, and
// what to say about it. No DOM here, so they run in the browser and in tests.
import { edgeKey, nodeKey } from './layout.js';

const dataOf = (ops, partition, id) => ops.find((o) => o.op === 'upsertNode' && o.partition === partition && o.id === id)?.data;
const weightOf = (ops, item, category) => ops.find((o) => o.op === 'link' && o.item === item && o.category === category)?.weight;

/**
 * The graph with a proposal laid over it, for drawing only (nothing here is written).
 * - `graph` is the real graph plus the proposed new items, categories and links (as ordinary nodes
 *   and edges, so the existing layout places them)
 * - `ghostNodes` / `ghostEdges` say which of them are only proposed
 * - `reusedNodes` are existing categories the proposal links to; `updatedNodes` are existing nodes it would change
 * Links whose ends do not exist are left out (the summary reports them as problems).
 */
export function applyGhosts(graph, proposal) {
  const { summary, ops } = proposal;
  const ghostNodes = new Set();
  const ghostEdges = new Set();
  const reusedNodes = new Set(summary.reusedCategories.map((id) => nodeKey('category', id)));
  const updatedNodes = new Set([...summary.updatedItems.map((id) => nodeKey('item', id)), ...summary.updatedCategories.map((id) => nodeKey('category', id))]);

  const items = [...graph.items];
  const categories = [...graph.categories];
  for (const id of summary.newItems) {
    if (items.some((n) => n.id === id)) continue;
    items.push({ partition: 'item', id, data: dataOf(ops, 'item', id) });
    ghostNodes.add(nodeKey('item', id));
  }
  for (const id of summary.newCategories) {
    if (categories.some((n) => n.id === id)) continue;
    categories.push({ partition: 'category', id, data: dataOf(ops, 'category', id) });
    ghostNodes.add(nodeKey('category', id));
  }

  const edges = [...graph.edges];
  for (const { item, category } of summary.newLinks) {
    const key = edgeKey(item, category);
    if (edges.some((e) => e.item === item && e.category === category)) continue; // already there: it would be replaced, not added
    if (!items.some((n) => n.id === item) || !categories.some((n) => n.id === category)) continue;
    edges.push({ item, category, weight: weightOf(ops, item, category) });
    ghostEdges.add(key);
  }
  return { graph: { ...graph, items, categories, edges }, ghostNodes, ghostEdges, reusedNodes, updatedNodes };
}

/** One line for the status bar: what is proposed. */
export function proposalHeadline(summary) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [];
  if (summary.newItems.length > 0) parts.push(n(summary.newItems.length, 'new item', 'new items'));
  if (summary.newCategories.length > 0) parts.push(n(summary.newCategories.length, 'new category', 'new categories'));
  if (summary.reusedCategories.length > 0) parts.push(`reusing ${n(summary.reusedCategories.length, 'category', 'categories')}`);
  parts.push(n(summary.newLinks.length, 'link', 'links'));
  return `Proposed: ${parts.join(', ')}`;
}

const CODE_HELP = {
  GRAPH_NOT_FOUND: 'That graph no longer exists.',
  PROPOSAL_NOT_FOUND: 'That proposal is gone (already approved, rejected, or the explorer was reset).',
  PROPOSAL_EXPIRED: 'That proposal ran out of time. Propose again.',
  TOO_MANY_PENDING: 'Too many proposals are waiting.',
  INVALID_INPUT: 'Write a note first.',
};

/** A failed capture call, as one line for a person. */
export function describeFailure(error) {
  const base = CODE_HELP[error?.code] ?? `${error?.code ?? 'error'}: ${error?.message ?? 'something went wrong'}`;
  return error?.source === 'llm' ? `The model: ${error.code}: ${error.message}` : base;
}

/** Codes after which the pending proposal is gone and the drawing should be cleared. */
export const FINAL_CODES = ['PROPOSAL_NOT_FOUND', 'PROPOSAL_EXPIRED'];

/** What the "use the real model" switch should look like. */
export function realModelSwitch({ available, on }) {
  if (!available) return { disabled: true, checked: false, hint: 'Off. Start the explorer with --real-model and ANTHROPIC_API_KEY set to use a real model.', warning: null };
  return { disabled: false, checked: Boolean(on), hint: 'Optional. Calls the real model.', warning: on ? 'This sends the note and the category names to Anthropic and costs money.' : null };
}
