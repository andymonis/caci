// Command-line arguments for `npm run eval`. Pure.

export const DEFAULT_MODELS = Object.freeze(['fast', 'balanced', 'deep']);
export const USAGE = `Usage: npm run eval -- [options]

  --models a,b,c   tiers (fast, balanced, deep) or exact model ids. Default: fast,balanced,deep
  --repeat n       runs per case and model, 1 to 10 (models are not deterministic). Default: 1
  --golden file    use your own golden set instead of the built-in one (.json or .mjs exporting GOLDEN)
  --only a,b       run only these case ids
  --scripted       use a scripted model that answers every case correctly: checks the harness, costs nothing
  --yes            actually call the real model. Without it, a real run only prints what it would do
  --out dir        where results are saved. Default: eval-results (git-ignored)
  --help           this text

A real run needs ANTHROPIC_API_KEY, makes (cases × models × repeat) calls, costs money, and sends
the notes and category names in the golden set to Anthropic.`;

const FLAGS_WITH_VALUE = ['--models', '--repeat', '--golden', '--only', '--out'];
const FLAGS = ['--scripted', '--yes', '--help'];

const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** `{ ok: true, value }` or `{ ok: false, message }`. */
export function parseArgs(argv) {
  const value = { models: [...DEFAULT_MODELS], repeat: 1, golden: undefined, only: undefined, scripted: false, yes: false, out: 'eval-results', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.includes(arg)) {
      if (arg === '--scripted') value.scripted = true;
      else if (arg === '--yes') value.yes = true;
      else value.help = true;
    } else if (FLAGS_WITH_VALUE.includes(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { ok: false, message: `${arg} needs a value` };
      i++;
      if (arg === '--models') {
        const models = [...new Set(list(next))];
        if (models.length === 0) return { ok: false, message: '--models needs at least one model' };
        value.models = models;
      } else if (arg === '--repeat') {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false, message: '--repeat must be a whole number from 1 to 10' };
        value.repeat = n;
      } else if (arg === '--golden') value.golden = next;
      else if (arg === '--only') {
        const only = [...new Set(list(next))];
        if (only.length === 0) return { ok: false, message: '--only needs at least one case id' };
        value.only = only;
      } else value.out = next;
    } else {
      return { ok: false, message: `unknown option ${arg} (try --help)` };
    }
  }
  if (value.scripted && value.yes) return { ok: false, message: '--scripted and --yes together make no sense: --yes is for real calls' };
  return { ok: true, value };
}

/** Each model argument is a tier name or an exact model id. */
export function resolveModels(tokens, tiers) {
  return tokens.map((label) => ({ label, choice: Object.hasOwn(tiers, label) ? { tier: label } : { model: label } }));
}
