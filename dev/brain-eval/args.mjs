// Command-line arguments for `npm run brain-eval`. Pure.
import { resolveModels } from '../eval/args.mjs';
import { MAX_PAD } from './pad.mjs';
import { DEFAULT_WINDOW_TOKENS, ORDERS } from './replay-arm.mjs';

export { resolveModels };
export const ARMS = Object.freeze(['brain', 'replay']);
export const DEFAULT_FILE_WITH = 'fast';
export const DEFAULT_ANSWER_WITH = Object.freeze(['fast', 'balanced', 'deep']);
export const DEFAULT_REPEAT = 3;

export const USAGE = `Usage: npm run brain-eval -- [options]

Asks the same questions of two ways of remembering invented notes: the brain (notes filed into the graph, then a status
request) and replay (every raw note shown to the model in time order). Scores each answer by rules.

  --scenarios DIR    the folder of scenario files. Default: dev/brain-eval/scenarios
  --only a,b         run only these scenario ids
  --file-with m      the model that files the notes into the brain (a tier or an exact model id). Default: ${DEFAULT_FILE_WITH}
  --answer-with a,b  the models that answer the questions. Default: ${DEFAULT_ANSWER_WITH.join(',')}
  --arms a,b         brain, replay or both. Default: brain,replay
  --repeat n         times each question is asked of each model, 1 to 10. Default: ${DEFAULT_REPEAT}
  --pad n,m          filler notes mixed into each scenario, to test volume: one number or a list such as 0,100,300. Default: 0
  --seed n           seed for the filler, so a run can be repeated. Default: 1
  --order o          replay order: ${ORDERS.join(' or ')}. Default: ${ORDERS[0]}
  --window n         replay: a transcript above about n tokens is not sent. Default: ${DEFAULT_WINDOW_TOKENS}
  --controls DIR     try a candidate folder of LLM controls instead of controls/ (it is checked first)
  --demo             use the free demo model: checks the plumbing, says nothing about quality
  --yes              actually call the real models. Without it a real run only prints its plan
  --compare A B      compare two saved results (the JSON files from --out) and exit: no model is called
  --rescore FILE     re-score a saved result with the current rules (offline: no model, no key) and save it beside the original
  --force            with --compare or --rescore: go on even if the scenarios or questions have changed
  --out DIR          where results are saved. Default: brain-eval-results (git-ignored)
  --help             this text

A real run needs ANTHROPIC_API_KEY, costs money, and sends the scenarios' notes to Anthropic. Use invented text only.`;

const FLAGS_WITH_VALUE = ['--scenarios', '--only', '--file-with', '--answer-with', '--arms', '--repeat', '--order', '--pad', '--seed', '--window', '--controls', '--rescore', '--out'];
const FLAGS = ['--demo', '--yes', '--help', '--force'];
const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** `{ ok: true, value }` or `{ ok: false, message }`. */
export function parseArgs(argv) {
  const value = {
    scenarios: undefined, only: undefined, fileWith: DEFAULT_FILE_WITH, answerWith: [...DEFAULT_ANSWER_WITH], arms: [...ARMS], repeat: DEFAULT_REPEAT,
    order: ORDERS[0], pad: [0], seed: 1, window: DEFAULT_WINDOW_TOKENS, controls: undefined, compare: undefined, rescore: undefined, force: false, demo: false, yes: false, out: 'brain-eval-results', help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.includes(arg)) {
      if (arg === '--force') value.force = true;
      else if (arg === '--demo') value.demo = true;
      else if (arg === '--yes') value.yes = true;
      else value.help = true;
      continue;
    }
    if (arg === '--compare') {
      const files = [argv[i + 1], argv[i + 2]];
      if (files.some((f) => f === undefined || f.startsWith('--'))) return { ok: false, message: '--compare needs two files: --compare before.json after.json' };
      value.compare = files;
      i += 2;
      continue;
    }
    if (!FLAGS_WITH_VALUE.includes(arg)) return { ok: false, message: `unknown option ${arg} (try --help)` };
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return { ok: false, message: `${arg} needs a value` };
    i++;
    if (arg === '--scenarios') value.scenarios = next;
    else if (arg === '--only') {
      const only = [...new Set(list(next))];
      if (only.length === 0) return { ok: false, message: '--only needs at least one scenario id' };
      value.only = only;
    } else if (arg === '--file-with') {
      const one = list(next);
      if (one.length !== 1) return { ok: false, message: '--file-with takes exactly one model' };
      value.fileWith = one[0];
    } else if (arg === '--answer-with') {
      const models = [...new Set(list(next))];
      if (models.length === 0) return { ok: false, message: '--answer-with needs at least one model' };
      value.answerWith = models;
    } else if (arg === '--arms') {
      const arms = [...new Set(list(next))];
      const bad = arms.find((a) => !ARMS.includes(a));
      if (arms.length === 0 || bad !== undefined) return { ok: false, message: `--arms must be a list of: ${ARMS.join(', ')}` };
      value.arms = ARMS.filter((a) => arms.includes(a));
    } else if (arg === '--repeat') {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false, message: '--repeat must be a whole number from 1 to 10' };
      value.repeat = n;
    } else if (arg === '--order') {
      if (!ORDERS.includes(next)) return { ok: false, message: `--order must be one of: ${ORDERS.join(', ')}` };
      value.order = next;
    } else if (arg === '--pad') {
      const pads = list(next).map(Number);
      if (pads.length === 0 || pads.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_PAD)) return { ok: false, message: `--pad must be whole numbers from 0 to ${MAX_PAD}, such as 0,100,300` };
      value.pad = [...new Set(pads)].sort((a, b) => a - b);
    } else if (arg === '--seed') {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0) return { ok: false, message: '--seed must be a whole number, 0 or more' };
      value.seed = n;
    } else if (arg === '--window') {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1000) return { ok: false, message: '--window must be a whole number of tokens, at least 1000' };
      value.window = n;
    } else if (arg === '--controls') value.controls = next;
    else if (arg === '--rescore') value.rescore = next;
    else value.out = next;
  }
  if (value.force && value.compare === undefined && value.rescore === undefined) return { ok: false, message: '--force is only for --compare or --rescore' };
  if (value.demo && value.yes) return { ok: false, message: '--demo and --yes together make no sense: --yes is for real calls' };
  return { ok: true, value };
}
