import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden.mjs';
import { lazyReply, lib, replying } from './helpers.test-util.mjs';
import { idealReply } from './scripted.mjs';
import { runEval } from './runner.mjs';

const run = (makeClient, cases = GOLDEN) =>
  runEval({ lib, cases, models: [{ label: 'm', choice: { tier: 'fast' } }], makeClient }).then((r) => r.results);

describe('the built-in golden set', () => {
  it('has a good spread of cases', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(12);
    expect(new Set(GOLDEN.map((c) => c.id)).size).toBe(GOLDEN.length);
    const notes = GOLDEN.map((c) => c.note);
    expect(notes.some((n) => n.length < 20)).toBe(true); // very short
    expect(notes.some((n) => n.length > 250)).toBe(true); // long
    expect(GOLDEN.some((c) => c.categories.length === 0)).toBe(true); // empty graph
    expect(GOLDEN.some((c) => c.categories.length > 50)).toBe(true); // a lot of categories
    expect(notes.some((n) => /ignore all previous instructions/i.test(n))).toBe(true); // an injection attempt
    expect(notes.some((n) => /[éèà]/.test(n))).toBe(true); // not only English
  });

  it('is frozen, so a run cannot change it', () => {
    expect(Object.isFrozen(GOLDEN)).toBe(true);
  });

  it('can be satisfied: an ideal scripted model passes every case, through the real categorise', async () => {
    const results = await run(({ caseDef, itemId }) => replying(idealReply(caseDef, itemId)));
    const failures = results.filter((r) => !r.pass).map((r) => `${r.caseId}: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
    expect(failures).toEqual([]);
    expect(results).toHaveLength(GOLDEN.length);
  });

  it('is discriminating: a model that links everything to the first category fails many cases', async () => {
    const results = await run(({ caseDef, itemId }) => replying(lazyReply(caseDef, itemId)));
    const failed = results.filter((r) => !r.pass);
    expect(failed.length).toBeGreaterThanOrEqual(8);
    expect(results.some((r) => r.pass)).toBe(true); // and it is not impossible to pass by accident for easy cases
    const holiday = results.find((r) => r.caseId === 'holiday-planning');
    expect(holiday.checks.find((c) => c.name === 'reuses travel').pass).toBe(false);
  });

  it('is discriminating: a model that invents a duplicate category fails the "do not create" cases', async () => {
    const results = await run(({ itemId }) =>
      replying({
        ops: [
          { op: 'upsertNode', partition: 'item', id: itemId, data: { title: 't', summary: 's' } },
          { op: 'upsertNode', partition: 'category', id: 'doctor-visits', data: { name: 'Doctor visits' } },
          { op: 'link', item: itemId, category: 'doctor-visits' },
        ],
      }),
    );
    const doctor = results.find((r) => r.caseId === 'doctor-followup');
    expect(doctor.pass).toBe(false);
    expect(doctor.checks.find((c) => c.name.startsWith('does not create')).pass).toBe(false);
  });

  it('is discriminating: a model that links to every category fails the link limits', async () => {
    const withCategories = GOLDEN.filter((c) => c.categories.length > 0);
    const everything = ({ caseDef, itemId }) =>
      replying({ ops: [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 't', summary: 's' } }, ...caseDef.categories.slice(0, 8).map((c) => ({ op: 'link', item: itemId, category: c.id }))] });
    const results = await run(everything, withCategories);
    expect(results.filter((r) => !r.pass).length).toBeGreaterThanOrEqual(10);
  });

  it('every expectation names categories the case really has (so no case is unfair)', () => {
    for (const c of GOLDEN) {
      const ids = new Set(c.categories.map((x) => x.id));
      for (const id of [...(c.expect.reuse ?? []), ...(c.expect.avoidReuse ?? [])]) expect(ids.has(id), `${c.id}: ${id}`).toBe(true);
    }
  });
});
