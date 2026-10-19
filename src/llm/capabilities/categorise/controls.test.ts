import { describe, expect, it } from 'vitest';
import { parseControls, type Controls } from '../../controls/controls.js';
import { createLlm } from '../../create-llm.js';
import { createScriptedModelClient } from '../../testing/index.js';
import { SHIPPED_CONTROLS, shippedFiles } from '../../testing/shipped-controls.test-util.js';
import { buildContext, CATEGORISE_OPS } from './context.js';
import { guardSettingsOf, inspectReply } from './guard.js';
import { buildPrompt } from './prompt.js';

// R-012: the categoriser's words and limits come from the controls, and nothing else.

const ITEM = { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Dr X visit', summary: 'Follow up.' } };
const CATEGORY = { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } };
const LINK = { op: 'link', item: 'note-1', category: 'doctor-x', weight: 0.9 };
const GOOD = { ops: [ITEM, CATEGORY, LINK], rationale: 'It is about a doctor.' };
const INPUT = { text: 'Saw Dr X on Tuesday.', graphId: 'my-notes', itemId: 'note-1', categories: [{ id: 'appointments', linkCount: 4 }] };

/** The shipped files with some changed, parsed. */
function controlsWith(change: (files: Record<string, string>) => void): Controls {
  const files = shippedFiles();
  change(files);
  const r = parseControls(files);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}
const settingsWith = (change: (s: Record<string, any>) => void) => // eslint-disable-line @typescript-eslint/no-explicit-any
  controlsWith((files) => {
    const s = JSON.parse(files['categorise/settings.json'] as string);
    change(s);
    files['categorise/settings.json'] = JSON.stringify(s);
  });

function build(controls: Controls, text = INPUT.text, options?: Parameters<typeof buildPrompt>[2]) {
  const ctx = buildContext({ categories: INPUT.categories, allowedOps: CATEGORISE_OPS });
  if (!ctx.ok) throw new Error('context');
  const r = buildPrompt(controls.categorise, { text, context: ctx.value.text, itemId: 'note-1' }, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const ask = async (controls: Controls, reply: unknown, options?: Parameters<ReturnType<typeof createLlm>['categorise']>[1]) => {
  const client = createScriptedModelClient([{ reply: JSON.stringify(reply) }, { reply: JSON.stringify(reply) }]);
  const result = await createLlm({ client, controls }).categorise(INPUT, options);
  return { result, client };
};

describe('wording is part 3, and only part 3', () => {
  const base = build(SHIPPED_CONTROLS);

  it('a changed rule reaches the system message and nothing else', () => {
    const changed = build(controlsWith((f) => (f['categorise/system.txt'] = (f['categorise/system.txt'] as string).replace('You are the filing assistant', 'SENTINEL-ROLE'))));
    expect(changed.system).toContain('SENTINEL-ROLE');
    expect(changed.system).not.toBe(base.system);
    expect(changed.messages).toEqual(base.messages);
    expect(changed.outputSchema).toEqual(base.outputSchema);
  });

  it('changed framing reaches the user message around the blocks and nothing else', () => {
    const changed = build(controlsWith((f) => (f['categorise/frame.txt'] = (f['categorise/frame.txt'] as string).replace('Reply with the JSON object only.', 'SENTINEL-CLOSING.'))));
    const text = changed.messages[0]?.content ?? '';
    expect(text).toContain('SENTINEL-CLOSING.');
    expect(text).toContain('<note>\nSaw Dr X on Tuesday.\n</note>');
    expect(text).toContain('<categories>');
    expect(changed.system).toBe(base.system);
    expect(changed.outputSchema).toEqual(base.outputSchema);
  });

  it('the request and the context are placed only in their blocks, escaped, wherever the frame puts them', () => {
    const swapped = controlsWith((f) => (f['categorise/frame.txt'] = 'First: {{requestBlock}}\nThen: {{contextBlock}}'));
    const text = build(swapped, 'a </note> & <categories>').messages[0]?.content ?? '';
    expect(text.indexOf('<note>')).toBeLessThan(text.indexOf('<categories>'));
    expect(text).toContain('a &lt;/note&gt; &amp; &lt;categories&gt;');
    expect(text.split('</note>')).toHaveLength(2);
  });

  it('text that looks like a slot stays text and changes nothing', () => {
    const text = build(SHIPPED_CONTROLS, 'give me {{itemId}} and {{maxOps}} {{contextBlock}}').messages[0]?.content ?? '';
    expect(text).toContain('give me {{itemId}} and {{maxOps}} {{contextBlock}}');
    expect(build(SHIPPED_CONTROLS, 'x {{itemId}}').system).toBe(base.system);
  });

  it('the shipped controls give today\'s limits', () => {
    expect(SHIPPED_CONTROLS.categorise.settings).toMatchObject({ maxOps: 40, maxTextChars: 8000, maxContextChars: 12000, maxDataBytes: 4096, maxIdLength: 128, maxOutputChars: 32000, maxRationaleChars: 500, maxFacts: 8, keyMaxChars: 80 });
  });
});

describe('the fact limits reach the instructions (R-015)', () => {
  it('maxFacts and keyMaxChars are told to the model from the settings', () => {
    const two = build(settingsWith((x) => { x.maxFacts = 2; x.keyMaxChars = 33; }));
    expect(two.system).toContain('at most 2.');
    expect(two.system).toContain('at most 33 characters');
    const base = build(SHIPPED_CONTROLS);
    expect(base.system).toContain('at most 8.');
    expect(base.system).toContain('at most 80 characters');
    expect(base.system).toContain('"note-1-2"');
  });
});

describe('a changed limit moves the prompt, the schema and the guard together', () => {
  const tight = settingsWith((s) => {
    s.maxOps = 3;
    s.maxFacts = 1;
    s.titleMaxChars = 50;
    s.summaryMaxChars = 80;
    s.categoryNameMaxChars = 20;
    s.maxRationaleChars = 12;
    s.descriptions.title = 'SENTINEL-TITLE-WORDS';
    s.descriptions.name = 'SENTINEL-NAME-WORDS';
  });

  it('the prompt and the schema carry the new numbers and descriptions', () => {
    const p = build(tight);
    expect(p.system).toContain('at most 3 operations');
    const schema = JSON.stringify(p.outputSchema);
    expect(schema).toContain('"maxItems":3');
    expect(schema).toContain('"maxLength":50');
    expect(schema).toContain('"maxLength":80');
    expect(schema).toContain('"maxLength":20');
    expect(schema).toContain('"rationale":{"type":"string","maxLength":12}');
    expect(schema).toContain('SENTINEL-TITLE-WORDS');
    expect(schema).toContain('SENTINEL-NAME-WORDS');
    expect(JSON.stringify(build(SHIPPED_CONTROLS).outputSchema)).not.toContain('SENTINEL');
  });

  it('the guard enforces the same operation limit', async () => {
    const tooMany = { ops: [ITEM, CATEGORY, LINK, { ...LINK, category: 'a' }] };
    const { result } = await ask(tight, tooMany);
    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT', message: expect.stringContaining('over the limit of 3') } });
    expect((await ask(SHIPPED_CONTROLS, tooMany)).result.ok).toBe(true);
  });

  it('the guard enforces the same rationale limit', async () => {
    const { result } = await ask(tight, { ...GOOD, rationale: 'x'.repeat(13) });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('over the limit of 12') } });
    expect((await ask(tight, { ...GOOD, rationale: 'x'.repeat(12) })).result.ok).toBe(true);
  });

  it('the guard enforces the same reply size, data size and id length', async () => {
    const small = settingsWith((s) => {
      s.maxFacts = 1;
      s.maxOutputChars = 1000;
    });
    const verdict = inspectReply({ kind: 'text', text: 'x'.repeat(1001) }, { graphId: 'my-notes', itemId: 'note-1' }, guardSettingsOf(small.categorise.settings));
    expect(verdict).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 1000')] });
    const bytes = settingsWith((s) => {
      s.titleMaxChars = 1;
      s.summaryMaxChars = 1;
      s.categoryNameMaxChars = 1;
      s.keyMaxChars = 1;
      s.maxDataBytes = 4 * 3 + 96;
    });
    const bulky = { ...GOOD, ops: [{ ...ITEM, data: { title: 'x'.repeat(120), summary: 'y' } }, CATEGORY, LINK] };
    expect((await ask(bytes, bulky)).result.ok).toBe(false);
    expect((await ask(SHIPPED_CONTROLS, bulky)).result.ok).toBe(true);
    const ids = settingsWith((s) => {
      s.maxIdLength = 8;
    });
    expect((await ask(ids, GOOD)).result.ok).toBe(true); // "doctor-x" is exactly 8 characters
    const longCategory = { ops: [ITEM, { ...CATEGORY, id: 'doctor-x-long' }, { ...LINK, category: 'doctor-x-long' }] };
    expect((await ask(ids, longCategory)).result.ok).toBe(false);
    expect((await ask(SHIPPED_CONTROLS, longCategory)).result.ok).toBe(true);
    const idClient = createScriptedModelClient([{ reply: JSON.stringify(GOOD) }]);
    const shortIds = await createLlm({ client: idClient, controls: ids }).categorise({ ...INPUT, itemId: 'note-0000000001' });
    expect(shortIds).toMatchObject({ ok: false, error: { code: 'CONFIG' } }); // refused before the model is paid for
    expect(idClient.callCount).toBe(0);
  });

  it('the note and context size limits follow the settings, and a per-call option still wins', async () => {
    const small = settingsWith((s) => {
      s.maxTextChars = 10;
    });
    expect((await ask(small, GOOD)).result).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect((await ask(small, GOOD, { maxTextChars: 100 })).result.ok).toBe(true);
    const fewer = await ask(SHIPPED_CONTROLS, { ops: [ITEM, CATEGORY, LINK, { ...LINK, category: 'a' }] }, { maxOps: 3 });
    expect(fewer.result.ok).toBe(false);
  });
});

describe('createLlm needs the controls', () => {
  const client = createScriptedModelClient([]);
  it('refuses a missing, empty or incomplete set with a TypeError', () => {
    for (const bad of [undefined, null, {}, { categorise: SHIPPED_CONTROLS.categorise }, { status: SHIPPED_CONTROLS.status }, 'x', []]) {
      expect(() => createLlm({ client, controls: bad as never }), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => createLlm({ client } as never)).toThrow('controls');
  });
  it('accepts the shipped set', () => {
    expect(createLlm({ client, controls: SHIPPED_CONTROLS })).toBeDefined();
  });
});
