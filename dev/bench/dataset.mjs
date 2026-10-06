// A deterministic, skewed graph for the benchmark: the same seed always gives the same graph.

/** The NFR-05 scale: 10,000 items, 1,000 categories, 100,000 edges, one category with 5,000 items. */
export const FULL = Object.freeze({ items: 10_000, categories: 1_000, edges: 100_000, hubItems: 5_000, pageSize: 50, deepPage: 100 });
/** Small enough for the gate: it checks the plumbing, not the speed. */
export const SMOKE = Object.freeze({ items: 300, categories: 30, edges: 1_200, hubItems: 200, pageSize: 5, deepPage: 40 });
export const SIZES = Object.freeze({ full: FULL, smoke: SMOKE });

/** A small, fast, seedable random number generator (mulberry32): returns numbers in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (prefix, n, width) => `${prefix}${String(n).padStart(width, '0')}`;

/**
 * @returns { items, categories, edges: [{ item, category }] }. Category popularity follows 1/rank, so a
 * few categories are huge and most are small (like real filing). The first `hubItems` items are
 * all linked to the first category, so a very deep page exists for the paging measurement.
 */
export function generate(size, seed) {
  const { items: itemCount, categories: categoryCount, edges: edgeCount, hubItems } = size;
  if (hubItems > itemCount || hubItems > edgeCount) throw new RangeError('hubItems cannot exceed the number of items or edges');
  if (edgeCount > itemCount * categoryCount) throw new RangeError('more edges than item and category pairs');
  const random = seededRandom(seed);
  const items = Array.from({ length: itemCount }, (_, i) => pad('i', i, 5));
  const categories = Array.from({ length: categoryCount }, (_, i) => pad('c', i, 4));

  // cumulative weights, 1/(rank+1)
  const cumulative = [];
  let total = 0;
  for (let i = 0; i < categoryCount; i++) {
    total += 1 / (i + 1);
    cumulative.push(total);
  }
  const pickCategory = () => {
    const x = random() * total;
    let low = 0;
    let high = categoryCount - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < x) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const seen = new Set();
  const edges = [];
  const add = (item, category) => {
    const key = item * categoryCount + category;
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push({ item: items[item], category: categories[category] });
    return true;
  };
  for (let i = 0; i < hubItems; i++) add(i, 0);
  let guard = 0;
  while (edges.length < edgeCount) {
    if (++guard > edgeCount * 200) throw new Error('could not place the requested number of distinct edges');
    add(Math.floor(random() * itemCount), pickCategory());
  }
  return { items, categories, edges };
}
