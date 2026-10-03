import { err, ok, type Mutation, type Result } from '../graph_store/index.js';
import { appError, type AppError } from './errors.js';

/** Which of a mutation's nodes are already in the graph. The controller finds out with `query()`. */
export interface ExistingNodes {
  readonly items: readonly string[];
  readonly categories: readonly string[];
}

export interface Link {
  readonly item: string;
  readonly category: string;
}

/** What approving a proposal would change, worked out before anything is written. */
export interface ProposalSummary {
  /** Items the proposal creates. */
  readonly newItems: readonly string[];
  /** Items that already exist and would have their data changed. */
  readonly updatedItems: readonly string[];
  readonly newCategories: readonly string[];
  /** Categories that already exist and would have their data changed. */
  readonly updatedCategories: readonly string[];
  /** Existing categories the proposal links to. */
  readonly reusedCategories: readonly string[];
  /** Each distinct link, in the order the proposal gives them. */
  readonly newLinks: readonly Link[];
  /** Things that would make the write fail. A person should not approve a proposal that has any. */
  readonly problems: readonly string[];
  /** Things worth knowing that would not stop the write. */
  readonly notes: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const invalid = (message: string): Result<never, AppError> => err(appError('INVALID_INPUT', `summary: ${message}`));
const add = (list: string[], id: string): void => void (list.includes(id) || list.push(id));

/**
 * Works out what a mutation made of `upsertNode` and `link` operations would do to a graph where
 * `existing` nodes are already present. Pure and deterministic; never throws. The operations are
 * read in order, as `write` applies them, so a link to a category that is created only later in
 * the same mutation is reported as a problem, because the write would fail on it.
 */
export function summarise(mutation: Mutation, existing: ExistingNodes): Result<ProposalSummary, AppError> {
  try {
    if (!isObject(mutation) || !Array.isArray(mutation.ops)) return invalid('the mutation must have a list of operations');
    if (!isObject(existing) || !isIds(existing.items) || !isIds(existing.categories)) return invalid('existing must be { items, categories }, each a list of ids');
    const items = new Set(existing.items);
    const categories = new Set(existing.categories);

    const newItems: string[] = [];
    const updatedItems: string[] = [];
    const newCategories: string[] = [];
    const updatedCategories: string[] = [];
    const reusedCategories: string[] = [];
    const newLinks: Link[] = [];
    const problems: string[] = [];
    const notes: string[] = [];
    // What exists at each point of the write: the graph's nodes plus whatever earlier operations created.
    const itemsNow = new Set(items);
    const categoriesNow = new Set(categories);
    const linked = new Set<string>();

    for (const [index, op] of mutation.ops.entries()) {
      if (!isObject(op) || typeof op.op !== 'string') return invalid(`ops[${index}] is not an operation`);
      if (op.op === 'upsertNode') {
        if (typeof op.id !== 'string' || (op.partition !== 'item' && op.partition !== 'category')) return invalid(`ops[${index}] is not a valid upsertNode`);
        const [known, now, created, updated] =
          op.partition === 'item' ? [items, itemsNow, newItems, updatedItems] : [categories, categoriesNow, newCategories, updatedCategories];
        add(known.has(op.id) ? updated : created, op.id);
        now.add(op.id);
      } else if (op.op === 'link') {
        if (typeof op.item !== 'string' || typeof op.category !== 'string') return invalid(`ops[${index}] is not a valid link`);
        const { item, category } = op;
        if (!itemsNow.has(item)) {
          problems.push(`ops[${index}]: the link from ${quote(item)} would fail because that item does not exist and is not created before this link`);
        }
        if (!categoriesNow.has(category)) {
          problems.push(`ops[${index}]: the link to ${quote(category)} would fail because that category does not exist and is not created before this link`);
        }
        if (categories.has(category)) add(reusedCategories, category);
        const key = JSON.stringify([item, category]);
        if (linked.has(key)) {
          notes.push(`ops[${index}]: the link from ${quote(item)} to ${quote(category)} appears more than once; the last one wins`);
        } else {
          linked.add(key);
          newLinks.push({ item, category });
        }
        if (items.has(item)) notes.push(`ops[${index}]: ${quote(item)} already exists, so this link may replace one it already has`);
      } else {
        return invalid(`ops[${index}]: the operation ${quote(op.op)} cannot be summarised (only upsertNode and link can)`);
      }
    }
    return ok(Object.freeze({ newItems, updatedItems, newCategories, updatedCategories, reusedCategories, newLinks, problems, notes }));
  } catch {
    return invalid('could not be read');
  }
}

/** Ids from the model may hold anything, so odd ones are shown quoted and escaped, never raw. */
function quote(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) ? id : JSON.stringify(id);
}

const list = (ids: readonly string[]): string => (ids.length === 0 ? 'none' : ids.map(quote).join(', '));

/** The summary as short plain text for a person. Deterministic. */
export function describeSummary(summary: ProposalSummary): string {
  const lines = [
    `New items: ${list(summary.newItems)}`,
    `New categories: ${list(summary.newCategories)}`,
    `Existing categories used: ${list(summary.reusedCategories)}`,
    `Links: ${summary.newLinks.length === 0 ? 'none' : summary.newLinks.map((l) => `${quote(l.item)} → ${quote(l.category)}`).join(', ')}`,
  ];
  if (summary.updatedItems.length > 0) lines.push(`Existing items that would change: ${list(summary.updatedItems)}`);
  if (summary.updatedCategories.length > 0) lines.push(`Existing categories that would change: ${list(summary.updatedCategories)}`);
  if (summary.problems.length > 0) lines.push('Problems (this would fail if approved):', ...summary.problems.map((p) => `  - ${p}`));
  if (summary.notes.length > 0) lines.push('Notes:', ...summary.notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}
