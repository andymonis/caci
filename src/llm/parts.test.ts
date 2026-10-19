import { describe, expect, it } from 'vitest';
import { parseControls, type Controls } from './controls/controls.js';
import { createLlm } from './create-llm.js';
import { createScriptedModelClient } from './testing/index.js';
import { shippedFiles } from './testing/shipped-controls.test-util.js';
import type { TraceEvent } from './trace.js';

// R-012 CL-FR-01, CL-FR-09, CL-AC-08, CL-AC-11: every message to a model is exactly three parts, kept separate.

const NOW = Date.UTC(2026, 9, 15, 7, 30);

/** Controls whose every word is a sentinel, so anything else in a message is something code put there. */
function sentinel(): Controls {
  const files = shippedFiles();
  files['categorise/system.txt'] = 'CSYS item={{itemId}} max={{maxOps}} ops={{allowedOps}}';
  files['categorise/frame.txt'] = 'CF1\n{{contextBlock}}\nCF2\n{{requestBlock}}\nCF3';
  files['status/system.txt'] = 'SSYS now={{now}} n={{entryCount}} h={{maxHeadline}} p={{maxPoints}} c={{maxPointChars}} r={{maxRefs}}';
  files['status/frame.txt'] = 'SF1\n{{entriesBlock}}\nSF2\n{{requestBlock}}\nSF3';
  const r = parseControls(files);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}

const GOOD_CAT = { ops: [{ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 't', summary: 's' } }, { op: 'upsertNode', partition: 'category', id: 'c1', data: { name: 'C' } }, { op: 'link', item: 'note-1', category: 'c1' }] };
const GOOD_STATUS = { headline: 'h', points: [], nothing: true };

async function filing(controls: Controls, text = 'a note', categories = [{ id: 'health', data: { name: 'Health' } }]) {
  const events: TraceEvent[] = [];
  const client = createScriptedModelClient([{ reply: JSON.stringify(GOOD_CAT) }]);
  await createLlm({ client, controls }).categorise({ text, graphId: 'g', itemId: 'note-1', categories }, { trace: (e) => void events.push(e) });
  const prompt = events.find((e) => e.type === 'prompt');
  if (prompt?.type !== 'prompt') throw new Error('no prompt event');
  const sent = client.requests[0];
  if (sent === undefined) throw new Error('no request');
  return { prompt, sent };
}
async function statusing(controls: Controls, text = 'a request', entries = [{ where: 'personal', text: 'Dentist' }]) {
  const events: TraceEvent[] = [];
  const client = createScriptedModelClient([{ reply: JSON.stringify(GOOD_STATUS) }]);
  await createLlm({ client, controls, now: () => NOW }).status({ text, entries, timeZone: 'UTC' }, { trace: (e) => void events.push(e) });
  const prompt = events.find((e) => e.type === 'prompt');
  if (prompt?.type !== 'prompt') throw new Error('no prompt event');
  const sent = client.requests[0];
  if (sent === undefined) throw new Error('no request');
  return { prompt, sent };
}

describe('the categoriser sends exactly three parts', () => {
  it('the system message is the controls and code\'s slot values, nothing else', async () => {
    const { sent } = await filing(sentinel());
    expect(sent.system).toBe('CSYS item=note-1 max=40 ops=upsertNode, link');
  });

  it('the user message is the controls\' frame around the two blocks, nothing else', async () => {
    const { sent, prompt } = await filing(sentinel(), 'Dr <X> & me');
    const request = '<note>\nDr &lt;X&gt; &amp; me\n</note>';
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]?.content).toBe(`CF1\n${prompt.parts.context}\nCF2\n${request}\nCF3`);
    expect(prompt.parts.request).toBe(request);
    expect(prompt.parts.context.startsWith('<categories>\n')).toBe(true);
    expect(prompt.parts.context.endsWith('\n</categories>')).toBe(true);
  });

  it('the trace gives the three parts separately, as frozen copies, and they add up to what was sent', async () => {
    const { sent, prompt } = await filing(sentinel());
    expect(prompt.parts.controls).toEqual({ system: sent.system, frame: 'CF1\n{{contextBlock}}\nCF2\n{{requestBlock}}\nCF3' });
    expect(Object.isFrozen(prompt) && Object.isFrozen(prompt.parts) && Object.isFrozen(prompt.parts.controls)).toBe(true);
    expect(prompt.system).toBe(sent.system);
    expect(prompt.messages).toEqual(sent.messages);
  });

  it('changing only the request changes only the request part; only the context, only the context; only the controls, only the controls', async () => {
    const base = await filing(sentinel());
    const request = await filing(sentinel(), 'a different note');
    expect(request.prompt.parts.context).toBe(base.prompt.parts.context);
    expect(request.prompt.parts.controls).toEqual(base.prompt.parts.controls);
    expect(request.prompt.parts.request).not.toBe(base.prompt.parts.request);
    const context = await filing(sentinel(), 'a note', [{ id: 'travel', data: { name: 'Travel' } }]);
    expect(context.prompt.parts.request).toBe(base.prompt.parts.request);
    expect(context.prompt.parts.controls).toEqual(base.prompt.parts.controls);
    expect(context.prompt.parts.context).not.toBe(base.prompt.parts.context);
    const files = shippedFiles();
    files['categorise/system.txt'] = 'OTHER {{itemId}} {{maxOps}} {{allowedOps}}';
    const edited = parseControls({ ...sentinelFiles(), 'categorise/system.txt': files['categorise/system.txt'] });
    if (!edited.ok) throw new Error('parse');
    const controls = await filing(edited.value);
    expect(controls.prompt.parts.request).toBe(base.prompt.parts.request);
    expect(controls.prompt.parts.context).toBe(base.prompt.parts.context);
    expect(controls.prompt.parts.controls.system).not.toBe(base.prompt.parts.controls.system);
  });
});

function sentinelFiles(): Record<string, string> {
  const files = shippedFiles();
  files['categorise/system.txt'] = 'CSYS item={{itemId}} max={{maxOps}} ops={{allowedOps}}';
  files['categorise/frame.txt'] = 'CF1\n{{contextBlock}}\nCF2\n{{requestBlock}}\nCF3';
  files['status/system.txt'] = 'SSYS now={{now}} n={{entryCount}} h={{maxHeadline}} p={{maxPoints}} c={{maxPointChars}} r={{maxRefs}}';
  files['status/frame.txt'] = 'SF1\n{{entriesBlock}}\nSF2\n{{requestBlock}}\nSF3';
  return files;
}

describe('the status capability sends exactly three parts', () => {
  it('the system message and the user message are the controls and the blocks, nothing else', async () => {
    const { sent, prompt } = await statusing(sentinel(), 'How is <Mum>?');
    expect(sent.system).toBe('SSYS now=Thursday 15 October 2026, 07:30 (UTC) n=1 h=160 p=5 c=240 r=5');
    const request = '<request>\nHow is &lt;Mum&gt;?\n</request>';
    expect(sent.messages[0]?.content).toBe(`SF1\n${prompt.parts.context}\nSF2\n${request}\nSF3`);
    expect(prompt.parts.context).toBe('<entries>\n[1] (personal) Dentist\n</entries>');
    expect(prompt.parts.request).toBe(request);
    expect(prompt.parts.controls).toEqual({ system: sent.system, frame: 'SF1\n{{entriesBlock}}\nSF2\n{{requestBlock}}\nSF3' });
    expect(Object.isFrozen(prompt.parts)).toBe(true);
  });

  it('each part changes alone', async () => {
    const base = await statusing(sentinel());
    const request = await statusing(sentinel(), 'other');
    expect([request.prompt.parts.context, request.prompt.parts.controls]).toEqual([base.prompt.parts.context, base.prompt.parts.controls]);
    expect(request.prompt.parts.request).not.toBe(base.prompt.parts.request);
    const context = await statusing(sentinel(), 'a request', [{ where: 'personal', text: 'Something else' }]);
    expect([context.prompt.parts.request, context.prompt.parts.controls]).toEqual([base.prompt.parts.request, base.prompt.parts.controls]);
    expect(context.prompt.parts.context).not.toBe(base.prompt.parts.context);
    const edited = parseControls({ ...sentinelFiles(), 'status/frame.txt': 'NEW {{entriesBlock}} {{requestBlock}}' });
    if (!edited.ok) throw new Error('parse');
    const controls = await statusing(edited.value);
    expect([controls.prompt.parts.request, controls.prompt.parts.context]).toEqual([base.prompt.parts.request, base.prompt.parts.context]);
    expect(controls.prompt.parts.controls.frame).toBe('NEW {{entriesBlock}} {{requestBlock}}');
  });

  it('the empty context is still a block, in its place', async () => {
    const { sent, prompt } = await statusing(sentinel(), 'x', []);
    expect(prompt.parts.context).toBe('<entries>\n(there are no entries)\n</entries>');
    expect(sent.messages[0]?.content).toContain('SF1\n<entries>\n(there are no entries)\n</entries>\nSF2');
  });
});

describe('the repair turn is the one other thing code adds, and it is only the guard\'s reasons and a fixed closing line', () => {
  it('categorise: the second message list is the first message, the rejected reply, and the numbered reasons', async () => {
    const client = createScriptedModelClient([{ reply: JSON.stringify({ ops: [] }) }, { reply: JSON.stringify(GOOD_CAT) }]);
    await createLlm({ client, controls: sentinel() }).categorise({ text: 'a note', graphId: 'g', itemId: 'note-1', categories: [] });
    const [first, second] = client.requests;
    expect(second?.system).toBe(first?.system);
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[0]).toEqual(first?.messages[0]);
    expect(second?.messages[1]?.role).toBe('assistant');
    expect(second?.messages[2]?.role).toBe('user');
    expect(second?.messages[2]?.content).toMatch(/^The reply was not accepted: \(1\) .*\nReply again with the corrected JSON object only\.$/s);
  });

  it('status: the same shape', async () => {
    const client = createScriptedModelClient([{ reply: JSON.stringify({ headline: '', points: [], nothing: false }) }, { reply: JSON.stringify(GOOD_STATUS) }]);
    await createLlm({ client, controls: sentinel(), now: () => NOW }).status({ text: 'x', entries: [], timeZone: 'UTC' });
    const second = client.requests[1];
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[2]?.content).toMatch(/^The reply was not accepted: \(1\) .*\nReply again with the corrected JSON object only\.$/s);
  });
});
