import { describe, expect, it } from 'vitest';
import { parseControls, type Controls } from './controls/controls.js';
import { createLlm } from './create-llm.js';
import { createDemoModelClient } from './demo-client.js';
import { createScriptedModelClient } from './testing/index.js';
import { SHIPPED_CONTROLS, shippedFiles } from './testing/shipped-controls.test-util.js';

// R-012 D14: the demo model must not depend on the wording of the controls, which anyone may edit.

/** Every word of both prompts and both frames replaced, in a different order, with the settings unchanged. */
function rewritten(): Controls {
  const files = shippedFiles();
  files['categorise/system.txt'] = 'ZZ-A. Item {{itemId}}. Up to {{maxOps}}. Using {{allowedOps}}. ZZ-B.';
  files['categorise/frame.txt'] = 'ZZ-C\n{{requestBlock}}\nZZ-D\n{{contextBlock}}\nZZ-E';
  files['status/system.txt'] = 'ZZ-F. {{now}}. Entries {{entryCount}}. {{maxHeadline}} {{maxPoints}} {{maxPointChars}} {{maxRefs}} ZZ-G.';
  files['status/frame.txt'] = 'ZZ-H\n{{requestBlock}}\nZZ-I\n{{entriesBlock}}\nZZ-J';
  const r = parseControls(files);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}
const NOW = Date.UTC(2026, 9, 15, 7, 30);
const CATEGORIES = [{ id: 'health', data: { name: 'Health' } }, { id: 'travel', data: { name: 'Travel plans' } }];
const ENTRIES = [{ where: 'personal', text: 'Dentist appointment on Friday' }, { where: 'circle "Parent care"', text: 'Mum new tablets one a day' }];

describe('the demo model with completely different controls wording', () => {
  it('files a note exactly as it does with the shipped controls', async () => {
    const ask = (controls: Controls) => createLlm({ client: createDemoModelClient(), controls }).categorise({ text: 'Dr Patel booked my blood test for health', graphId: 'g', itemId: 'note-1', categories: CATEGORIES });
    const a = await ask(SHIPPED_CONTROLS);
    const b = await ask(rewritten());
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify(b.ok && b.value.mutation)).toBe(JSON.stringify(a.ok && a.value.mutation));
  });

  it('makes the same status, with the same day, count and points', async () => {
    const ask = (controls: Controls) => createLlm({ client: createDemoModelClient(), controls, now: () => NOW }).status({ text: 'Mum tablets', entries: ENTRIES, timeZone: 'Europe/London' });
    const a = await ask(SHIPPED_CONTROLS);
    const b = await ask(rewritten());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.headline).toBe(a.value.headline);
      expect(b.value.headline).toContain('Thursday 15 October 2026');
      expect(b.value.points).toEqual(a.value.points);
    }
  });

  it('the request really carried the rewritten words, and the facts as meta', async () => {
    const client = createScriptedModelClient([{ reply: JSON.stringify({ headline: 'h', points: [], nothing: true }) }]);
    await createLlm({ client, controls: rewritten(), now: () => NOW }).status({ text: 'x', entries: [], timeZone: 'UTC' });
    const sent = client.requests[0];
    expect(sent?.system).toBe('ZZ-F. Thursday 15 October 2026, 07:30 (UTC). Entries 0. 160 5 240 5 ZZ-G.');
    expect(sent?.messages[0]?.content).toBe('ZZ-H\n<request>\nx\n</request>\nZZ-I\n<entries>\n(there are no entries)\n</entries>\nZZ-J');
    expect(sent?.meta).toEqual({ capability: 'status', entryCount: 0, now: NOW, timeZone: 'UTC' });
  });

  it('the categoriser\'s meta carries the minted item id', async () => {
    const client = createScriptedModelClient([{ reply: JSON.stringify({ ops: [] }) }]);
    await createLlm({ client, controls: rewritten() }).categorise({ text: 'x', graphId: 'g', itemId: 'note-77', categories: [] });
    expect(client.requests[0]?.meta).toEqual({ capability: 'categorise', itemId: 'note-77' });
    expect(client.requests[0]?.system).toBe('ZZ-A. Item note-77. Up to 25. Using upsertNode, link. ZZ-B.');
  });
});
