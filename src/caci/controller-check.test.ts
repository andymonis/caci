import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../llm/index.js';
import { CHECK_HORIZON, CHECKS } from './index.js';
import { world, type World } from './controller.test-util.js';

// The three checks (R-018 D10, D11): the text comes from the server, the window from the code, the scope from the person.

const TEXTS = { pulse: 'WEEK-TEXT what needs attention?', 'coming-up': 'MONTH-TEXT what is coming up?', 'long-range': 'YEAR-TEXT what is on the radar?' };
async function note(w: World, who: string, text: string, circleId?: string): Promise<void> {
  const made = await w.caci.propose(w.tokens[who], { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  await w.caci.approve(w.tokens[who], made.value.id);
  w.now.value += 60_000;
}
const statusCalls = (w: World): ModelRequest[] => w.modelCalls.filter((c) => (c.system ?? '').startsWith('You are the status assistant'));
const requestsSent = (w: World): string[] => statusCalls(w).map((c) => /<request>\n?([\s\S]*?)\n?<\/request>/.exec(c.messages.map((m) => m.content).join('\n'))?.[1] ?? '');
const errorOf = (r: { ok: boolean; error?: unknown }): { source: string; error: { code: string; field?: string; message?: string } } => r.error as never;
const check = (w: World, who: string, name: unknown, extra: Record<string, unknown> = {}) => w.caci.status(w.tokens[who], { check: name, ...extra });

// the test clock starts on Tuesday 14 November 2023
async function story(extra: { checkTexts?: Record<string, string>; pulseText?: string } = {}) {
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan'], checkTexts: TEXTS, ...extra });
  const parent = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  await note(w, 'ann', 'Dentist appointment on Friday morning');
  await note(w, 'ann', 'Rent payment due 1 Dec 2023');
  await note(w, 'ann', 'Passport renewal due 1 Feb 2024');
  await note(w, 'ann', 'Mum takes new tablets one a day with food', parent);
  await note(w, 'bob', 'Hospital visit on Thursday', parent);
  return { w, parent };
}

describe('the three checks', () => {
  it('are the three names, over a week, a month and a year', () => {
    expect([...CHECKS]).toEqual(['pulse', 'coming-up', 'long-range']);
    expect(CHECK_HORIZON).toEqual({ pulse: 'week', 'coming-up': 'month', 'long-range': 'year' });
  });

  it('send the server\'s text for that check and state the window the code worked out, whatever the person sends', async () => {
    const { w } = await story();
    for (const name of CHECKS) expect((await check(w, 'ann', name)).ok, name).toBe(true);
    expect(requestsSent(w)).toEqual([TEXTS.pulse, TEXTS['coming-up'], TEXTS['long-range']]);
    const systems = statusCalls(w).map((c) => c.system ?? '');
    expect(systems[0]).toContain('one-week check. Answer only about Tuesday 14 November to Monday 20 November 2023 (2023-11-14 to 2023-11-20)');
    expect(systems[1]).toContain('one-month check. Answer only about Tuesday 14 November to Thursday 14 December 2023 (2023-11-14 to 2023-12-14)');
    expect(systems[2]).toContain('one-year check. Answer only about Tuesday 14 November 2023 to Thursday 14 November 2024 (2023-11-14 to 2024-11-14)');
  });

  it('the week says only what falls in the week, the month adds the rent, the year adds the passport (the demo model reads the dates)', async () => {
    const { w } = await story();
    const week = await check(w, 'ann', 'pulse');
    const month = await check(w, 'ann', 'coming-up');
    const year = await check(w, 'ann', 'long-range');
    const texts = (r: Awaited<typeof week>) => (r.ok ? r.value.points.map((p) => p.text) : []);
    expect(texts(week).some((t) => t.includes('Dentist')) && texts(week).some((t) => t.includes('Hospital'))).toBe(true);
    expect(texts(week).some((t) => t.includes('Rent') || t.includes('Passport'))).toBe(false);
    expect(texts(month).some((t) => t.includes('Rent'))).toBe(true);
    expect(texts(month).some((t) => t.includes('Passport'))).toBe(false);
    expect(texts(year).some((t) => t.includes('Passport'))).toBe(true);
  });

  it('are silent when nothing falls in the window: one line, no points', async () => {
    const w = await world({ people: ['ann'], checkTexts: TEXTS });
    await note(w, 'ann', 'Rent payment due 1 Feb 2024');
    const week = await check(w, 'ann', 'pulse');
    const month = await check(w, 'ann', 'coming-up');
    expect(week.ok && week.value).toMatchObject({ nothing: true, points: [], headline: 'Nothing needs your attention this week.' });
    expect(month.ok && month.value).toMatchObject({ nothing: true, points: [] });
    const year = await check(w, 'ann', 'long-range');
    expect(year.ok && year.value.nothing).toBe(false);
  });

  it('may be asked of every brain (no scope), the own brain, or one circle, with the same read rules as a status', async () => {
    const { w, parent } = await story();
    const all = await check(w, 'bob', 'pulse');
    expect(all.ok && all.value.entriesUsed).toBe(2); // bob has no personal notes; both circle notes count
    const prompt = (n: number) => (statusCalls(w)[n] as ModelRequest).messages.map((m) => m.content).join('\n');
    const own = await check(w, 'ann', 'pulse', { scope: { kind: 'personal' } });
    expect(own.ok).toBe(true);
    expect(prompt(1)).toContain('Dentist');
    expect(prompt(1)).not.toContain('Hospital visit');
    for (const who of ['ann', 'bob', 'cat']) expect((await check(w, who, 'pulse', { scope: { kind: 'circle', circleId: parent } })).ok, who).toBe(true);
    const lastPrompt = prompt(statusCalls(w).length - 1);
    expect(lastPrompt).toContain('Hospital visit');
    expect(lastPrompt).not.toContain('Dentist');
  });

  it('a stranger, a made-up circle and a non-text check get the same answers as a status would, nothing asked', async () => {
    const { w, parent } = await story();
    const before = w.modelCalls.length;
    const stranger = await check(w, 'dan', 'pulse', { scope: { kind: 'circle', circleId: parent } });
    const made = await check(w, 'dan', 'pulse', { scope: { kind: 'circle', circleId: 'c0000000000000999' } });
    expect(errorOf(stranger).error.code).toBe('NOT_FOUND');
    expect(errorOf(made)).toEqual(errorOf(stranger));
    expect(w.modelCalls.length).toBe(before);
  });

  it('refuse an unknown or non-text check, text with a check, a check with a pulse, and an unavailable check, each by name, asking nothing', async () => {
    const { w } = await story({ checkTexts: { pulse: TEXTS.pulse } });
    const before = w.modelCalls.length;
    for (const bad of ['day', 'Pulse', '', 'toString', 5, null, true, {}]) expect(errorOf(await check(w, 'ann', bad)).error, String(bad)).toMatchObject({ code: 'INVALID_INPUT', field: 'check' });
    expect(errorOf(await check(w, 'ann', 'pulse', { text: 'my own words' })).error).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
    expect(errorOf(await check(w, 'ann', 'pulse', { pulse: true })).error).toMatchObject({ code: 'INVALID_INPUT', field: 'check' });
    expect(errorOf(await check(w, 'ann', 'coming-up')).error).toMatchObject({ code: 'NOT_FOUND' });
    expect(errorOf(await check(w, 'ann', 'long-range')).error.message).toContain('long-range');
    expect(errorOf(await w.caci.status(w.tokens.ann, { check: 'pulse', extra: 1 } as never)).error).toMatchObject({ code: 'INVALID_INPUT', field: 'extra' });
    expect(w.modelCalls.length).toBe(before);
  });

  it('the legacy pulse: true is the week check (the window is stated) with the same text and the circle scope rule', async () => {
    const { w, parent } = await story({ pulseText: 'LEGACY-PULSE-TEXT' });
    const r = await w.caci.status(w.tokens.ann, { pulse: true, scope: { kind: 'circle', circleId: parent } });
    expect(r.ok).toBe(true);
    expect(requestsSent(w)).toEqual(['LEGACY-PULSE-TEXT']);
    expect((statusCalls(w)[0] as ModelRequest).system).toContain('one-week check');
    expect(errorOf(await w.caci.status(w.tokens.ann, { pulse: true })).error).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
  });

  it('the legacy pulse also works when only checkTexts was given, using its pulse text', async () => {
    const { w, parent } = await story();
    const r = await w.caci.status(w.tokens.ann, { pulse: true, scope: { kind: 'circle', circleId: parent } });
    expect(r.ok).toBe(true);
    expect(requestsSent(w)).toEqual([TEXTS.pulse]);
  });

  it('an ordinary status has no window and sends the person\'s own words', async () => {
    const { w } = await story();
    await w.caci.status(w.tokens.ann, { text: 'How are things?' });
    expect(requestsSent(w)).toEqual(['How are things?']);
    expect((statusCalls(w)[0] as ModelRequest).system).not.toContain('check. Answer only about');
  });

  it('count against the same hourly limit and one-at-a-time rule as a status, and write nothing', async () => {
    const w = await world({ people: ['ann'], checkTexts: TEXTS, limits: { statusPerHour: 2 } });
    await note(w, 'ann', 'Dentist on Friday');
    expect((await check(w, 'ann', 'pulse')).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { text: 'hello' })).ok).toBe(true);
    expect(errorOf(await check(w, 'ann', 'coming-up')).error.code).toBe('THROTTLED');
    const s = await w.caci.summary(w.tokens.ann);
    expect(s.ok && s.value.itemCount).toBeGreaterThan(0);
  });

  it('a check text given at construction is validated: an unknown name, an empty text or one over 500 characters is a TypeError', async () => {
    for (const checkTexts of [{ day: 'x' }, { pulse: '' }, { 'coming-up': '   ' }, { 'long-range': 'x'.repeat(501) }, { pulse: 5 as never }]) {
      await expect(world({ checkTexts: checkTexts as Record<string, string> }), JSON.stringify(checkTexts).slice(0, 30)).rejects.toThrow(TypeError);
    }
    await expect(world({ checkTexts: { pulse: 'x'.repeat(500), 'coming-up': '😀'.repeat(500) } })).resolves.toBeDefined();
  });

  it('pulseText and checkTexts.pulse are the same text; pulseText wins when both are given', async () => {
    const w = await world({ people: ['ann'], pulseText: 'FROM-PULSE-TEXT', checkTexts: { pulse: 'FROM-CHECK-TEXTS' } });
    await note(w, 'ann', 'Dentist on Friday');
    await check(w, 'ann', 'pulse');
    expect(requestsSent(w)).toEqual(['FROM-PULSE-TEXT']);
  });
});
