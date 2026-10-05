import { describe, expect, it } from 'vitest';
import { evaluateCase, validateGolden, wordsOf } from './evaluate.mjs';
import { GOLDEN } from './golden.mjs';

const summary = (extra = {}) => ({ newItems: ['n'], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [], ...extra });
const answered = (extra) => ({ ok: true, summary: summary(extra) });
const caseOf = (expect, categories = [{ id: 'health' }, { id: 'work' }]) => ({ id: 'c', note: 'n', categories, expect });
const names = (verdict) => verdict.checks.map((c) => c.name);
const failed = (verdict) => verdict.checks.filter((c) => !c.pass).map((c) => c.name);

describe('wordsOf', () => {
  it('splits an id into lowercase words', () => {
    expect(wordsOf('Doctor-Visits_2')).toEqual(['doctor', 'visits', '2']);
    expect(wordsOf('gp')).toEqual(['gp']);
    expect(wordsOf('--')).toEqual([]);
    expect(wordsOf('médecin-rdv')).toEqual(['médecin', 'rdv']);
  });
});

describe('evaluateCase: a call that failed', () => {
  it('fails the case with the reason, and nothing else is checked', () => {
    const v = evaluateCase(caseOf({ reuse: ['health'] }), { ok: false, error: { code: 'REFUSED', message: 'declined' } });
    expect(v.pass).toBe(false);
    expect(v.checks).toEqual([{ name: 'answered', pass: false, detail: 'REFUSED: declined' }]);
  });
  it('copes with an error that has no details', () => {
    expect(evaluateCase(caseOf({}), { ok: false, error: {} }).checks[0].detail).toBe('error:');
    expect(evaluateCase(caseOf({}), { ok: false }).pass).toBe(false);
  });
});

describe('evaluateCase: the checks', () => {
  it('a case with no expectations passes when answered and valid', () => {
    const v = evaluateCase(caseOf({}), answered());
    expect(v.pass).toBe(true);
    expect(names(v)).toEqual(['answered', 'valid']);
  });

  it('valid fails when the preview found problems, and says which', () => {
    const v = evaluateCase(caseOf({}), answered({ problems: ['ops[1]: link would fail'] }));
    expect(failed(v)).toEqual(['valid']);
    expect(v.checks[1].detail).toContain('link would fail');
  });

  it('reuse and avoidReuse look at the existing categories linked to', () => {
    const c = caseOf({ reuse: ['health'], avoidReuse: ['work'] });
    expect(evaluateCase(c, answered({ reusedCategories: ['health'] })).pass).toBe(true);
    expect(failed(evaluateCase(c, answered({ reusedCategories: [] })))).toEqual(['reuses health']);
    expect(failed(evaluateCase(c, answered({ reusedCategories: ['health', 'work'] })))).toEqual(['avoids work']);
    expect(failed(evaluateCase(c, answered({ reusedCategories: ['work'] })))).toEqual(['reuses health', 'avoids work']);
  });

  it('mustNotCreate matches whole words in new category ids, ignoring case', () => {
    const c = caseOf({ mustNotCreate: ['doctor', 'gp'] });
    expect(evaluateCase(c, answered({ newCategories: ['shopping', 'mapping'] })).pass).toBe(true); // "gp" is not a word of "shopping"
    expect(failed(evaluateCase(c, answered({ newCategories: ['doctor'] })))).toEqual(['does not create doctor/gp']);
    expect(failed(evaluateCase(c, answered({ newCategories: ['Doctor-Visits'] })))).toEqual(['does not create doctor/gp']);
    expect(failed(evaluateCase(c, answered({ newCategories: ['my_GP_notes'] })))).toEqual(['does not create doctor/gp']);
    expect(evaluateCase(c, answered({ newCategories: ['doctors'] })).pass).toBe(true); // a different word: loose on purpose
    expect(evaluateCase(caseOf({ mustNotCreate: ['Doctor'] }), answered({ newCategories: ['doctor'] })).pass).toBe(false);
  });

  it('the details of a mustNotCreate failure name what was created', () => {
    const v = evaluateCase(caseOf({ mustNotCreate: ['doctor'] }), answered({ newCategories: ['x', 'doctor-visits'] }));
    expect(v.checks.at(-1).detail).toBe('created: doctor-visits');
  });

  it('newCategories and links use inclusive ranges', () => {
    const c = caseOf({ newCategories: { min: 1, max: 2 }, links: { min: 1, max: 3 } });
    const link = (n) => Array.from({ length: n }, (_, i) => ({ item: 'n', category: `c${i}` }));
    const run = (nNew, nLinks) => evaluateCase(c, answered({ newCategories: Array.from({ length: nNew }, (_, i) => `x${i}`), newLinks: link(nLinks) }));
    expect(run(1, 1).pass).toBe(true);
    expect(run(2, 3).pass).toBe(true);
    expect(failed(run(0, 1))).toEqual(['new categories 1 to 2']);
    expect(failed(run(3, 1))).toEqual(['new categories 1 to 2']);
    expect(failed(run(1, 0))).toEqual(['links 1 to 3']);
    expect(failed(run(1, 4))).toEqual(['links 1 to 3']);
  });

  it('an open-ended range names its bound', () => {
    expect(names(evaluateCase(caseOf({ newCategories: { max: 0 }, links: { min: 2 } }), answered()))).toEqual(['answered', 'valid', 'new categories 0 to 0', 'links 2 to any']);
  });

  it('every check is reported, pass or fail, in a fixed order', () => {
    const v = evaluateCase(caseOf({ reuse: ['health'], avoidReuse: ['work'], mustNotCreate: ['x'], newCategories: { max: 0 }, links: { max: 1 } }), answered({ reusedCategories: ['health'] }));
    expect(names(v)).toEqual(['answered', 'valid', 'reuses health', 'avoids work', 'does not create x', 'new categories 0 to 0', 'links 0 to 1']);
  });

  it('is pure: the same inputs give the same verdict and nothing is changed', () => {
    const c = caseOf({ reuse: ['health'] });
    const o = answered({ reusedCategories: ['health'] });
    const before = JSON.stringify([c, o]);
    expect(evaluateCase(c, o)).toEqual(evaluateCase(c, o));
    expect(JSON.stringify([c, o])).toBe(before);
  });
});

describe('validateGolden', () => {
  const good = () => ({ id: 'a-case', note: 'A note', categories: [{ id: 'health' }, { id: 'work' }], expect: { reuse: ['health'], avoidReuse: ['work'], mustNotCreate: ['doctor'], newCategories: { max: 1 }, links: { min: 1, max: 3 } } });

  it('accepts the built-in golden set', () => {
    expect(validateGolden(GOLDEN)).toEqual([]);
  });
  it('accepts a sound case', () => {
    expect(validateGolden([good()])).toEqual([]);
  });

  const mutate = (change) => {
    const c = good();
    change(c);
    return validateGolden([c]);
  };
  it.each([
    ['an id with capitals', (c) => (c.id = 'Bad Id'), 'id must be lowercase'],
    ['an empty note', (c) => (c.note = '  '), 'note must be non-empty'],
    ['categories that are not a list', (c) => (c.categories = 'x'), 'categories must be a list'],
    ['a category with no id', (c) => (c.categories = [{}]), 'categories must be a list'],
    ['duplicate category ids', (c) => (c.categories = [{ id: 'a' }, { id: 'a' }]), 'duplicate category ids'],
    ['no expectations object', (c) => (c.expect = null), 'expect must be an object'],
    ['an unknown expectation', (c) => (c.expect.mood = 'happy'), 'unknown expectation "mood"'],
    ['reusing a category that does not exist', (c) => (c.expect.reuse = ['ghost']), '"ghost", which is not one of its categories'],
    ['avoiding a category that does not exist', (c) => (c.expect.avoidReuse = ['ghost']), '"ghost", which is not one of its categories'],
    ['reusing and avoiding the same category', (c) => (c.expect.avoidReuse = ['health']), 'both reused and avoided'],
    ['forbidding creating an existing category', (c) => (c.expect.mustNotCreate = ['health']), 'must be a word that is not an existing category'],
    ['an empty forbidden word', (c) => (c.expect.mustNotCreate = ['']), 'must be a word'],
    ['a range with a bad key', (c) => (c.expect.links = { most: 3 }), 'links must be { min?, max? }'],
    ['a range with min above max', (c) => (c.expect.newCategories = { min: 3, max: 1 }), 'newCategories must be { min?, max? }'],
    ['a range with a fraction', (c) => (c.expect.links = { max: 1.5 }), 'links must be { min?, max? }'],
    ['a negative bound', (c) => (c.expect.links = { min: -1 }), 'links must be { min?, max? }'],
    ['reusing more than the links allow', (c) => ((c.expect.reuse = ['health', 'work']), (c.expect.avoidReuse = []), (c.expect.links = { max: 1 })), 'reuses 2 categories but allows at most 1 links'],
    ['forbidding new categories when none exist', (c) => ((c.categories = []), (c.expect = { newCategories: { max: 0 } })), 'cannot also forbid'],
  ])('refuses %s', (_n, change, text) => {
    const problems = mutate(change);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(text);
  });

  it('refuses a set that is empty, not a list, or has duplicate ids or non-objects', () => {
    expect(validateGolden([])).toEqual(['the golden set must be a non-empty list']);
    expect(validateGolden('x')).toEqual(['the golden set must be a non-empty list']);
    expect(validateGolden([good(), good()]).join()).toContain('duplicate id');
    expect(validateGolden([null]).join()).toContain('must be an object');
  });

  it('names the case a problem belongs to', () => {
    const c = good();
    c.note = '';
    expect(validateGolden([good(), { ...c, id: 'second' }])[0]).toContain('case 2 (second)');
  });
});
