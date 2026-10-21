import assert from 'node:assert/strict';
import type { LedgerError } from '../errors.js';
import type { Result } from '../result.js';
import type { LedgerStore } from '../store.js';
import type { LedgerEntry, LedgerPage, LedgerScope } from '../types.js';
import type { LedgerStoreCase } from './types.js';

const pad = (n: number | string): string => String(n).padStart(16, '0');
const lid = (n: number | string): string => `l${pad(n)}`;
const NOW = 1_000_000;
const P1: LedgerScope = { kind: 'personal', userId: 'u0000000000000001' };
const P2: LedgerScope = { kind: 'personal', userId: 'u0000000000000002' };
const C1: LedgerScope = { kind: 'circle', circleId: 'c0000000000000001' };

const entry = (n: number | string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: lid(n), at: NOW + (typeof n === 'number' ? n : 0), scope: P1, actor: 'u0000000000000009', action: 'added', kind: 'item', subject: `note-${n}`, proposalId: 'prop-1', ...extra });

const must = <T>(result: Result<T, LedgerError>): T => {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
};
const code = <T>(result: Result<T, LedgerError>): string | undefined => (result.ok ? undefined : result.error.code);

async function everything(store: LedgerStore, scope: LedgerScope, limit = 3): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page: LedgerPage = await store.list(scope, { limit, cursor });
    out.push(...page.items);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the cursor never ends');
}
const ids = (entries: readonly LedgerEntry[]): string[] => entries.map((e) => e.id);
const rejects = async (body: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(body, RangeError);
};

export function ledgerStoreCases(): LedgerStoreCase[] {
  return [
    {
      name: 'an empty ledger lists nothing and has no next page',
      run: async (store) => {
        assert.deepEqual(await store.list(P1, { limit: 10, cursor: null }), { items: [], nextCursor: null });
      },
    },
    {
      name: 'an entry comes back exactly as it was written, with every field',
      run: async (store) => {
        const e = entry(1, { action: 'removed', kind: 'category', title: 'Mum: 2 x Tablet A', summary: 'a day with breakfast', scope: C1 });
        must(await store.append([e]));
        assert.deepEqual((await store.list(C1, { limit: 5, cursor: null })).items, [e]);
      },
    },
    {
      name: 'optional fields that were not given are not there',
      run: async (store) => {
        must(await store.append([entry(1)]));
        const got = (await store.list(P1, { limit: 5, cursor: null })).items[0] as LedgerEntry;
        assert.equal('title' in got, false);
        assert.equal('summary' in got, false);
      },
    },
    {
      name: 'awkward text round-trips: emoji, quotes, markup, new lines and a 256-character subject',
      run: async (store) => {
        const subject = 'a'.repeat(256);
        const odd = entry(1, { subject, title: '😀 "quoted" <b>bold</b> \n second line', summary: 'tab\there & `ticks` 你好 ‮' });
        must(await store.append([odd, entry(2, { subject: 'a/b?c=d&e#f %é😀<b>..' })]));
        const got = await everything(store, P1);
        assert.deepEqual(got.find((e) => e.id === lid(1)), odd);
        assert.equal(got.find((e) => e.id === lid(2))?.subject, 'a/b?c=d&e#f %é😀<b>..');
      },
    },
    {
      name: 'entries come newest first, and entries at the same time by id, highest first',
      run: async (store) => {
        must(await store.append([entry(1, { at: 300 }), entry(2, { at: 500 }), entry(3, { at: 300 }), entry(4, { at: 400 }), entry(5, { at: 500 })]));
        assert.deepEqual(ids(await everything(store, P1, 10)), [lid(5), lid(2), lid(4), lid(3), lid(1)]);
      },
    },
    {
      name: 'paging gives every entry once, in order, whatever the page size, and a page that exactly fills the limit has no next page',
      run: async (store) => {
        must(await store.append(Array.from({ length: 7 }, (_, i) => entry(i + 1))));
        const expected = ids(await everything(store, P1, 100));
        assert.equal(expected.length, 7);
        for (const size of [1, 2, 3, 6, 7, 8]) assert.deepEqual(ids(await everything(store, P1, size)), expected, `page size ${size}`);
        assert.equal((await store.list(P1, { limit: 7, cursor: null })).nextCursor, null);
        assert.notEqual((await store.list(P1, { limit: 6, cursor: null })).nextCursor, null);
        assert.equal((await store.list(P1, { limit: 2, cursor: null })).items.length, 2);
      },
    },
    {
      name: 'a newer entry added while paging does not repeat or skip an older one',
      run: async (store) => {
        must(await store.append([entry(1), entry(2), entry(3), entry(4)]));
        const first = await store.list(P1, { limit: 2, cursor: null });
        assert.deepEqual(ids(first.items), [lid(4), lid(3)]);
        must(await store.append([entry(9, { at: NOW + 100 })]));
        const rest = await store.list(P1, { limit: 5, cursor: first.nextCursor });
        assert.deepEqual(ids(rest.items), [lid(2), lid(1)]);
      },
    },
    {
      name: 'a bad page limit is a RangeError',
      run: async (store) => {
        for (const limit of [0, -1, 1.5, Number.NaN]) await rejects(() => store.list(P1, { limit, cursor: null }));
      },
    },
    {
      name: 'a cursor the store did not give out, one for another scope, and a second spelling of a real one are RangeErrors',
      run: async (store) => {
        must(await store.append([entry(1), entry(2), entry(3)]));
        must(await store.append([entry(7, { scope: P2 }), entry(8, { scope: P2 })]));
        const page = await store.list(P1, { limit: 1, cursor: null });
        const cursor = page.nextCursor as string;
        assert.ok(cursor);
        for (const bad of ['', 'x', 'garbage', cursor + '=', cursor + 'A', cursor.slice(0, -1), 'g']) await rejects(() => store.list(P1, { limit: 1, cursor: bad }));
        await rejects(() => store.list(P2, { limit: 1, cursor }));
        await rejects(() => store.list(C1, { limit: 1, cursor }));
        const other = (await store.list(P2, { limit: 1, cursor: null })).nextCursor as string;
        await rejects(() => store.list(P1, { limit: 1, cursor: other }));
      },
    },
    {
      name: 'scopes never mix: each person and each circle sees only its own entries',
      run: async (store) => {
        must(await store.append([entry(1), entry(2, { scope: P2 }), entry(3, { scope: C1 }), entry(4, { scope: { kind: 'circle', circleId: 'c0000000000000002' } }), entry(5, { scope: { kind: 'personal', userId: 'c0000000000000001' } })]));
        assert.deepEqual(ids(await everything(store, P1)), [lid(1)]);
        assert.deepEqual(ids(await everything(store, P2)), [lid(2)]);
        assert.deepEqual(ids(await everything(store, C1)), [lid(3)]);
        assert.deepEqual(ids(await everything(store, { kind: 'personal', userId: 'c0000000000000001' })), [lid(5)]);
        assert.deepEqual(await everything(store, { kind: 'personal', userId: 'u0000000000000003' }), []);
      },
    },
    {
      name: 'a batch is all or nothing: one bad entry keeps none of it',
      run: async (store) => {
        const r = await store.append([entry(1), entry(2), entry(3, { action: 'deleted' as never })]);
        assert.equal(code(r), 'INVALID_INPUT');
        assert.deepEqual(await everything(store, P1), []);
      },
    },
    {
      name: 'an id already used, or repeated in the batch, is refused and nothing from the batch is kept',
      run: async (store) => {
        must(await store.append([entry(1)]));
        assert.equal(code(await store.append([entry(2), entry(1, { subject: 'other' })])), 'INVALID_INPUT');
        assert.equal(code(await store.append([entry(3), entry(3)])), 'INVALID_INPUT');
        assert.deepEqual(ids(await everything(store, P1)), [lid(1)]);
        assert.equal((await everything(store, P1))[0]?.subject, 'note-1');
      },
    },
    {
      name: 'an id used in one scope cannot be reused in another',
      run: async (store) => {
        must(await store.append([entry(1)]));
        assert.equal(code(await store.append([entry(1, { scope: P2 })])), 'INVALID_INPUT');
        assert.deepEqual(await everything(store, P2), []);
      },
    },
    {
      name: 'every bad field is refused, naming nothing it was given',
      run: async (store) => {
        const bad: Array<Partial<LedgerEntry> & Record<string, unknown>> = [
          { id: '' }, { id: 'a b' }, { id: 'x'.repeat(129) }, { at: -1 }, { at: 1.5 }, { at: Number.NaN }, { at: '5' as never },
          { scope: { kind: 'other' } as never }, { scope: { kind: 'personal' } as never }, { scope: { kind: 'circle', circleId: '' } as never }, { scope: { kind: 'personal', userId: 'u1', extra: 1 } as never }, { scope: { kind: 'circle', circleId: 'c1', extra: 1 } as never },
          { actor: '' }, { actor: 'a b' }, { action: 'deleted' as never }, { kind: 'edge' as never }, { subject: '' }, { subject: 'x'.repeat(257) },
          { title: 'x'.repeat(201) }, { summary: 'x'.repeat(401) }, { title: 5 as never }, { summary: null as never }, { proposalId: '' }, { proposalId: 'a b' }, { surprise: 1 },
        ];
        for (const [i, change] of bad.entries()) assert.equal(code(await store.append([{ ...entry(i + 1), ...change } as LedgerEntry])), 'INVALID_INPUT', JSON.stringify(change));
        assert.equal(code(await store.append(['x' as never])), 'INVALID_INPUT');
        assert.equal(code(await store.append([null as never])), 'INVALID_INPUT');
        assert.deepEqual(await everything(store, P1), []);
      },
    },
    {
      name: 'the limits are exactly 200 characters of title, 400 of summary and 256 of subject, counted as characters',
      run: async (store) => {
        must(await store.append([entry(1, { title: 'x'.repeat(200), summary: 'y'.repeat(400), subject: 's'.repeat(256) })]));
        must(await store.append([entry(2, { title: '😀'.repeat(200), summary: '😀'.repeat(400), subject: '😀'.repeat(256) })]));
        assert.equal(code(await store.append([entry(3, { title: '😀'.repeat(201) })])), 'INVALID_INPUT');
        assert.equal(code(await store.append([entry(4, { summary: '😀'.repeat(401) })])), 'INVALID_INPUT');
        assert.equal(code(await store.append([entry(5, { subject: '😀'.repeat(257) })])), 'INVALID_INPUT');
        assert.equal((await everything(store, P1)).length, 2);
      },
    },
    {
      name: 'an input keeps its text exactly: emoji, new lines, markup, a lone surrogate and exactly 8,000 characters',
      run: async (store) => {
        const lone = `before${String.fromCharCode(0xd800)}after`;
        const inputs = [
          entry(1, { kind: 'input', subject: 'prop-1', text: 'Mum now takes 1 tablet 😀\n<b>daily</b> "quoted"' }),
          entry(2, { kind: 'input', subject: 'prop-2', text: lone }),
          entry(3, { kind: 'input', subject: 'prop-3', text: 'x'.repeat(8000) }),
          entry(4, { kind: 'input', subject: 'prop-4', text: '😀'.repeat(8000) }),
        ];
        must(await store.append(inputs));
        const got = await everything(store, P1);
        for (const e of inputs) assert.deepEqual(got.find((x) => x.id === e.id), e);
        assert.equal(got.find((x) => x.id === lid(2))?.text, lone);
      },
    },
    {
      name: 'an input needs text of 1 to 8,000 characters, is only ever added, and carries no title or summary; no other kind has text',
      run: async (store) => {
        const input = (n: number, extra: Record<string, unknown> = {}): LedgerEntry => ({ ...entry(n, { kind: 'input', subject: `prop-${n}`, text: 'a note' }), ...extra }) as LedgerEntry;
        const bad: LedgerEntry[] = [
          input(1, { text: undefined }), input(2, { text: '' }), input(3, { text: 'x'.repeat(8001) }), input(4, { text: '😀'.repeat(8001) }), input(5, { text: 5 as never }), input(6, { action: 'removed' }),
          input(7, { action: 'updated' }), input(8, { title: 't' }), input(9, { summary: 's' }),
          entry(10, { text: 'stray text' }), entry(11, { kind: 'category', text: 'stray text' }), entry(12, { text: '' }),
        ];
        for (const [i, e] of bad.entries()) assert.equal(code(await store.append([e])), 'INVALID_INPUT', `case ${i + 1}`);
        assert.deepEqual(await everything(store, P1), []);
        must(await store.append([input(20)]));
        assert.equal((await everything(store, P1)).length, 1);
      },
    },
    {
      name: 'inputs and facts in one batch are all or nothing, and an input is listed with its facts in time order',
      run: async (store) => {
        const facts = entry(2, { at: NOW + 11, subject: 'fact-a' });
        const input = entry(1, { at: NOW + 10, kind: 'input', subject: 'prop-9', text: 'the words', proposalId: 'prop-9' });
        assert.equal(code(await store.append([input, { ...facts, text: 'stray' } as LedgerEntry])), 'INVALID_INPUT');
        assert.deepEqual(await everything(store, P1), []);
        must(await store.append([input, facts]));
        assert.deepEqual(ids(await everything(store, P1)), [lid(2), lid(1)]);
      },
    },
    {
      name: 'an empty batch is fine and changes nothing',
      run: async (store) => {
        must(await store.append([]));
        assert.deepEqual(await everything(store, P1), []);
      },
    },
    {
      name: 'the store keeps its own copies: changing what was written, or what was read, changes nothing',
      run: async (store) => {
        const e = entry(1, { title: 'kept' });
        const scope = { ...P1 } as { kind: 'personal'; userId: string };
        must(await store.append([{ ...e, scope }]));
        (e as { title: string }).title = 'changed';
        scope.userId = 'u0000000000000099';
        const first = (await store.list(P1, { limit: 5, cursor: null })).items[0] as LedgerEntry;
        assert.equal(first.title, 'kept');
        (first as { title: string }).title = 'scribbled';
        (first.scope as { userId: string }).userId = 'u0000000000000098';
        const again = (await store.list(P1, { limit: 5, cursor: null })).items[0] as LedgerEntry;
        assert.equal(again.title, 'kept');
        assert.deepEqual(again.scope, P1);
      },
    },
    {
      name: 'purgeBefore removes entries strictly older than the time, says how many, and keeps the rest',
      run: async (store) => {
        must(await store.append([entry(1, { at: 100 }), entry(2, { at: 200 }), entry(3, { at: 200, scope: P2 }), entry(4, { at: 300 })]));
        assert.equal(await store.purgeBefore(200), 1);
        assert.deepEqual(ids(await everything(store, P1)), [lid(4), lid(2)]);
        assert.equal(await store.purgeBefore(201), 2);
        assert.deepEqual(ids(await everything(store, P1)), [lid(4)]);
        assert.deepEqual(ids(await everything(store, P2)), []);
        assert.equal(await store.purgeBefore(0), 0);
        assert.equal(await store.purgeBefore(1_000_000_000), 1);
      },
    },
    {
      name: 'a purged id can be used again',
      run: async (store) => {
        must(await store.append([entry(1, { at: 10 })]));
        await store.purgeBefore(20);
        must(await store.append([entry(1, { at: 30 })]));
        assert.deepEqual(ids(await everything(store, P1)), [lid(1)]);
      },
    },
    {
      name: 'removeScope removes only that scope, says how many, and is harmless when there is nothing',
      run: async (store) => {
        must(await store.append([entry(1), entry(2), entry(3, { scope: P2 }), entry(4, { scope: C1 })]));
        assert.equal(await store.removeScope(P1), 2);
        assert.deepEqual(await everything(store, P1), []);
        assert.deepEqual(ids(await everything(store, P2)), [lid(3)]);
        assert.deepEqual(ids(await everything(store, C1)), [lid(4)]);
        assert.equal(await store.removeScope(P1), 0);
        assert.equal(await store.removeScope({ kind: 'circle', circleId: 'c0000000000000077' }), 0);
        assert.equal(await store.removeScope(C1), 1);
      },
    },
    {
      name: 'a large batch is kept whole and listed in order',
      run: async (store) => {
        must(await store.append(Array.from({ length: 600 }, (_, i) => entry(i + 1, { at: 5000 + i }))));
        const all = await everything(store, P1, 50);
        assert.equal(all.length, 600);
        assert.equal(all[0]?.id, lid(600));
        assert.equal(all[599]?.id, lid(1));
      },
    },
    {
      name: 'simultaneous appends of different entries lose none',
      run: async (store) => {
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.append([entry(i + 1), entry(`b${i}`)])));
        assert.ok(results.every((r) => r.ok));
        assert.equal((await everything(store, P1, 5)).length, 24);
      },
    },
    {
      name: 'of simultaneous appends of the same id exactly one succeeds, and the batches are never half kept',
      run: async (store) => {
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.append([entry(`own${i}`), entry('shared', { subject: `who-${i}` })])));
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.equal(results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === 'INVALID_INPUT'), true);
        const all = await everything(store, P1, 5);
        assert.equal(all.length, 2);
        const winner = all.find((e) => e.id === lid('shared')) as LedgerEntry;
        assert.ok(all.some((e) => e.id === lid(`own${winner.subject.slice(4)}`)));
      },
    },
    {
      name: 'two stores share nothing',
      run: async (store, makeAnother) => {
        const other = await makeAnother();
        must(await store.append([entry(1)]));
        assert.deepEqual(await everything(other, P1), []);
        must(await other.append([entry(1)]));
        assert.equal(await other.purgeBefore(Number.MAX_SAFE_INTEGER), 1);
        assert.deepEqual(ids(await everything(store, P1)), [lid(1)]);
      },
    },
  ];
}
