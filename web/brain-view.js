// The words on the Brain screen (R-007). Pure: no page access, so every sentence can be tested exactly.
// `brain-page.js` only puts them on the page.

export const EMPTY_BRAIN = 'Nothing is filed yet. Capture a note and approve it, and it will appear here.';
export const EMPTY_CATEGORY = 'There are no items in this category.';
export const SHORTENED = 'Some of this was shortened because it was long.';
export const MORE_CATEGORIES = 'This item is filed under more categories than are shown here.';

const plural = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const text = (value) => (typeof value === 'string' ? value : '');

/** What a row of the categories list says. The id is shown only when the category has no name. */
export function categoryRow(category) {
  const name = text(category.name) !== '' ? category.name : category.id;
  const count = category.itemCountCapped === true ? `at least ${plural(category.itemCount, 'item', 'items')}` : plural(category.itemCount, 'item', 'items');
  return Object.freeze({ name, count, label: `Open the category ${name}, ${count}` });
}

/** What a row of a category's items says: a title (else a name, else the id) and the summary when there is one. */
export function itemRow(item) {
  const data = item.data && typeof item.data === 'object' ? item.data : {};
  const title = text(data.title) !== '' ? data.title : text(data.name) !== '' ? data.name : item.id;
  const summary = text(data.summary);
  return Object.freeze({ title, summary, shortened: item.dataTruncated === true ? SHORTENED : '', label: `Open the item ${title}` });
}

/** The data of one item as `key: value` rows, in the order it has them; anything that is not text is shown as JSON. */
export function dataEntries(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([key, value]) => Object.freeze({ key, value: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }));
}

/** One category an item is filed under. */
export function itemCategoryRow(category) {
  const name = text(category.name) !== '' ? category.name : category.id;
  return Object.freeze({ name, weight: `weight ${category.weight}`, label: `Open the category ${name}` });
}
