import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseControls } from '../llm/index.js';
import { shippedFiles } from '../llm/testing/shipped-controls.test-util.js';
import { serve } from './cli.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';
import { writeControls } from './controls-folder.test-util.js';

// R-012: the service reads the controls first, refuses to start on a bad folder, and uses what it reads.

const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'caci-controls-svc-'));
  dirs.push(d);
  return d;
};
const folder = (change: (files: Record<string, string>) => void = () => {}): string => {
  const files = shippedFiles();
  change(files);
  const dir = tmp();
  writeControls(dir, files);
  return dir;
};
const message = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a refusal');
};

describe('starting with the controls folder', () => {
  it('uses the folder given, and says where it came from', async () => {
    const dir = folder();
    const s = await startService(baseConfig(join(tmp(), 'data')), { controlsDir: dir });
    running.push(s);
    expect(s.controlsDir).toBe(dir);
  });

  it('a bad file stops the start, names the file and the problem, and leaves no data folder behind', async () => {
    const data = join(tmp(), 'data');
    const dir = folder((f) => (f['status/system.txt'] = 'Status {{nonsense}} and no slots'));
    const m = await message(startService(baseConfig(data), { controlsDir: dir }));
    expect(m).toContain(`the LLM controls in ${dir} are not valid`);
    expect(m).toContain('status/system.txt');
    expect(m).toContain('unknown slot "nonsense"');
    expect(existsSync(data)).toBe(false);
  });

  it('every problem is listed at once', async () => {
    const dir = folder((f) => {
      f['categorise/frame.txt'] = 'no blocks';
      f['status/settings.json'] = '{}';
    });
    const m = await message(startService(baseConfig(join(tmp(), 'data')), { controlsDir: dir }));
    expect(m).toContain('categorise/frame.txt');
    expect(m).toContain('status/settings.json');
  });

  it('a missing folder or file is named', async () => {
    const data = join(tmp(), 'data');
    expect(await message(startService(baseConfig(data), { controlsDir: join(tmp(), 'nowhere') }))).toContain('does not exist');
    const dir = folder();
    rmSync(join(dir, 'status', 'frame.txt'));
    expect(await message(startService(baseConfig(data), { controlsDir: dir }))).toContain('status/frame.txt: is missing');
    expect(existsSync(data)).toBe(false);
  });

  it('a bad folder is refused before the real model\'s key is even needed or its SDK loaded', async () => {
    const dir = folder((f) => (f['status/frame.txt'] = ''));
    const m = await message(startService({ ...baseConfig(join(tmp(), 'data')), llm: 'anthropic' }, { controlsDir: dir }));
    expect(m).toContain('status/frame.txt');
    expect(m).not.toContain('ANTHROPIC_API_KEY');
  });

  it('the controls must allow at least what the API accepts (8,000 characters for a note, 500 for a status request)', async () => {
    const setting = (file: string, name: string, value: number) =>
      folder((f) => {
        const s = JSON.parse(f[file] as string);
        s[name] = value;
        f[file] = JSON.stringify(s);
      });
    const data = join(tmp(), 'data');
    const low1 = await message(startService(baseConfig(data), { controlsDir: setting('categorise/settings.json', 'maxTextChars', 7999) }));
    expect(low1).toContain('categorise/settings.json: "maxTextChars" is 7999, below the 8000 characters');
    const low2 = await message(startService(baseConfig(data), { controlsDir: setting('status/settings.json', 'maxRequestChars', 499) }));
    expect(low2).toContain('status/settings.json: "maxRequestChars" is 499, below the 500 characters');
    expect(existsSync(data)).toBe(false);
    for (const [file, name, value] of [['categorise/settings.json', 'maxTextChars', 8000], ['status/settings.json', 'maxRequestChars', 500], ['categorise/settings.json', 'maxTextChars', 9000]] as const) {
      const s = await startService(baseConfig(join(tmp(), 'data')), { controlsDir: setting(file, name, value) });
      running.push(s);
    }
  });

  it('both limits are reported together', async () => {
    const dir = folder((f) => {
      const c = JSON.parse(f['categorise/settings.json'] as string);
      c.maxTextChars = 100;
      f['categorise/settings.json'] = JSON.stringify(c);
      const s = JSON.parse(f['status/settings.json'] as string);
      s.maxRequestChars = 100;
      f['status/settings.json'] = JSON.stringify(s);
    });
    const m = await message(startService(baseConfig(join(tmp(), 'data')), { controlsDir: dir }));
    expect(m).toContain('maxTextChars');
    expect(m).toContain('maxRequestChars');
  });
});

describe('serve', () => {
  it('says where the instructions and limits were read from', async () => {
    const out: string[] = [];
    const r = await serve({ CACI_PORT: '0', CACI_DATA_DIR: join(tmp(), 'data') }, { stdout: (t) => out.push(t), stderr: () => {} });
    if (r.code === 0) running.push(r.service);
    expect(r.code).toBe(0);
    expect(out.join('')).toMatch(/Model instructions and limits: .*\/controls\/ \(six text files\)\./);
  });
});

describe('the shipped folder is what the service uses by default', () => {
  it('parses, and starts the service with no option', async () => {
    expect(parseControls(shippedFiles()).ok).toBe(true);
    const s = await startService(baseConfig(join(tmp(), 'data')));
    running.push(s);
    expect(s.controlsDir.endsWith('/controls/')).toBe(true);
  });
});

describe('an edited folder is what the model is told (through a stand-in provider, no network)', () => {
  const KEY = 'sk-ant-api03-CONTROLS-TEST-KEY-0123456789abcdef';
  const PW = 'correct horse 7 staple';

  it('a status request and a note both carry the edited rule and frame, and the limits the edit set', async () => {
    const seen: Array<{ system: string; user: string; schema: string }> = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { system?: string; messages: Array<{ content: string }>; output_config?: unknown; model: string };
      seen.push({ system: body.system ?? '', user: body.messages[0]?.content ?? '', schema: JSON.stringify(body.output_config) });
      const system = body.system ?? '';
      const reply = system.startsWith('EDITED-STATUS')
        ? { headline: 'Quiet.', points: [], nothing: true }
        : { ops: [{ op: 'upsertNode', partition: 'item', id: /id=(\S+)/.exec(system)?.[1] ?? '', data: { title: 't', summary: 's' } }, { op: 'upsertNode', partition: 'category', id: 'misc', data: { name: 'Misc' } }, { op: 'link', item: /id=(\S+)/.exec(system)?.[1] ?? '', category: 'misc', weight: 0.5 }] };
      const message = { id: 'm', type: 'message', role: 'assistant', model: String(body.model), content: [{ type: 'text', text: JSON.stringify(reply), citations: null }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null } };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const dir = folder((f) => {
      f['status/system.txt'] = 'EDITED-STATUS. Day: {{now}}. Cite 1 to {{entryCount}}. At most {{maxPoints}} points.';
      f['status/frame.txt'] = 'EDITED-FRAME-S\n{{requestBlock}}\n{{entriesBlock}}';
      f['categorise/system.txt'] = 'EDITED-FILING id={{itemId}} max={{maxOps}} ops={{allowedOps}}';
      f['categorise/frame.txt'] = 'EDITED-FRAME-C\n{{contextBlock}}\n{{requestBlock}}';
      const s = JSON.parse(f['status/settings.json'] as string);
      s.maxPoints = 3;
      s.descriptions.headline = 'EDITED-HEADLINE-WORDS';
      f['status/settings.json'] = JSON.stringify(s);
    });
    const service = await startService({ ...baseConfig(join(tmp(), 'data')), llm: 'anthropic' }, { controlsDir: dir, apiKey: KEY, anthropic: { fetch: fetchFn } });
    running.push(service);
    const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
      const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { res, json: await res.json().catch(() => undefined) };
    };
    await call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
    const login = await call('POST', '/api/login', { username: 'ann', password: PW });
    const cookie = (login.res.headers.get('set-cookie') ?? '').split(';')[0] as string;

    const made = await call('POST', '/api/capture/propose', { text: 'A note about the dentist' }, cookie);
    expect(made.res.status).toBe(201);
    expect(seen[0]?.system).toMatch(/^EDITED-FILING id=note-\S+ max=40 ops=upsertNode, link$/);
    expect(seen[0]?.user.startsWith('EDITED-FRAME-C\n<categories>')).toBe(true);
    expect(seen[0]?.user).toContain('<note>\nA note about the dentist\n</note>');

    const status = await call('POST', '/api/status', { text: 'How are things?' }, cookie);
    expect(status.res.status, JSON.stringify(status.json)).toBe(200);
    const sent = seen[seen.length - 1];
    expect(sent?.system).toMatch(/^EDITED-STATUS\. Day: .* \(UTC\)\. Cite 1 to 0\. At most 3 points\.$/);
    expect(sent?.user).toBe('EDITED-FRAME-S\n<request>\nHow are things?\n</request>\n<entries>\n(there are no entries)\n</entries>');
    expect(sent?.schema).toContain('EDITED-HEADLINE-WORDS');
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });
});
