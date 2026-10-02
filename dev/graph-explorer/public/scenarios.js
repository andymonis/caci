// Sample scenarios: each step is one mutation (the explorer fills in the graph id).
// They are plain data, so adding a scenario means adding an object here.

const upsert = (partition, id, data) => ({ op: 'upsertNode', partition, id, ...(data === undefined ? {} : { data }) });
const link = (item, category, extra = {}) => ({ op: 'link', item, category, ...extra });
const unlink = (item, category) => ({ op: 'unlink', item, category });
const del = (partition, id) => ({ op: 'deleteNode', partition, id });

export const scenarios = [
  {
    id: 'notes',
    graphId: 'scenario-notes',
    title: 'Notes and topics',
    summary: 'Build a small knowledge graph, then remove a topic and watch its links go with it.',
    steps: [
      { label: 'Add three notes', ops: [upsert('item', 'q3-plan', { title: 'Q3 plan' }), upsert('item', 'budget', { title: 'Budget draft' }), upsert('item', 'offsite', { title: 'Team offsite' })] },
      { label: 'Add two topics', ops: [upsert('category', 'planning'), upsert('category', 'finance')] },
      { label: 'File notes under topics', ops: [link('q3-plan', 'planning', { weight: 0.9 }), link('budget', 'finance'), link('budget', 'planning', { weight: 0.4 })] },
      { label: 'Add a note and a topic in one link (ensureNodes)', ops: [link('travel-costs', 'finance', { ensureNodes: true, weight: 0.7 })] },
      { label: 'Link the offsite to planning', ops: [link('offsite', 'planning')] },
      { label: 'Unlink budget from planning', ops: [unlink('budget', 'planning')] },
      { label: 'Delete the "planning" topic (its links go too)', ops: [del('category', 'planning')] },
      { label: 'Delete a note', ops: [del('item', 'offsite')] },
    ],
  },
  {
    id: 'doctor',
    graphId: 'scenario-doctor',
    title: 'Doctor X and appointments',
    summary: 'The spec\'s example: everything that references one category.',
    steps: [
      { label: 'Add the doctor as a category', ops: [upsert('category', 'doctor-x', { name: 'Dr X' }), upsert('category', 'appointments')] },
      { label: 'Add four visits', ops: ['visit-14', 'visit-17', 'visit-21', 'visit-30'].map((id) => upsert('item', id, { type: 'appointment' })) },
      { label: 'Link every visit to the doctor and to appointments', ops: ['visit-14', 'visit-17', 'visit-21', 'visit-30'].flatMap((id) => [link(id, 'doctor-x'), link(id, 'appointments')]) },
      { label: 'An unrelated note', ops: [upsert('item', 'shopping-list'), link('shopping-list', 'errands', { ensureNodes: true })] },
      { label: 'Cancel a visit', ops: [del('item', 'visit-21')] },
    ],
  },
  {
    id: 'rollback',
    graphId: 'scenario-rollback',
    title: 'All or nothing',
    summary: 'A mutation whose fourth op fails changes nothing, not even the first three.',
    steps: [
      { label: 'Start with a small graph', ops: [upsert('item', 'a'), upsert('item', 'b'), upsert('category', 'x'), link('a', 'x')] },
      { label: 'Atomic failure: ops 1-3 would change things, op 4 links to a missing topic', ops: [upsert('item', 'c'), link('b', 'x'), del('item', 'a'), link('b', 'does-not-exist')], expectFailure: true },
      { label: 'The same ops with ensureNodes on the last one now succeed', ops: [upsert('item', 'c'), link('b', 'x'), del('item', 'a'), link('b', 'does-not-exist', { ensureNodes: true })] },
    ],
  },
];

/** Payloads the library must refuse, so the explorer can show how. */
export const rejected = [
  { id: 'item-item', label: 'Link two items', build: (graphId) => ({ version: 1, kind: 'mutation', graphId, ops: [{ op: 'link', items: ['a', 'b'] }] }) },
  { id: 'cat-cat', label: 'Link two categories', build: (graphId) => ({ version: 1, kind: 'mutation', graphId, ops: [{ op: 'link', from: { partition: 'category', id: 'x' }, to: { partition: 'category', id: 'y' } }] }) },
  { id: 'missing', label: 'Link to a node that does not exist', build: (graphId) => ({ version: 1, kind: 'mutation', graphId, ops: [{ op: 'link', item: 'nobody', category: 'nothing' }] }) },
  { id: 'typo', label: 'Misspell a field', build: (graphId) => ({ version: 1, kind: 'mutation', graphId, ops: [{ op: 'link', item: 'a', category: 'b', ensureNode: true }] }) },
  { id: 'bad-id', label: 'Use a graph id with a capital and a slash', build: () => ({ version: 1, kind: 'mutation', graphId: 'My/Graph', ops: [] }) },
  { id: 'version', label: 'Use an unknown version', build: (graphId) => ({ version: 2, kind: 'mutation', graphId, ops: [] }) },
];
