import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../llm/index.js';
import { world, type World } from './controller.test-util.js';

// A circle's Pulse (R-016 D19 to D21): the predefined text comes from the server, never from the request.

const PULSE = 'Provide a status update for the circle. Keep the answer factual, stick to the point and be concise.';
async function note(w: World, who: string, text: string, circleId?: string): Promise<void> {
  const made = await w.caci.propose(w.tokens[who], { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  await w.caci.approve(w.tokens[who], made.value.id);
  w.now.value += 60_000;
}
const statusCalls = (w: World): ModelRequest[] => w.modelCalls.filter((c) => (c.system ?? '').startsWith('You are the status assistant'));
const requestsSent = (w: World): string[] => statusCalls(w).map((c) => /<request>\n?([\s\S]*?)\n?<\/request>/.exec(c.messages.map((m) => m.content).join('\n'))?.[1] ?? '');
const errorOf = (r: { ok: boolean; error?: unknown }): { source: string; error: { code: string; field?: string; message?: string } } => r.error as never;

async function story() {
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan'], pulseText: PULSE });
  const parent = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  const other = await w.circle(2, 'ann', [['bob', 'member']]);
  await note(w, 'ann', 'Dentist appointment on Friday morning');
  await note(w, 'ann', 'Mum new tablets one a day with food from Friday', parent);
  await note(w, 'bob', 'Inlaw hospital visit moved to Monday', other);
  return { w, parent, other };
}
const pulse = (w: World, who: string, circleId: string, extra: Record<string, unknown> = {}) => w.caci.status(w.tokens[who], { pulse: true, scope: { kind: 'circle', circleId }, ...extra });

describe('a pulse', () => {
  it('sends the server\'s text for that circle only, whoever asks (a member or an observer), and answers like a status', async () => {
    const { w, parent } = await story();
    for (const who of ['bob', 'cat']) {
      const r = await pulse(w, who, parent);
      expect(r.ok, who).toBe(true);
      if (r.ok) {
        expect(r.value.entriesUsed).toBe(1);
        expect(r.value.points.flatMap((p) => p.sources)).toEqual([{ kind: 'circle', circleId: parent, circleName: 'Circle 1' }]);
      }
    }
    expect(requestsSent(w)).toEqual([PULSE, PULSE]);
    const prompt = statusCalls(w).map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
    expect(prompt).toContain('Mum new tablets');
    expect(prompt).not.toContain('Dentist');
    expect(prompt).not.toContain('Inlaw hospital');
  });

  it('refuses text with a pulse, a pulse with no scope or a personal scope, and a pulse that is not true or false, each by name, asking nothing', async () => {
    const { w, parent } = await story();
    const before = w.modelCalls.length;
    expect(errorOf(await pulse(w, 'ann', parent, { text: 'my own words' })).error.field).toBe('text');
    expect(errorOf(await w.caci.status(w.tokens.ann, { pulse: true })).error.field).toBe('scope');
    expect(errorOf(await w.caci.status(w.tokens.ann, { pulse: true, scope: { kind: 'personal' } })).error.field).toBe('scope');
    expect(errorOf(await w.caci.status(w.tokens.ann, { pulse: 'yes', scope: { kind: 'circle', circleId: parent } })).error.field).toBe('pulse');
    expect(w.modelCalls.length).toBe(before);
  });

  it('pulse: false is an ordinary status and needs its own text', async () => {
    const { w, parent } = await story();
    expect((await pulse(w, 'ann', parent, { pulse: false, text: 'how are things' })).ok).toBe(true);
    expect(requestsSent(w)).toEqual(['how are things']);
    expect(errorOf(await pulse(w, 'ann', parent, { pulse: false })).error.field).toBe('text');
  });

  it('a stranger, a person in other circles only and a made-up circle get the one not-found, and nothing is asked', async () => {
    const { w, parent, other } = await story();
    const before = w.modelCalls.length;
    for (const [who, id] of [['dan', parent], ['cat', other], ['ann', 'c0000000000000999']] as const) {
      const r = await pulse(w, who, id);
      expect(r.ok ? undefined : r.error).toEqual({ source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } });
    }
    expect(w.modelCalls.length).toBe(before);
  });

  it('is unavailable when the service has no pulse text', async () => {
    const w = await world({ people: ['ann'] });
    const c = await w.circle(1, 'ann');
    const r = await pulse(w, 'ann', c);
    expect(errorOf(r).error).toEqual({ code: 'NOT_FOUND', message: 'pulse is not available' });
  });

  it('uses the same hourly allowance and one-at-a-time rule as a status', async () => {
    const w = await world({ people: ['ann'], pulseText: PULSE, limits: { statusPerHour: 2 } });
    const c = await w.circle(1, 'ann');
    expect((await pulse(w, 'ann', c)).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { text: 'x', scope: { kind: 'circle', circleId: c } })).ok).toBe(true);
    expect(errorOf(await pulse(w, 'ann', c)).error.code).toBe('THROTTLED');
  });

  it('refuses a pulse text that is blank or over 500 characters when the controller is made, and accepts exactly 500', async () => {
    for (const bad of ['', '   ', 'x'.repeat(501)]) await expect(world({ people: ['ann'], pulseText: bad }), JSON.stringify(bad.slice(0, 5))).rejects.toThrow(TypeError);
    await expect(world({ people: ['ann'], pulseText: 'x'.repeat(500) })).resolves.toBeDefined();
  });
});
