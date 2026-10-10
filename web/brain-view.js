// The words on the Brain screen (R-007). Pure: no page access, so every sentence can be tested exactly.
// `brain-page.js` only puts them on the page.

export const EMPTY_BRAIN = 'Nothing is filed yet. Capture a note and approve it, and it will appear here.';
export const EMPTY_CATEGORY = 'There are no items in this category.';
export const SHORTENED = 'Some of this was shortened because it was long.';
export const MORE_CATEGORIES = 'This item is filed under more categories than are shown here.';

const plural = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const text = (value) => (typeof value === 'string' ? value : '');

export const NO_CIRCLE_WAYS = 'You can go back to your own notes.';

/** Where a result came from, in words: the person's own notes or one circle (a circle without a name is just "a circle"). */
export function whereText(scope) {
  if (scope && scope.kind === 'circle') return `Circle "${text(scope.circleName) !== '' ? scope.circleName : 'unnamed'}"`;
  return 'My own notes';
}
const from = (where) => (where === undefined || where === '' ? '' : `, from ${where}`);

/** One sentence under the scope choice about what is being shown. */
export function scopeHint(browseKey, scopes) {
  if (browseKey === 'mine') return 'My Brain shows your own notes and the notes of every circle you are in. Each one says where it is.';
  const chosen = scopes.find((s) => s.key === browseKey);
  if (chosen && chosen.scope.kind === 'circle') return `Showing the circle "${chosen.label}": the notes added by its members.${chosen.canCapture ? '' : ' You can read it, but not add notes to it.'}`;
  return 'Showing only your own notes.';
}

/** What a row of the categories list says. The id is shown only when the category has no name. */
export function categoryRow(category, where) {
  const name = text(category.name) !== '' ? category.name : category.id;
  const count = category.itemCountCapped === true ? `at least ${plural(category.itemCount, 'item', 'items')}` : plural(category.itemCount, 'item', 'items');
  return Object.freeze({ name, count, where: where ?? '', label: `Open the category ${name}, ${count}${from(where)}` });
}

/** What a row of a category's items says: a title (else a name, else the id) and the summary when there is one. */
export function itemRow(item, where) {
  const data = item.data && typeof item.data === 'object' ? item.data : {};
  const title = text(data.title) !== '' ? data.title : text(data.name) !== '' ? data.name : item.id;
  const summary = text(data.summary);
  return Object.freeze({ title, summary, shortened: item.dataTruncated === true ? SHORTENED : '', where: where ?? '', label: `Open the item ${title}${from(where)}` });
}

/** The data of one item as `key: value` rows, in the order it has them; anything that is not text is shown as JSON. */
export function dataEntries(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([key, value]) => Object.freeze({ key, value: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }));
}

/** One category an item is filed under. */
export function itemCategoryRow(category, where) {
  const name = text(category.name) !== '' ? category.name : category.id;
  return Object.freeze({ name, weight: `weight ${category.weight}`, where: where ?? '', label: `Open the category ${name}${from(where)}` });
}
