// The brain-eval command with everything it touches passed in, so it is tested without a model, a key, a disk or a clock.
import { createHash } from 'node:crypto';
import { parseArgs, resolveModels, USAGE } from './args.mjs';
import { compareRuns } from './compare.mjs';
import { padScenario } from './pad.mjs';
import { formatReport, summarise } from './report.mjs';
import { plannedCalls, runEval } from './runner.mjs';

export const hashOf = (scenario) => createHash('sha256').update(JSON.stringify(scenario)).digest('hex').slice(0, 16);

/**
 * @param io.argv  arguments after the command
 * @param io.env   the environment (only ANTHROPIC_API_KEY is read, and never printed or saved)
 * @param io.lib   the product pieces (see `runBrainArm`) plus `createAnthropicClient`, `readAnthropicKey`, `DEFAULT_TIERS`, `createDemoModelClient`
 * @param io.defaultControls  the shipped controls, used when `--controls` is not given
 * @param io.defaultScenarios folder used when `--scenarios` is not given
 * @param io.loadControls async (dir) => `{ ok: true, value }` or `{ ok: false, problems }`
 * @param io.loadScenarios async (dir) => `{ ok: true, scenarios }` or `{ ok: false, problems }`
 * @param io.readJson async (path) => a saved result (for --compare)
 * @param io.save  async (dir, name, json) => path
 * @returns the exit code
 */
export async function main(io) {
  const { lib, stdout, stderr, now = Date.now } = io;
  const parsed = parseArgs(io.argv);
  if (!parsed.ok) {
    stderr(`${parsed.message}\n`);
    return 2;
  }
  const args = parsed.value;
  if (args.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  if (args.compare !== undefined) {
    const runs = [];
    for (const file of args.compare) {
      try {
        runs.push(await io.readJson(file));
      } catch (error) {
        stderr(`Could not read ${file}: ${error.message}\n`);
        return 2;
      }
    }
    const compared = compareRuns(runs[0], runs[1], { force: args.force });
    if (!compared.ok) {
      stderr(`${compared.message}\n`);
      return 2;
    }
    stdout(`${compared.text}\n`);
    return 0;
  }

  const loaded = await io.loadScenarios(args.scenarios ?? io.defaultScenarios);
  if (!loaded.ok) {
    stderr(`The scenarios have problems:\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 2;
  }
  let scenarios = loaded.scenarios;
  if (args.only !== undefined) {
    const known = new Set(scenarios.map((s) => s.id));
    const missing = args.only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      stderr(`No such scenario: ${missing.join(', ')}. Scenarios: ${[...known].join(', ')}\n`);
      return 2;
    }
    scenarios = scenarios.filter((s) => args.only.includes(s.id));
  }

  let controls = io.defaultControls;
  if (args.controls !== undefined) {
    const result = await io.loadControls(args.controls);
    if (!result.ok) {
      stderr(`The controls in ${args.controls} are not valid:\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n`);
      return 2;
    }
    controls = result.value;
  }
  const controlsLabel = args.controls ?? 'the shipped controls/ folder';

  for (const scenario of scenarios) {
    for (const pad of args.pad) {
      try {
        padScenario(scenario, pad, args.seed);
      } catch (error) {
        stderr(`Cannot pad ${scenario.id} with ${pad} notes: ${error.message}\n`);
        return 2;
      }
    }
  }

  const [fileWith] = resolveModels([args.fileWith], lib.DEFAULT_TIERS);
  const answerWith = resolveModels(args.answerWith, lib.DEFAULT_TIERS);
  const resolved = Object.fromEntries([fileWith, ...answerWith].map((m) => [m.label, m.choice.tier ? lib.DEFAULT_TIERS[m.choice.tier] : m.choice.model]));
  const plan = plannedCalls({ scenarios, arms: args.arms, answerWith, repeat: args.repeat, pads: args.pad });
  const mode = args.demo ? 'demo' : 'real';

  let makeClient;
  if (args.demo) {
    makeClient = () => lib.createDemoModelClient();
  } else {
    const key = lib.readAnthropicKey(io.env);
    if (!key.ok) {
      stderr(`A real run needs a key: ${key.error.message}. Use --demo to check the plumbing without one.\n`);
      return 1;
    }
    if (!args.yes) {
      stdout(
        [
          `Controls: ${controlsLabel}`,
          `Scenarios: ${scenarios.length} (${scenarios.reduce((n, s) => n + s.notes.length, 0)} notes, ${scenarios.reduce((n, s) => n + s.questions.length, 0)} questions)`,
          ...(args.pad.some((n) => n > 0) ? [`Filler: ${args.pad.join(', ')} notes per scenario (seed ${args.seed}); the scenarios run once for each.`] : []),
          `Arms: ${args.arms.join(', ')}; each question asked ${args.repeat} time${args.repeat === 1 ? '' : 's'} of each answering model.`,
          `Planned: about ${plan.total} real calls (${plan.filing} filing, ${plan.brain} brain answers, ${plan.replay} replay answers).`,
          ...(args.arms.includes('brain') ? [`  files with ${fileWith.label} = ${resolved[fileWith.label]}`] : []),
          ...answerWith.map((m) => `  answers with ${m.label} = ${resolved[m.label]}`),
          'This sends every note and question in the scenarios to Anthropic and costs money. Use invented text only.',
          'Nothing was sent. Add --yes to run it.',
          '',
        ].join('\n'),
      );
      return 0;
    }
    const client = lib.createAnthropicClient({ apiKey: key.value });
    makeClient = () => client;
  }

  stderr(`Running about ${plan.total} ${mode} call${plan.total === 1 ? '' : 's'}…\n`);
  const startedAt = now();
  const { results, filing, aborted } = await runEval({
    lib, controls, scenarios, arms: args.arms, fileWith, answerWith, repeat: args.repeat, order: args.order, windowTokens: args.window, pads: args.pad, seed: args.seed, makeClient, signal: io.signal,
    onResult: (r, n) => stderr(`[${n}] ${r.arm} ${r.model} · ${r.scenario}/${r.question}${r.run > 1 ? ` #${r.run}` : ''}: ${r.pass ? 'pass' : 'FAIL'}\n`),
  });

  const meta = { mode, repeat: args.repeat, aborted, controls: controlsLabel, fileWith: fileWith.label, seed: args.seed };
  stdout(`\n${formatReport({ results, filing, meta })}\n`);

  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const json = {
    kind: 'brain-eval', startedAt: new Date(startedAt).toISOString(), mode, controls: args.controls ?? null, repeat: args.repeat, arms: args.arms, order: args.order, windowTokens: args.window, pads: args.pad, seed: args.seed,
    fileWith: fileWith.label, answerWith: answerWith.map((m) => m.label), models: resolved, aborted,
    scenarios: scenarios.map((s) => ({ id: s.id, hash: hashOf(s), notes: s.notes.length, questions: s.questions.map((q) => ({ id: q.id, kind: q.kind })) })),
    summary: summarise(results), filing, results,
  };
  try {
    const path = await io.save(args.out, `${stamp}-${mode}.json`, json);
    stdout(`\nSaved: ${path}\n`);
  } catch (error) {
    stderr(`Could not save the results: ${error.message}\n`);
  }
  return 0;
}
