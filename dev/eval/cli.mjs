// The evaluation command, with everything it touches passed in so it can be tested without a
// model, a key, a disk or a clock. `run.mjs` supplies the real ones.
import { parseArgs, resolveModels, USAGE } from './args.mjs';
import { validateGolden } from './evaluate.mjs';
import { GOLDEN } from './golden.mjs';
import { formatReport } from './report.mjs';
import { runEval, totalRuns } from './runner.mjs';
import { idealScript } from './scripted.mjs';

/**
 * @param io.argv        arguments after the command
 * @param io.env         the environment (only ANTHROPIC_API_KEY is read, and never printed)
 * @param io.lib         { createLlm, summarise, createScriptedModelClient, createAnthropicClient, readAnthropicKey, DEFAULT_TIERS }
 * @param io.stdout      (text) => void
 * @param io.stderr      (text) => void
 * @param io.loadGolden  async (path) => cases
 * @param io.save        async (dir, name, json) => path
 * @param io.now         clock in ms
 * @param io.signal      abort signal (Ctrl+C)
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

  let cases = GOLDEN;
  if (args.golden !== undefined) {
    try {
      cases = await io.loadGolden(args.golden);
    } catch (error) {
      stderr(`Could not load ${args.golden}: ${error.message}\n`);
      return 2;
    }
  }
  const problems = validateGolden(cases);
  if (problems.length > 0) {
    stderr(`The golden set has problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 2;
  }
  if (args.only !== undefined) {
    const known = new Set(cases.map((c) => c.id));
    const missing = args.only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      stderr(`No such case: ${missing.join(', ')}. Cases: ${[...known].join(', ')}\n`);
      return 2;
    }
    cases = cases.filter((c) => args.only.includes(c.id));
  }

  const models = resolveModels(args.models, lib.DEFAULT_TIERS);
  const resolved = Object.fromEntries(models.map((m) => [m.label, m.choice.tier ? lib.DEFAULT_TIERS[m.choice.tier] : m.choice.model]));
  const count = totalRuns({ cases, models, repeat: args.repeat });
  const mode = args.scripted ? 'scripted' : 'real';

  let makeClient;
  if (args.scripted) {
    makeClient = ({ caseDef, itemId }) => lib.createScriptedModelClient(idealScript(caseDef, itemId));
  } else {
    const key = lib.readAnthropicKey(io.env);
    if (!key.ok) {
      stderr(`A real run needs a key: ${key.error.message}. Use --scripted to check the harness without one.\n`);
      return 1;
    }
    if (!args.yes) {
      stdout(
        [
          `Planned: ${cases.length} cases × ${models.length} models × ${args.repeat} run${args.repeat === 1 ? '' : 's'} = ${count} real calls.`,
          ...models.map((m) => `  ${m.label} = ${resolved[m.label]}`),
          'This sends the notes and category names in the golden set to Anthropic and costs money.',
          'Nothing was sent. Add --yes to run it.',
          '',
        ].join('\n'),
      );
      return 0;
    }
    const client = lib.createAnthropicClient({ apiKey: key.value });
    makeClient = () => client;
  }

  stderr(`Running ${count} ${mode} call${count === 1 ? '' : 's'}…\n`);
  const startedAt = now();
  const { results, aborted } = await runEval({
    lib,
    cases,
    models,
    repeat: args.repeat,
    makeClient,
    now,
    signal: io.signal,
    onResult: (r, n) => stderr(`[${n}/${count}] ${r.model} · ${r.caseId}${r.run > 1 ? ` #${r.run}` : ''}: ${r.pass ? 'pass' : 'FAIL'} (${Math.round(r.latencyMs)} ms)\n`),
  });

  stdout(`\n${formatReport({ results, cases, labels: models.map((m) => m.label), resolved, meta: { mode, repeat: args.repeat, aborted } })}\n`);

  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  try {
    const path = await io.save(args.out, `${stamp}-${mode}.json`, { startedAt: new Date(startedAt).toISOString(), mode, repeat: args.repeat, aborted, models: resolved, cases: cases.map((c) => c.id), results });
    stdout(`\nSaved: ${path}\n`);
  } catch (error) {
    stderr(`Could not save the results: ${error.message}\n`);
  }
  return 0;
}
