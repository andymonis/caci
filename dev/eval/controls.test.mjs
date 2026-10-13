import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shippedFiles } from '../../src/llm/testing/shipped-controls.test-util.ts';
import { loadControlsFolder } from '../../src/service/controls-files.ts';
import { parseArgs } from './args.mjs';
import { main } from './cli.mjs';
import { STATUS_GOLDEN } from './status-golden.mjs';
import { GOLDEN } from './golden.mjs';
import { lib as baseLib } from './helpers.test-util.mjs';

// R-012: the same evaluation sets, run against a candidate folder of controls.

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function folder(change = () => {}) {
  const files = shippedFiles();
  change(files);
  const dir = mkdtempSync(join(tmpdir(), 'caci-eval-controls-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name.split('/')[0]), { recursive: true });
    writeFileSync(join(dir, ...name.split('/')), text);
  }
  return dir;
}
const loadControls = async (dir) => {
  const r = loadControlsFolder(dir);
  return r.ok ? { ok: true, value: r.value } : { ok: false, problems: r.error };
};

async function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const saved = [];
  const seen = [];
  const lib = { ...baseLib, createLlm: (init) => (seen.push(init), baseLib.createLlm(init)) };
  const code = await main({
    argv,
    env: extra.env ?? {},
    lib,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    loadControls: extra.loadControls ?? loadControls,
    loadGolden: async () => {
      throw new Error('none');
    },
    save: async (dir, name, json) => (saved.push({ dir, name, json }), `${dir}/${name}`),
  });
  return { code, out: out.join(''), err: err.join(''), saved, seen };
}
const SETTINGS_PATCH = (file, patch) => (files) => {
  const s = JSON.parse(files[file]);
  patch(s);
  files[file] = JSON.stringify(s);
};

describe('the option', () => {
  it('is read, and needs a folder', () => {
    expect(parseArgs(['--controls', './candidate']).value.controls).toBe('./candidate');
    expect(parseArgs([]).value.controls).toBeUndefined();
    expect(parseArgs(['--controls'])).toEqual({ ok: false, message: '--controls needs a value' });
    expect(parseArgs(['--controls', '--scripted'])).toEqual({ ok: false, message: '--controls needs a value' });
  });
});

describe('a bad candidate stops everything before any call', () => {
  it.each([['categorise'], ['status']])('%s: every problem listed, exit 2, nothing printed, saved or created', async (capability) => {
    let created = 0;
    const dir = folder((f) => {
      f['status/system.txt'] = 'no slots {{nope}}';
      f['categorise/frame.txt'] = 'missing blocks';
    });
    const r = await run(['--capability', capability, '--scripted', '--controls', dir]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain(`The controls in ${dir} are not valid:`);
    expect(r.err).toContain('status/system.txt');
    expect(r.err).toContain('categorise/frame.txt');
    expect(r.saved).toEqual([]);
    expect(r.seen).toEqual([]);
    expect(created).toBe(0);
  });

  it('also before a real run is planned, so a typo is found without a key', async () => {
    const r = await run(['--controls', join(tmpdir(), 'caci-nowhere-' + Date.now())], { env: {} });
    expect(r.code).toBe(2);
    expect(r.err).toContain('does not exist');
    expect(r.err).not.toContain('needs a key');
  });
});

describe('a good candidate is used, and recorded', () => {
  it('categorise: the candidate controls reach every call, the header, the plan and the saved file name the folder', async () => {
    const dir = folder((f) => (f['categorise/system.txt'] = f['categorise/system.txt'].replace('You are the filing assistant', 'SENTINEL')));
    const r = await run(['--scripted', '--models', 'fast', '--only', 'doctor-followup', '--controls', dir]);
    expect(r.code).toBe(0);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].controls.categorise.system.text).toContain('SENTINEL');
    expect(r.out).toContain(`Controls: ${dir}`);
    expect(r.saved[0].json.controls).toBe(dir);
    expect(r.out).toContain('100% (1/1)');
  });

  it('the shipped folder is described as such when no candidate is given, and no controls are passed', async () => {
    const r = await run(['--scripted', '--models', 'fast', '--only', 'doctor-followup']);
    expect(r.seen[0].controls).toBeUndefined();
    expect(r.out).toContain('Controls: the shipped controls/ folder');
    expect(r.saved[0].json.controls).toBeNull();
  });

  it('a real run without --yes plans, naming the folder, and sends nothing', async () => {
    const dir = folder();
    const r = await run(['--controls', dir], { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-EVAL-CONTROLS-KEY-1234567890' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Controls: ${dir}`);
    expect(r.out).toContain('Nothing was sent.');
    expect(r.seen).toEqual([]);
  });

  it('rewritten wording still passes the ideal model on both sets (the words are not what the checks look at)', async () => {
    const dir = folder((f) => {
      f['categorise/system.txt'] = 'Q-A {{itemId}} {{maxOps}} {{allowedOps}}';
      f['categorise/frame.txt'] = 'Q-B {{requestBlock}} {{contextBlock}}';
      f['status/system.txt'] = 'Q-C {{now}} {{entryCount}} {{maxHeadline}} {{maxPoints}} {{maxPointChars}} {{maxRefs}}';
      f['status/frame.txt'] = 'Q-D {{requestBlock}} {{entriesBlock}}';
    });
    const a = await run(['--scripted', '--models', 'fast', '--controls', dir]);
    expect(a.out).toContain(`100% (${GOLDEN.length}/${GOLDEN.length})`);
    const b = await run(['--capability', 'status', '--scripted', '--models', 'fast', '--controls', dir]);
    expect(b.out).toContain(`100% (${STATUS_GOLDEN.length}/${STATUS_GOLDEN.length})`);
  });

  it('a changed limit shows up in the results: one point allowed, and the ideal model\'s two-point answers are refused', async () => {
    const dir = folder(SETTINGS_PATCH('status/settings.json', (s) => (s.maxPoints = 1)));
    const before = await run(['--capability', 'status', '--scripted', '--models', 'fast']);
    const after = await run(['--capability', 'status', '--scripted', '--models', 'fast', '--controls', dir]);
    expect(before.out).toContain('100% (6/6)');
    expect(after.out).not.toContain('100% (6/6)');
    expect(after.out).toContain('BAD_OUTPUT');
    expect(after.out).toContain('morning-check');
    expect(after.saved[0].json.results.filter((x) => !x.pass).length).toBeGreaterThan(0);
    expect(after.saved[0].json.controls).toBe(dir);
  });

  it('the same for categorise: a lower operation cap refuses the ideal model\'s replies that need more', async () => {
    const dir = folder(SETTINGS_PATCH('categorise/settings.json', (s) => (s.maxOps = 1)));
    const r = await run(['--scripted', '--models', 'fast', '--controls', dir]);
    expect(r.out).not.toContain(`100% (${GOLDEN.length}/${GOLDEN.length})`);
    expect(r.saved[0].json.results.every((x) => !x.pass)).toBe(true);
    expect(r.saved[0].json.results[0].error.message).toContain('over the limit of 1');
  });
});
