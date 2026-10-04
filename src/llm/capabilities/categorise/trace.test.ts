import { describe, expect, it } from 'vitest';
import { createLlm } from '../../create-llm.js';
import { createScriptedModelClient, type ScriptStep } from '../../testing/index.js';
import type { CategoriseEvent } from './categorise.js';

const GOOD = {
  ops: [
    { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Dr X', summary: 'Follow up.' } },
    { op: 'link', item: 'note-1', category: 'health', weight: 0.9 },
  ],
  rationale: 'Health related.',
};
const BAD = { ops: [{ op: 'deleteNode', partition: 'item', id: 'note-9' }, { op: 'dropGraph' }] };
const reply = (value: unknown, usage = { inputTokens: 10, outputTokens: 5 }): ScriptStep => ({ reply: JSON.stringify(value), usage });
const INPUT = { text: 'Saw Dr X on Tuesday.', graphId: 'notes', itemId: 'note-1', categories: [{ id: 'health', data: { name: 'Health' } }] };

async function traced(script: Parameters<typeof createScriptedModelClient>[0], options: Record<string, unknown> = {}, now?: () => number) {
  const client = createScriptedModelClient(script);
  const events: CategoriseEvent[] = [];
  const llm = createLlm({ client, ...(now === undefined ? {} : { now }) });
  const result = await llm.categorise(INPUT, { ...options, trace: (e: CategoriseEvent) => void events.push(e) } as never);
  return { client, events, result };
}
const types = (events: readonly CategoriseEvent[]): string[] => events.map((e) => e.type);

describe('the trace of a call', () => {
  it('tells the whole story of a good first answer, in order', async () => {
    const { events, result } = await traced([reply(GOOD)]);
    expect(result.ok).toBe(true);
    expect(types(events)).toEqual(['prompt', 'request', 'response', 'verdict', 'done']);
  });

  it('the prompt event holds what was built to send', async () => {
    const { events, client } = await traced([reply(GOOD)]);
    const prompt = events[0];
    expect(prompt).toMatchObject({ type: 'prompt' });
    if (prompt?.type !== 'prompt') return;
    expect(prompt.system).toBe(client.requests[0]?.system);
    expect(prompt.messages).toEqual(client.requests[0]?.messages);
    expect(prompt.schema).toEqual(client.requests[0]?.outputSchema);
    expect(prompt.messages[0]?.content).toContain('Saw Dr X on Tuesday.');
    expect(prompt.messages[0]?.content).toContain('{"id":"health","data":{"name":"Health"}}');
  });

  it('the request event names the attempt, the model, the time left and the messages sent', async () => {
    const { events, client } = await traced([reply(GOOD)], { tier: 'balanced', timeoutMs: 9000 });
    const request = events[1];
    expect(request).toMatchObject({ type: 'request', attempt: 1, model: 'claude-sonnet-5-5' });
    if (request?.type !== 'request') return;
    expect(request.timeoutMs).toBe(client.requests[0]?.timeoutMs);
    expect(request.timeoutMs).toBeLessThanOrEqual(9000);
    expect(request.messages).toEqual(client.requests[0]?.messages);
  });

  it('the response event holds the raw output, tokens, the answering model and the time taken', async () => {
    let clock = 1000;
    const { events } = await traced([{ ...reply(GOOD, { inputTokens: 123, outputTokens: 45 }), model: 'served-model' }, ], {}, () => (clock += 50));
    const response = events.find((e) => e.type === 'response');
    expect(response).toMatchObject({ type: 'response', attempt: 1, output: { kind: 'json', value: GOOD }, usage: { inputTokens: 123, outputTokens: 45 }, model: 'served-model' });
    expect(response?.type === 'response' && response.elapsedMs).toBeGreaterThan(0);
  });

  it('a good reply has an accepted verdict with no problems', async () => {
    const { events } = await traced([reply(GOOD)]);
    expect(events.find((e) => e.type === 'verdict')).toEqual({ type: 'verdict', attempt: 1, accepted: true, problems: [] });
  });

  it('done says how it went and how many calls were made', async () => {
    const { events } = await traced([reply(GOOD)]);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true, attempts: 1 });
    expect(events.at(-1)).not.toHaveProperty('error');
  });
});

describe('the repair path', () => {
  it('shows both attempts, the problems found, and the feedback sent back, in order', async () => {
    const { events, client } = await traced([reply(BAD), reply(GOOD)]);
    expect(types(events)).toEqual(['prompt', 'request', 'response', 'verdict', 'repair', 'request', 'response', 'verdict', 'done']);
    const firstVerdict = events[3];
    expect(firstVerdict).toMatchObject({ type: 'verdict', attempt: 1, accepted: false });
    if (firstVerdict?.type !== 'verdict') return;
    expect(firstVerdict.problems.length).toBeGreaterThanOrEqual(2);
    expect(firstVerdict.problems.join('\n')).toContain('deleteNode');
    expect(firstVerdict.problems.join('\n')).toContain('dropGraph');
    const repair = events[4];
    expect(repair?.type === 'repair' && repair.feedback).toBe(client.requests[1]?.messages[2]?.content);
    expect(events[5]).toMatchObject({ type: 'request', attempt: 2 });
    expect(events[5]?.type === 'request' && events[5].messages).toEqual(client.requests[1]?.messages);
    expect(events[7]).toMatchObject({ type: 'verdict', attempt: 2, accepted: true });
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true, attempts: 2 });
  });

  it('lists every problem, not just the first five the feedback shows', async () => {
    const many = { ops: Array.from({ length: 8 }, () => ({ op: 'deleteNode' })) };
    const { events } = await traced([reply(many), reply(GOOD)]);
    const verdict = events.find((e) => e.type === 'verdict');
    expect(verdict?.type === 'verdict' && verdict.problems.length).toBeGreaterThan(5);
    const repair = events.find((e) => e.type === 'repair');
    expect(repair?.type === 'repair' && repair.feedback).toContain('and ');
  });

  it('a second rejection ends with a rejected verdict and a failed done', async () => {
    const { events, result } = await traced([reply(BAD), reply(BAD)]);
    expect(result.ok).toBe(false);
    expect(types(events)).toEqual(['prompt', 'request', 'response', 'verdict', 'repair', 'request', 'response', 'verdict', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, attempts: 2, error: { code: 'BAD_OUTPUT' } });
  });
});

describe('failures', () => {
  it('a provider error is a failure event, then done; nothing about a verdict', async () => {
    const { events } = await traced([{ rateLimited: true, retryAfterMs: 500 }]);
    expect(types(events)).toEqual(['prompt', 'request', 'failure', 'done']);
    expect(events[2]).toMatchObject({ type: 'failure', attempt: 1, error: { code: 'RATE_LIMITED', retryAfterMs: 500 } });
    expect(events[3]).toMatchObject({ type: 'done', ok: false, attempts: 1, error: { code: 'RATE_LIMITED' } });
  });

  it('a failure in the repair attempt is attempt 2', async () => {
    const { events } = await traced([reply(BAD), { refusal: true }]);
    expect(types(events)).toEqual(['prompt', 'request', 'response', 'verdict', 'repair', 'request', 'failure', 'done']);
    expect(events[6]).toMatchObject({ type: 'failure', attempt: 2, error: { code: 'REFUSED' } });
  });

  it('a call refused before anything is built has only done', async () => {
    const events: CategoriseEvent[] = [];
    const llm = createLlm({ client: createScriptedModelClient([reply(GOOD)]) });
    await llm.categorise({ ...INPUT, text: '  ' }, { trace: (e) => void events.push(e) });
    expect(types(events)).toEqual(['done']);
    expect(events[0]).toMatchObject({ type: 'done', ok: false, attempts: 0, error: { code: 'CONFIG' } });
  });

  it('a call that runs out of time before the repair counts one attempt', async () => {
    let clock = 0;
    const base = createScriptedModelClient([reply(BAD), reply(GOOD)]);
    const events: CategoriseEvent[] = [];
    const client = { complete: async (q: Parameters<typeof base.complete>[0]) => ((clock += 5000), base.complete(q)) };
    await createLlm({ client, now: () => clock }).categorise(INPUT, { timeoutMs: 5000, trace: (e) => void events.push(e) });
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, attempts: 1, error: { code: 'TIMEOUT' } });
    expect(types(events)).toEqual(['prompt', 'request', 'response', 'verdict', 'repair', 'done']);
  });

  it('a failure reports how long the call took before it failed', async () => {
    let clock = 0;
    const client = { complete: async () => ((clock += 250), { ok: false as const, error: { code: 'MODEL_ERROR' as const, message: 'down', retryable: true } }) };
    const events: CategoriseEvent[] = [];
    await createLlm({ client, now: () => clock }).categorise(INPUT, { trace: (e) => void events.push(e) });
    expect(events.find((e) => e.type === 'failure')).toMatchObject({ type: 'failure', attempt: 1, elapsedMs: 250 });
    expect(events.at(-1)).toMatchObject({ type: 'done', elapsedMs: 250 });
  });

  it('a client that throws is traced as a failure', async () => {
    const events: CategoriseEvent[] = [];
    const llm = createLlm({ client: { complete: () => { throw new Error('boom'); } } });
    await llm.categorise(INPUT, { trace: (e) => void events.push(e) });
    expect(events.find((e) => e.type === 'failure')).toMatchObject({ error: { code: 'MODEL_ERROR' } });
  });
});

describe('the trace cannot change the call', () => {
  it('a callback that throws changes nothing', async () => {
    const client = createScriptedModelClient([reply(BAD), reply(GOOD)]);
    const withThrow = await createLlm({ client }).categorise(INPUT, { trace: () => { throw new Error('nope'); } });
    const plain = await createLlm({ client: createScriptedModelClient([reply(BAD), reply(GOOD)]) }).categorise(INPUT);
    expect(withThrow).toEqual(plain);
  });

  it('a callback that rejects changes nothing and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): number => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const r = await createLlm({ client: createScriptedModelClient([reply(GOOD)]) }).categorise(INPUT, { trace: () => Promise.reject(new Error('async nope')) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(r.ok).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('no callback: the same result as with one', async () => {
    const withTrace = await traced([reply(BAD), reply(GOOD)]);
    const without = await createLlm({ client: createScriptedModelClient([reply(BAD), reply(GOOD)]) }).categorise(INPUT);
    expect(withTrace.result).toEqual(without);
  });

  it('events are copies: changing them changes nothing about the request or the result', async () => {
    const client = createScriptedModelClient([reply(BAD), reply(GOOD)]);
    const llm = createLlm({ client });
    const r = await llm.categorise(INPUT, {
      trace: (e) => {
        try {
          if (e.type === 'prompt') {
            const first = (e.messages as unknown as Array<{ content: string }>)[0];
            if (first) first.content = 'TAMPERED';
            (e.schema as Record<string, unknown>).tampered = true;
          }
          if (e.type === 'request') (e.messages as unknown as unknown[]).length = 0;
          if (e.type === 'response') (e.output as { value?: unknown }).value = 'TAMPERED';
        } catch {
          // frozen: fine too
        }
      },
    });
    expect(r.ok).toBe(true);
    expect(client.requests[0]?.messages[0]?.content).toContain('Saw Dr X');
    expect(client.requests[1]?.messages).toHaveLength(3);
    expect(JSON.stringify(client.requests[0]?.outputSchema)).not.toContain('tampered');
  });

  it('events are frozen', async () => {
    const { events } = await traced([reply(GOOD)]);
    for (const e of events) expect(Object.isFrozen(e)).toBe(true);
  });

  it('events from one call are not shared with the next', async () => {
    const a = await traced([reply(GOOD)]);
    const b = await traced([reply(GOOD)]);
    expect(a.events[0]).not.toBe(b.events[0]);
    expect(a.events[0]).toEqual(b.events[0]);
  });

  it('a trace that is not a function is a CONFIG error before any call', async () => {
    const client = createScriptedModelClient([reply(GOOD)]);
    const r = await createLlm({ client }).categorise(INPUT, { trace: 'log' as never });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(client.callCount).toBe(0);
  });

  it('the events never contain anything the call was not given (no environment, no key)', async () => {
    const { events } = await traced([reply(GOOD)]);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/sk-ant|apiKey|ANTHROPIC/);
  });

  it('a client that returns something that cannot be copied does not break the call', async () => {
    const events: CategoriseEvent[] = [];
    const llm = createLlm({ client: { complete: async () => ({ ok: true as const, value: { model: 'm', output: { kind: 'json' as const, value: (() => 1) as never }, usage: { inputTokens: 1, outputTokens: 1 } } }) } });
    const r = await llm.categorise(INPUT, { trace: (e) => void events.push(e) });
    expect(r.ok).toBe(false); // the reply is not acceptable, but the call ended cleanly
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
  });
});
