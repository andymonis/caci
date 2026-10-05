import { describe, expect, it } from 'vitest';
import { main } from './cli.mjs';
import { GOLDEN } from './golden.mjs';
import { KEY, lib, replying } from './helpers.test-util.mjs';
import { idealReply } from './scripted.mjs';

/** Runs the command with everything faked, and returns what it did. */
async function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const saved = [];
  const created = [];
  let clock = Date.UTC(2026, 9, 5, 9, 30, 0);
  const code = await main({
    argv,
    env: extra.env ?? {},
    lib: {
      ...lib,
      createAnthropicClient: (options) => {
        created.push(options);
        return extra.client ?? replying({ ops: [] });
      },
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    loadGolden: extra.loadGolden ?? (async () => { throw new Error('no golden file given'); }),
    save: extra.save ?? (async (dir, name, json) => (saved.push({ dir, name, json }), `${dir}/${name}`)),
    now: () => (clock += 10),
    signal: extra.signal,
  });
  return { code, out: out.join(''), err: err.join(''), saved, created };
}
const ENV = { ANTHROPIC_API_KEY: KEY };

describe('--help and bad arguments', () => {
  it('prints the usage and exits 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: npm run eval');
  });
  it('a bad option exits 2 with the reason on stderr and nothing on stdout', async () => {
    const r = await run(['--wat']);
    expect(r).toMatchObject({ code: 2, out: '' });
    expect(r.err).toContain('unknown option --wat');
  });
});

describe('--scripted: checks the harness without a model or a key', () => {
  it('runs the whole golden set on every model, prints the report and saves the results', async () => {
    const r = await run(['--scripted']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Evaluation: ${GOLDEN.length} cases × 3 models × 1 run (${GOLDEN.length * 3} done) — scripted model`);
    expect(r.out).toContain('Pass rate');
    expect(r.out).toContain('100% (15/15)');
    expect(r.created).toEqual([]); // the real client is never made
    expect(r.err).toContain(`Running ${GOLDEN.length * 3} scripted calls…`);
    expect(r.err).toContain(`[${GOLDEN.length * 3}/${GOLDEN.length * 3}]`);
  });

  it('saves one JSON file in the output folder, named by the start time and mode, with every run', async () => {
    const r = await run(['--scripted', '--models', 'fast', '--out', 'somewhere']);
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]).toMatchObject({ dir: 'somewhere', name: '2026-10-05T09-30-00-010Z-scripted.json' });
    const { json } = r.saved[0];
    expect(json).toMatchObject({ mode: 'scripted', repeat: 1, aborted: false, models: { fast: 'claude-haiku-4-5-20251001' }, startedAt: '2026-10-05T09:30:00.010Z' });
    expect(json.cases).toEqual(GOLDEN.map((c) => c.id));
    expect(json.results).toHaveLength(GOLDEN.length);
    expect(r.out).toContain('Saved: somewhere/2026-10-05T09-30-00-010Z-scripted.json');
  });

  it('honours --only, --models and --repeat', async () => {
    const r = await run(['--scripted', '--only', 'doctor-followup,dentist-booking', '--models', 'fast,my-model-1', '--repeat', '2']);
    expect(r.saved[0].json.results).toHaveLength(2 * 2 * 2);
    expect(r.saved[0].json.models).toEqual({ fast: 'claude-haiku-4-5-20251001', 'my-model-1': 'my-model-1' });
    expect(r.out).toContain('my-model-1');
    expect(r.out).toContain('2 cases × 2 models × 2 runs (8 done)');
  });

  it('refuses an unknown case id and lists the real ones', async () => {
    const r = await run(['--scripted', '--only', 'nope']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('No such case: nope');
    expect(r.err).toContain('doctor-followup');
    expect(r.saved).toEqual([]);
  });

  it('works without any key in the environment', async () => {
    expect((await run(['--scripted'], { env: {} })).code).toBe(0);
  });

  it('a save failure is reported but does not lose the report or change the exit code', async () => {
    const r = await run(['--scripted', '--models', 'fast'], { save: async () => { throw new Error('disk full'); } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pass rate');
    expect(r.err).toContain('Could not save the results: disk full');
  });
});

describe('a real run', () => {
  it('without a key stops with a clear message and exit 1', async () => {
    const r = await run([], { env: {} });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ANTHROPIC_API_KEY is not set');
    expect(r.err).toContain('--scripted');
    expect(r.created).toEqual([]);
  });

  it('with a bad key says so without showing it', async () => {
    const r = await run([], { env: { ANTHROPIC_API_KEY: 'short key with spaces' } });
    expect(r.code).toBe(1);
    expect(r.err + r.out).not.toContain('short key with spaces');
  });

  it('with a key but no --yes only prints the plan: no client, no calls, nothing saved', async () => {
    const r = await run(['--models', 'fast,deep'], { env: ENV });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Planned: ${GOLDEN.length} cases × 2 models × 1 run = ${GOLDEN.length * 2} real calls.`);
    expect(r.out).toContain('fast = claude-haiku-4-5-20251001');
    expect(r.out).toContain('deep = claude-opus-5-5');
    expect(r.out).toContain('costs money');
    expect(r.out).toContain('Nothing was sent. Add --yes to run it.');
    expect(r.created).toEqual([]);
    expect(r.saved).toEqual([]);
    expect(r.err).not.toContain('Running');
  });

  it('with --yes makes one real client with the key and runs everything through it', async () => {
    const seenModels = [];
    const client = {
      complete: async (request) => {
        seenModels.push(request.model);
        const caseDef = GOLDEN.find((c) => request.messages[0].content.includes(c.note.slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
        return replying(idealReply(caseDef ?? GOLDEN[0], 'note-eval-1')).complete(request);
      },
    };
    const r = await run(['--yes', '--models', 'fast,deep', '--only', 'doctor-followup,dentist-booking'], { env: ENV, client });
    expect(r.code).toBe(0);
    expect(r.created).toEqual([{ apiKey: KEY }]);
    expect(seenModels).toEqual(['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-opus-5-5']);
    expect(r.out).toContain('— real model');
    expect(r.saved[0].name).toMatch(/-real\.json$/);
  });

  it('never prints or saves the key, on any path', async () => {
    const withKey = await run(['--yes', '--only', 'doctor-followup', '--models', 'fast'], { env: ENV, client: replying(idealReply(GOLDEN[0], 'note-eval-1')) });
    const plan = await run([], { env: ENV });
    const refused = await run([], { env: { ANTHROPIC_API_KEY: KEY + ' with space' } });
    for (const r of [withKey, plan, refused]) {
      expect(r.out + r.err + JSON.stringify(r.saved)).not.toContain('EVAL-SECRET');
    }
  });

  it('a failing real call is a failed run in the report, not a crash', async () => {
    const client = { complete: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } }) };
    const r = await run(['--yes', '--models', 'fast', '--only', 'doctor-followup'], { env: ENV, client });
    expect(r.code).toBe(0);
    expect(r.out).toContain('0% (0/1)');
    expect(r.out).toContain('Errors:');
    expect(r.out).toContain('RATE_LIMITED × 1');
  });
});

describe('--golden', () => {
  const mine = [{ id: 'my-case', note: 'My own note', categories: [{ id: 'health' }], expect: { reuse: ['health'] } }];

  it('uses your own set instead of the built-in one', async () => {
    const r = await run(['--scripted', '--models', 'fast', '--golden', 'mine.json'], { loadGolden: async (path) => (path === 'mine.json' ? mine : []) });
    expect(r.code).toBe(0);
    expect(r.saved[0].json.cases).toEqual(['my-case']);
    expect(r.out).toContain('1 cases × 1 model');
  });

  it('refuses a set that is unsound, listing the problems', async () => {
    const r = await run(['--scripted', '--golden', 'bad.json'], { loadGolden: async () => [{ id: 'Bad', note: '', categories: [], expect: {} }] });
    expect(r.code).toBe(2);
    expect(r.err).toContain('The golden set has problems');
    expect(r.err).toContain('id must be lowercase');
    expect(r.err).toContain('note must be non-empty');
    expect(r.saved).toEqual([]);
  });

  it('reports a file that cannot be loaded', async () => {
    const r = await run(['--scripted', '--golden', 'missing.json']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Could not load missing.json');
  });

  it('refuses a set that is not a list', async () => {
    const r = await run(['--scripted', '--golden', 'x.json'], { loadGolden: async () => ({ cases: [] }) });
    expect(r.code).toBe(2);
    expect(r.err).toContain('non-empty list');
  });
});

describe('stopping early (Ctrl+C)', () => {
  it('keeps what was done, says so in the report, and saves it', async () => {
    const controller = new AbortController();
    const out = [];
    const saved = [];
    const code = await main({
      argv: ['--scripted', '--models', 'fast'],
      env: {},
      lib,
      stdout: (t) => out.push(t),
      stderr: (t) => { if (t.startsWith('[3/')) controller.abort(); },
      loadGolden: async () => GOLDEN,
      save: async (dir, name, json) => (saved.push(json), `${dir}/${name}`),
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('STOPPED EARLY');
    expect(saved[0]).toMatchObject({ aborted: true });
    expect(saved[0].results).toHaveLength(3);
  });
});
