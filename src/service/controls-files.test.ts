import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validFiles } from '../llm/controls/fixtures.test-util.js';
import { defaultControlsDir, loadControlsFolder } from './controls-files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (files: Record<string, string | Buffer> = validFiles()): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-controls-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name.split('/')[0] as string), { recursive: true });
    writeFileSync(join(dir, ...name.split('/')), text);
  }
  return dir;
};
const problems = (dir: string): readonly string[] => {
  const r = loadControlsFolder(dir);
  if (r.ok) throw new Error('expected problems');
  return r.error;
};

describe('loading the controls folder', () => {
  it('reads the six files and gives the checked controls', () => {
    const r = loadControlsFolder(folder());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status.settings.maxPoints).toBe(5);
      expect(r.value.categorise.system.slots).toContain('itemId');
    }
  });

  it('reads UTF-8 as it is', () => {
    const files = validFiles();
    files['status/system.txt'] = 'Status é 😀 {{entryCount}}';
    const r = loadControlsFolder(folder(files));
    expect(r.ok && r.value.status.system.text).toBe('Status é 😀 {{entryCount}}');
  });

  it('never reads or returns anything that is not one of the six files', () => {
    const dir = folder();
    writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET');
    writeFileSync(join(dir, '.env'), 'KEY=1');
    writeFileSync(join(dir, 'status', 'extra.txt'), 'EXTRA-CONTENT');
    mkdirSync(join(dir, 'more'));
    writeFileSync(join(dir, 'more', 'x.txt'), 'hidden');
    const r = loadControlsFolder(dir);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.ok ? r.value : r.error)).not.toMatch(/SECRET|KEY=1|EXTRA-CONTENT|hidden/);
  });

  it('a missing folder, a file where the folder should be, and a missing file are named', () => {
    expect(problems(join(tmpdir(), 'caci-controls-nope-' + Date.now()))[0]).toContain('does not exist');
    const file = folder();
    writeFileSync(join(file, 'afile'), 'x');
    expect(problems(join(file, 'afile'))).toEqual([`the controls folder ${join(file, 'afile')} is not a folder`]);
    const files = validFiles();
    delete files['status/settings.json'];
    const dir = folder(files);
    expect(problems(dir)).toEqual([`status/settings.json: is missing in ${dir}`]);
  });

  it('a missing sub folder names every file in it', () => {
    const files = Object.fromEntries(Object.entries(validFiles()).filter(([n]) => !n.startsWith('status/')));
    const p = problems(folder(files));
    expect(p).toHaveLength(3);
    expect(p[0]).toContain('no folder "status"');
  });

  it('a link or a folder in place of a file is refused', () => {
    const dir = folder();
    rmSync(join(dir, 'status', 'frame.txt'));
    symlinkSync(join(dir, 'categorise', 'frame.txt'), join(dir, 'status', 'frame.txt'));
    expect(problems(dir)).toEqual(['status/frame.txt: is not an ordinary file']);
    rmSync(join(dir, 'status', 'frame.txt'));
    mkdirSync(join(dir, 'status', 'frame.txt'));
    expect(problems(dir)).toEqual(['status/frame.txt: is not an ordinary file']);
  });

  it('a link in place of a sub folder is refused, and a link to the folder itself too', () => {
    const dir = folder();
    const other = folder();
    rmSync(join(dir, 'status'), { recursive: true });
    symlinkSync(join(other, 'status'), join(dir, 'status'));
    expect(problems(dir).every((p) => p.includes('not an ordinary folder'))).toBe(true);
    const link = join(tmpdir(), `caci-controls-link-${Date.now()}`);
    symlinkSync(other, link);
    dirs.push(link);
    expect(problems(link)[0]).toContain('is not a folder');
  });

  it('an oversized file and bytes that are not UTF-8 are refused, and the exact size limit is accepted', () => {
    const files: Record<string, string | Buffer> = { ...validFiles() };
    files['status/frame.txt'] = Buffer.alloc(20_001, 'x');
    expect(problems(folder(files))).toEqual(['status/frame.txt: 20001 bytes, over the limit of 20000']);
    files['status/frame.txt'] = Buffer.from([0xff, 0xfe, 0x41]);
    expect(problems(folder(files))).toEqual(['status/frame.txt: is not valid UTF-8 text']);
    // exactly 20,000 bytes is read (and then refused by the template rules for its size, not by the loader)
    files['status/frame.txt'] = Buffer.alloc(20_000, 'x');
    expect(problems(folder(files))[0]).toContain('characters, over the limit of 16000');
  });

  it('passes the pure model\'s problems through, all at once', () => {
    const files = validFiles();
    files['categorise/system.txt'] = 'no id {{oops}}';
    files['status/settings.json'] = '{}';
    const p = problems(folder(files));
    expect(p.some((x) => x.startsWith('categorise/system.txt'))).toBe(true);
    expect(p.some((x) => x.startsWith('status/settings.json'))).toBe(true);
  });

  it('the default folder is the controls folder beside the code', () => {
    expect(defaultControlsDir().endsWith('/controls/')).toBe(true);
  });

  it('never throws, whatever the argument', () => {
    expect(loadControlsFolder(`${'x'.repeat(5000)}\0`).ok).toBe(false);
  });
});
