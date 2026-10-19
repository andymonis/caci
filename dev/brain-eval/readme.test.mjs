import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANSWER_WITH, parseArgs, USAGE } from './args.mjs';
import { DEFAULT_WINDOW_TOKENS } from './replay-arm.mjs';
import { CUES } from './score.mjs';
import { KINDS, loadScenarios, NOTE_FIELDS, QUESTION_FIELDS, SCENARIO_FIELDS } from './scenario.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const main = read('README.md');
const section = main.slice(main.indexOf('## Testing the brain against replaying the text'), main.indexOf('## Running on a Raspberry Pi'));
const devReadme = read('dev/brain-eval/README.md');
const scenariosReadme = read('dev/brain-eval/scenarios/README.md');
const running = read('RUNNING-THE-TEST-APPS.md');
const specText = read('specs/R-013-brain-evaluation.md');
const pkg = JSON.parse(read('package.json'));
const defaults = parseArgs([]).value;
const flagsInUsage = [...USAGE.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]);

const commandsIn = (text) => [...text.matchAll(/^npm run brain-eval(?: -- )?(.*?)(?:\s+#.*)?$/gm)].map((m) => m[1].trim().split(/\s+/).filter(Boolean));

describe('the README section', () => {
  it('exists, is separate, and is linked to the specification that exists', () => {
    expect(section.length).toBeGreaterThan(2000);
    expect(section).toContain('specs/R-013-brain-evaluation.md');
    expect(specText).toContain('# Brain Quality Evaluation');
    expect(main).toContain('dev/brain-eval/');
  });
  it('every command it shows is accepted by the real argument parser, and the script exists', () => {
    expect(pkg.scripts['brain-eval']).toBe('npm run build && node dev/brain-eval/run.mjs');
    for (const text of [section, devReadme, running]) {
      const commands = commandsIn(text);
      expect(commands.length).toBeGreaterThan(0);
      for (const args of commands) {
        const parsed = parseArgs(args);
        expect(parsed.ok, `npm run brain-eval ${args.join(' ')}: ${parsed.message}`).toBe(true);
      }
    }
  });
  it('every npm script and node file it names exists', () => {
    for (const text of [section, devReadme, running, scenariosReadme]) {
      for (const m of text.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts[m[1]], m[1]).toBeDefined();
      for (const m of text.matchAll(/node (dev\/[\w/.-]+\.mjs)/g)) expect(() => read(m[1]), m[1]).not.toThrow();
    }
  });
  it('the defaults it states are the real ones', () => {
    expect(section).toContain('default `fast`');
    expect(section).toContain(`default \`${DEFAULT_ANSWER_WITH.join(',')}\``);
    expect(section).toContain(`default ${defaults.repeat})`);
    expect(section).toContain(`${DEFAULT_WINDOW_TOKENS.toLocaleString('en-US')} tokens`);
    expect(defaults).toMatchObject({ fileWith: 'fast', repeat: 3, window: 150000, out: 'brain-eval-results', arms: ['brain', 'replay'], order: 'oldest-first' });
    expect(read('.gitignore')).toContain('brain-eval-results/');
  });
  it('the library numbers it states match the library', () => {
    const loaded = loadScenarios(new URL('dev/brain-eval/scenarios', root).pathname);
    expect(loaded.ok).toBe(true);
    const notes = loaded.scenarios.reduce((n, s) => n + s.notes.length, 0);
    const questions = loaded.scenarios.reduce((n, s) => n + s.questions.length, 0);
    expect(section).toContain(`${loaded.scenarios.length} invented scenarios (${notes} notes, ${questions} questions)`);
    for (const kind of KINDS) expect(section, kind).toContain(`\`${kind}\``);
  });
  it('says what a reader must not miss', () => {
    for (const phrase of [
      'invented notes', 'Only invented text belongs in a scenario', 'costs money and sends every note and question in the scenarios to Anthropic',
      'prints its plan', 'stops unless you add `--yes`', 'never printed or saved', 'Ctrl+C stops between calls and still reports and saves',
      '`--demo` and `--yes` together are refused', 'scored **by rules, not by another model**', 'a note that changes an older one replaces it',
      'brain minus replay', 'where the fact was lost', 'The brain now replaces an older note when a newer one changes it', 'a fact lost at *replace*', 'Nothing in this tool changes the brain',
    ]) expect(section, phrase).toContain(phrase);
  });
});

describe('the tool\'s own README', () => {
  it('lists every option of the usage text, and nothing the parser would refuse', () => {
    expect(flagsInUsage.length).toBeGreaterThanOrEqual(15);
    for (const flag of flagsInUsage.filter((f) => f !== '--help')) expect(devReadme, flag).toContain(`\`${flag}`);
    const tableFlags = [...devReadme.matchAll(/^\| `(--[a-z-]+)/gm)].map((m) => m[1]);
    expect(new Set(tableFlags)).toEqual(new Set(flagsInUsage.filter((f) => f !== '--help')));
  });
  it('names every non-test file in the folder, and no file that does not exist', () => {
    const files = readdirSync(new URL('dev/brain-eval/', root)).filter((f) => f.endsWith('.mjs') && !f.includes('.test'));
    const named = [...devReadme.matchAll(/`([\w-]+\.mjs)`/g)].map((m) => m[1]);
    for (const f of files) expect(named, f).toContain(f);
    for (const n of named) expect(files, n).toContain(n);
  });
  it('says only invented text belongs in a scenario, and that a real run costs money', () => {
    for (const phrase of ['only invented text belongs in a scenario', '**costs money, and sends every note and question in the scenarios to Anthropic**', 'stops unless you add `--yes`', 'never printed or saved']) expect(devReadme, phrase).toContain(phrase);
  });
});

describe('the scenario README', () => {
  it('names every field of a scenario, a note and a question, and every kind', () => {
    for (const field of new Set([...SCENARIO_FIELDS, ...NOTE_FIELDS, ...QUESTION_FIELDS])) expect(scenariosReadme, field).toContain(field);
    for (const kind of KINDS) expect(scenariosReadme, kind).toContain(`\`${kind}\``);
  });
  it('the cues it names are real cues', () => {
    for (const word of ['no longer', 'instead of', 'previously', 'cancelled']) {
      expect(scenariosReadme, word).toContain(word);
      expect(CUES, word).toContain(word);
    }
  });
  it('the example in it is a sound scenario', async () => {
    const { validateScenario } = await import('./scenario.mjs');
    const json = /```json\n([\s\S]*?)```/.exec(scenariosReadme)[1];
    const example = JSON.parse(json);
    example.notes.push(...Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, at: '2026-04-01', text: `filler ${i}` })));
    expect(validateScenario(example)).toEqual([]);
  });
  it('says only invented text goes in, and how to regenerate the review page', () => {
    expect(scenariosReadme).toContain('Everything in here is **invented**');
    expect(scenariosReadme).toContain('node dev/brain-eval/list.mjs > dev/brain-eval/scenarios/REVIEW.md');
  });
});

describe('RUNNING-THE-TEST-APPS.md', () => {
  it('has the brain evaluation as its own numbered section, in order', () => {
    const headings = [...running.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(headings).toEqual(Array.from({ length: headings.length }, (_, i) => i + 1));
    expect(running).toContain('## 5. The brain evaluation');
    expect(running).toContain('Only invented text goes in a scenario.');
    expect(running).toContain('sends the invented scenarios to Anthropic');
  });
});
