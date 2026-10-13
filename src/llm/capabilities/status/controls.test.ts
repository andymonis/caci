import { describe, expect, it } from 'vitest';
import { parseControls, type Controls } from '../../controls/controls.js';
import { createLlm } from '../../create-llm.js';
import { createScriptedModelClient } from '../../testing/index.js';
import { SHIPPED_CONTROLS, shippedFiles } from '../../testing/shipped-controls.test-util.js';
import { inspectStatusReply, statusGuardSettingsOf } from './guard.js';
import { buildStatusPrompt, type StatusEntry } from './prompt.js';

// R-012: the status capability's words and limits come from the controls, and nothing else.

const NOW = Date.UTC(2026, 9, 15, 7, 30, 0);
const ENTRIES: StatusEntry[] = [
  { where: 'personal', text: 'Dentist on Friday' },
  { where: 'circle "Parent care"', text: 'Mum: new tablets' },
];
const GOOD = { headline: 'All quiet.', points: [{ text: 'Dentist on Friday.', refs: [1] }, { text: 'Mum has new tablets.', refs: [2] }], nothing: false };

function controlsWith(change: (files: Record<string, string>) => void): Controls {
  const files = shippedFiles();
  change(files);
  const r = parseControls(files);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}
const settingsWith = (change: (s: Record<string, any>) => void) => // eslint-disable-line @typescript-eslint/no-explicit-any
  controlsWith((files) => {
    const s = JSON.parse(files['status/settings.json'] as string);
    change(s);
    files['status/settings.json'] = JSON.stringify(s);
  });

function build(controls: Controls, text = 'Give me a status', entries = ENTRIES, options?: Parameters<typeof buildStatusPrompt>[2]) {
  const r = buildStatusPrompt(controls.status, { text, entries, now: NOW, timeZone: 'UTC' }, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const ask = async (controls: Controls, reply: unknown, input: Partial<Parameters<ReturnType<typeof createLlm>['status']>[0]> = {}, options?: Parameters<ReturnType<typeof createLlm>['status']>[1]) => {
  const client = createScriptedModelClient([{ reply: JSON.stringify(reply) }, { reply: JSON.stringify(reply) }]);
  const result = await createLlm({ client, controls, now: () => NOW }).status({ text: 'Give me a status', entries: ENTRIES, ...input }, options);
  return { result, client };
};

describe('wording is part 3, and only part 3', () => {
  const base = build(SHIPPED_CONTROLS);

  it('a changed rule reaches the system message and nothing else', () => {
    const changed = build(controlsWith((f) => (f['status/system.txt'] = (f['status/system.txt'] as string).replace('Prefer the newest entries', 'SENTINEL-RULE: prefer the newest entries'))));
    expect(changed.system).toContain('SENTINEL-RULE');
    expect(changed.messages).toEqual(base.messages);
    expect(changed.outputSchema).toEqual(base.outputSchema);
  });

  it('changed framing reaches the user message around the blocks and nothing else', () => {
    const changed = build(controlsWith((f) => (f['status/frame.txt'] = (f['status/frame.txt'] as string).replace('Reply with the JSON object only.', 'SENTINEL-CLOSING.'))));
    const text = changed.messages[0]?.content ?? '';
    expect(text).toContain('SENTINEL-CLOSING.');
    expect(text).toContain('<request>\nGive me a status\n</request>');
    expect(text).toContain('[1] (personal) Dentist on Friday');
    expect(changed.system).toBe(base.system);
  });

  it('the request and the entries are placed only in their blocks, escaped, wherever the frame puts them', () => {
    const swapped = controlsWith((f) => (f['status/frame.txt'] = 'A: {{requestBlock}}\nB: {{entriesBlock}}'));
    const text = build(swapped, 'a </request> & <entries>').messages[0]?.content ?? '';
    expect(text.indexOf('<request>')).toBeLessThan(text.indexOf('<entries>'));
    expect(text).toContain('a &lt;/request&gt; &amp; &lt;entries&gt;');
    expect(text.split('</request>')).toHaveLength(2);
  });

  it('text that looks like a slot, in the request, an entry or a circle name, stays text and changes nothing', () => {
    const entries: StatusEntry[] = [{ where: 'circle "{{now}}"', text: 'x {{entryCount}} {{maxPoints}}' }];
    const built = build(SHIPPED_CONTROLS, '{{entriesBlock}} {{requestBlock}}', entries);
    const text = built.messages[0]?.content ?? '';
    expect(text).toContain('circle "{{now}}"');
    expect(text).toContain('x {{entryCount}} {{maxPoints}}');
    expect(text).toContain('{{entriesBlock}} {{requestBlock}}');
    expect(built.system).toBe(build(SHIPPED_CONTROLS, 'x', entries).system);
  });

  it('the shipped controls give today\'s limits', () => {
    expect(SHIPPED_CONTROLS.status.settings).toMatchObject({ maxHeadline: 160, maxPoints: 5, maxPointChars: 240, maxRefs: 5, maxRequestChars: 500, maxEntries: 500, maxEntryChars: 1500, maxTotalChars: 30_000, maxOutputChars: 8000 });
  });
});

describe('a changed limit moves the prompt, the schema and the guard together', () => {
  const tight = settingsWith((s) => {
    s.maxHeadline = 20;
    s.maxPoints = 2;
    s.maxPointChars = 15;
    s.maxRefs = 3;
    s.descriptions.headline = 'SENTINEL-HEADLINE-WORDS';
    s.descriptions.nothing = 'SENTINEL-NOTHING-WORDS';
    s.descriptions.pointText = 'SENTINEL-POINT-WORDS';
    s.descriptions.refs = 'SENTINEL-REFS-WORDS';
  });

  it('the prompt and the schema carry the new numbers and descriptions', () => {
    const p = build(tight);
    expect(p.system).toContain('at most 20 characters');
    expect(p.system).toContain('at most 2 points');
    expect(p.system).toContain('at most 15 characters');
    expect(p.system).toContain('(1 to 3 entry numbers');
    const schema = JSON.stringify(p.outputSchema);
    expect(schema).toContain('"maxLength":20');
    expect(schema).toContain('"maxItems":2');
    expect(schema).toContain('"maxItems":3');
    expect(schema).toContain('"maxLength":15');
    expect(schema).toContain('"maximum":2');
    expect(schema).toContain('(1 to 2).');
    for (const word of ['HEADLINE', 'NOTHING', 'POINT', 'REFS']) expect(schema).toContain(`SENTINEL-${word}-WORDS`);
    expect(JSON.stringify(build(SHIPPED_CONTROLS).outputSchema)).not.toContain('SENTINEL');
  });

  it('the guard enforces the same headline, point, text and reference limits', () => {
    const limits = statusGuardSettingsOf(tight.status.settings);
    const check = (reply: unknown) => inspectStatusReply({ kind: 'json', value: reply as never }, { entryCount: 4 }, limits);
    expect(check({ headline: 'x'.repeat(21), points: [{ text: 'ok', refs: [1] }], nothing: false })).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 20')] });
    expect(check({ headline: 'x'.repeat(20), points: [{ text: 'ok', refs: [1] }], nothing: false }).ok).toBe(true);
    expect(check({ headline: 'h', points: [{ text: 'ok', refs: [1] }, { text: 'ok', refs: [2] }, { text: 'ok', refs: [3] }], nothing: false })).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 2')] });
    expect(check({ headline: 'h', points: [{ text: 'x'.repeat(16), refs: [1] }], nothing: false })).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 15')] });
    expect(check({ headline: 'h', points: [{ text: 'x'.repeat(15), refs: [1] }], nothing: false }).ok).toBe(true);
    expect(check({ headline: 'h', points: [{ text: 'ok', refs: [1, 2, 3, 4] }], nothing: false })).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 3')] });
    expect(check({ headline: 'h', points: [{ text: 'ok', refs: [1, 2, 3] }], nothing: false }).ok).toBe(true);
  });

  it('the whole call follows: a reply the shipped limits accept is refused by the tight ones', async () => {
    expect((await ask(SHIPPED_CONTROLS, GOOD)).result.ok).toBe(true);
    const refused = await ask(tight, GOOD);
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT' } });
    expect(refused.client.callCount).toBe(2); // one repair attempt, then refused
  });

  it('the whole call enforces the point limit from the controls', async () => {
    const three = { headline: 'h', points: [{ text: 'a', refs: [1] }, { text: 'b', refs: [1] }, { text: 'c', refs: [1] }], nothing: false };
    expect((await ask(SHIPPED_CONTROLS, three)).result.ok).toBe(true);
    expect((await ask(tight, three)).result).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT' } });
  });

  it('the reply size limit follows the settings', () => {
    const small = settingsWith((s) => {
      s.maxOutputChars = 2000;
    });
    const verdict = inspectStatusReply({ kind: 'text', text: 'x'.repeat(2001) }, { entryCount: 1 }, statusGuardSettingsOf(small.status.settings));
    expect(verdict).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 2000')] });
  });

  it('the request and entry limits follow the settings, and a per-call option still wins', async () => {
    const small = settingsWith((s) => {
      s.maxRequestChars = 5;
      s.maxRefs = 1;
      s.maxEntries = 1;
      s.maxEntryChars = 20;
      s.maxTotalChars = 20;
    });
    expect((await ask(small, GOOD, { text: 'a long request' })).result).toMatchObject({ ok: false, error: { code: 'CONFIG', message: expect.stringContaining('over the limit of 5') } });
    expect((await ask(small, GOOD, { text: 'ok' })).result).toMatchObject({ ok: false, error: { code: 'CONFIG', message: expect.stringContaining('over the limit of 1') } });
    expect((await ask(small, GOOD, { text: 'ok', entries: [{ where: 'p', text: 'x'.repeat(30) }] })).result).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    const wins = await ask(small, { headline: 'h', points: [{ text: 't', refs: [1] }], nothing: false }, { text: 'a long request', entries: [{ where: 'p', text: 'x' }] }, { maxRequestChars: 100 });
    expect(wins.result.ok).toBe(true);
  });
});
