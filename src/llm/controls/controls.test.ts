import { describe, expect, it } from 'vitest';
import { CONTROL_FILES, parseControls } from './controls.js';
import { validFiles } from './fixtures.test-util.js';

const problemsOf = (files: unknown): readonly string[] => {
  const r = parseControls(files);
  if (r.ok) throw new Error('expected problems');
  return r.error;
};

describe('parseControls', () => {
  it('accepts six good files and gives frozen controls with templates and settings for both capabilities', () => {
    const r = parseControls(validFiles());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.categorise) && Object.isFrozen(r.value.status)).toBe(true);
    expect(r.value.categorise.system.slots).toEqual(['itemId', 'maxOps', 'allowedOps']);
    expect(r.value.categorise.frame.slots).toEqual(['contextBlock', 'requestBlock']);
    expect(r.value.status.system.slots).toEqual(['entryCount', 'now', 'maxHeadline', 'maxPoints', 'maxPointChars', 'maxRefs', 'horizonSection']);
    expect(r.value.status.settings.maxPoints).toBe(5);
  });

  it('names exactly the six files', () => {
    expect([...CONTROL_FILES]).toEqual(['categorise/system.txt', 'categorise/frame.txt', 'categorise/settings.json', 'status/system.txt', 'status/frame.txt', 'status/settings.json']);
  });

  it('refuses anything that is not an object of files', () => {
    for (const bad of [null, undefined, 5, 'x', []]) expect(problemsOf(bad)).toEqual(['the controls must be given as an object of file names to text']);
  });

  it('a missing file and an unexpected file are both reported', () => {
    const files = validFiles();
    delete files['status/frame.txt'];
    files['extra.txt'] = 'x';
    expect(problemsOf(files)).toEqual(['"extra.txt": not one of the six controls files', 'status/frame.txt: is missing']);
  });

  it('a long unexpected name is cut in the message', () => {
    const files = { ...validFiles(), [`x${'y'.repeat(100)}`]: 'x' };
    expect(problemsOf(files)[0]).toContain('…');
  });

  it('reports every problem across all six files at once, each naming its file', () => {
    const files = validFiles();
    files['categorise/system.txt'] = 'no id here {{nope}}';
    files['categorise/frame.txt'] = '{{contextBlock}}';
    files['categorise/settings.json'] = '{}';
    files['status/system.txt'] = '';
    files['status/frame.txt'] = '{{entriesBlock}}{{requestBlock}}{{requestBlock}}';
    files['status/settings.json'] = 'nope';
    const p = problemsOf(files);
    for (const name of CONTROL_FILES) expect(p.some((x) => x.startsWith(name)), name).toBe(true);
  });

  it('the required slot of each template is enforced', () => {
    const files = validFiles();
    files['categorise/system.txt'] = 'no item id';
    expect(problemsOf(files)).toEqual(['categorise/system.txt: the required slot {{itemId}} is missing']);
    const f2 = validFiles();
    f2['categorise/frame.txt'] = '{{requestBlock}}';
    expect(problemsOf(f2)).toEqual(['categorise/frame.txt: the required slot {{contextBlock}} is missing']);
    const f3 = validFiles();
    f3['status/frame.txt'] = '{{entriesBlock}}';
    expect(problemsOf(f3)).toEqual(['status/frame.txt: the required slot {{requestBlock}} is missing']);
  });

  it('the block slots must each appear exactly once', () => {
    const files = validFiles();
    files['categorise/frame.txt'] = '{{contextBlock}}{{contextBlock}}{{requestBlock}}';
    expect(problemsOf(files)).toEqual(['categorise/frame.txt: the slot {{contextBlock}} must appear exactly once, not 2 times']);
    const f2 = validFiles();
    f2['status/frame.txt'] = '{{entriesBlock}}{{requestBlock}}{{requestBlock}}';
    expect(problemsOf(f2)).toEqual(['status/frame.txt: the slot {{requestBlock}} must appear exactly once, not 2 times']);
  });

  it('a slot of the other capability is unknown here', () => {
    const files = validFiles();
    files['status/system.txt'] = 'x {{itemId}}';
    expect(problemsOf(files)[0]).toContain('unknown slot "itemId"');
    const f2 = validFiles();
    f2['categorise/system.txt'] = '{{itemId}} {{entryCount}}';
    expect(problemsOf(f2)[0]).toContain('unknown slot "entryCount"');
  });

  it('inherited names are not files', () => {
    const files = Object.create(validFiles()) as Record<string, string>;
    expect(problemsOf(files).length).toBe(6);
  });

  it('never throws, even for a hostile object', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    expect(parseControls(hostile).ok).toBe(false);
  });

  it('error messages never repeat file contents beyond a short quoted token', () => {
    const secret = 'SECRET-CONTENT-ABCDEFGHIJKLMNOP';
    const files = validFiles();
    files['status/system.txt'] = `${secret} {{${secret}}}`;
    files['status/settings.json'] = secret;
    const text = problemsOf(files).join('\n');
    expect(text).not.toContain(secret);
  });
});
