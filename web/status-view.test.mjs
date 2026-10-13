import { describe, expect, it } from 'vitest';
import { metaLine, pointText, requestCount, sourcesText, STATUS_CONTEXT, STATUS_LEFT_OUT, STATUS_MODE_LOADING, STATUS_MODE_UNKNOWN, STATUS_MODE_WORDS, STATUS_NOT_SAVED, STATUS_NOTHING, STATUS_SUGGESTIONS, statusModeNotice, withWait } from './status-view.js';

const C = (name) => ({ kind: 'circle', circleId: 'c0123456789abcdef', circleName: name });

describe('the words are exactly these', () => {
  it('the fixed sentences', () => {
    expect(STATUS_MODE_WORDS).toEqual({
      demo: 'Answered by the free demo model: nothing leaves this machine.',
      anthropic: "Answered by Anthropic's model: your request and the notes you can read, yours and your circles', are sent to Anthropic and are not anonymised.",
    });
    expect(STATUS_MODE_UNKNOWN).toBe('Could not tell which model answers.');
    expect(STATUS_MODE_LOADING).toBe('Checking which model answers…');
    expect(STATUS_CONTEXT).toBe('Your status uses everything you can read: your own notes and the circles you are in. It is sent with your request.');
    expect(STATUS_NOTHING).toBe('Nothing relevant was found in what you can read.');
    expect(STATUS_LEFT_OUT).toBe('Some notes were left out because there were too many; the newest were used.');
    expect(STATUS_NOT_SAVED).toBe('This is not saved anywhere. It is gone when you leave this screen.');
    expect(STATUS_SUGGESTIONS).toEqual(['Give me a morning status check', 'I am heading into town', 'What is happening this week?']);
    expect(Object.isFrozen(STATUS_SUGGESTIONS) && Object.isFrozen(STATUS_MODE_WORDS)).toBe(true);
  });
});

describe('the model notice', () => {
  it('follows the mode state, and anything odd is "could not tell"', () => {
    expect(statusModeNotice({ status: 'known', value: 'demo' })).toBe(STATUS_MODE_WORDS.demo);
    expect(statusModeNotice({ status: 'known', value: 'anthropic' })).toBe(STATUS_MODE_WORDS.anthropic);
    expect(statusModeNotice({ status: 'loading', value: null })).toBe(STATUS_MODE_LOADING);
    for (const odd of [undefined, null, {}, { status: 'unknown' }, { status: 'error', error: 'x' }, { status: 'known', value: 'other' }, { status: 'known', value: 'toString' }, { status: 'known', value: '__proto__' }, 5]) expect(statusModeNotice(odd), JSON.stringify(odd)).toBe(STATUS_MODE_UNKNOWN);
  });
});

describe('the count under the box', () => {
  it('is n / 500 with thousands handled and nonsense as 0', () => {
    expect(requestCount(0)).toBe('0 / 500');
    expect(requestCount(499)).toBe('499 / 500');
    for (const odd of [-1, 1.5, NaN, undefined, 'x']) expect(requestCount(odd), String(odd)).toBe('0 / 500');
  });
});

describe('where a point came from', () => {
  it('names each place once, circles in quotes and the personal brain as "your own notes"', () => {
    expect(sourcesText([{ kind: 'personal' }])).toBe('From: your own notes');
    expect(sourcesText([C('Parent care')])).toBe('From: "Parent care"');
    expect(sourcesText([C('Parent care'), { kind: 'personal' }, C('Parent care'), { kind: 'personal' }])).toBe('From: "Parent care", your own notes');
    expect(sourcesText([C('A'), C('B')])).toBe('From: "A", "B"');
  });
  it('a circle with no name is "a circle", and anything that is not a source is left out', () => {
    expect(sourcesText([{ kind: 'circle', circleId: 'c0123456789abcdef' }])).toBe('From: "a circle"');
    expect(sourcesText([{ kind: 'circle', circleName: '' }])).toBe('From: "a circle"');
    for (const odd of [[], undefined, null, 'x', {}, [null], [{}], [{ kind: 'other' }], [5]]) expect(sourcesText(odd), JSON.stringify(odd)).toBe('');
  });
  it('a point is its text with the places in brackets, or just the text when there are none', () => {
    expect(pointText({ text: 'Mum has new tablets.', sources: [C('Parent care')] })).toBe('Mum has new tablets. (From: "Parent care")');
    expect(pointText({ text: 'Alone.', sources: [] })).toBe('Alone.');
  });
  it('markup stays text', () => {
    expect(pointText({ text: '<b>x</b>', sources: [C('<i>y</i>')] })).toBe('<b>x</b> (From: "<i>y</i>")');
  });
});

describe('the small print', () => {
  it('says how many notes it was based on, singular and plural, and when it was made in UTC', () => {
    const at = Date.UTC(2026, 9, 13, 9, 30);
    expect(metaLine({ entriesUsed: 1, generatedAt: at })).toBe('Based on 1 note. Made 2026-10-13 09:30 UTC.');
    expect(metaLine({ entriesUsed: 0, generatedAt: at })).toBe('Based on 0 notes. Made 2026-10-13 09:30 UTC.');
    expect(metaLine({ entriesUsed: 1234, generatedAt: at })).toBe('Based on 1,234 notes. Made 2026-10-13 09:30 UTC.');
    expect(metaLine({ entriesUsed: 2, generatedAt: -1 })).toBe('Based on 2 notes.');
  });
  it('a wait is added to a refusal', () => {
    expect(withWait('Too many.', 1)).toBe('Too many. Try again in 1 second.');
    expect(withWait('Too many.', 90)).toBe('Too many. Try again in 90 seconds.');
    expect(withWait('Too many.', undefined)).toBe('Too many.');
  });
});
