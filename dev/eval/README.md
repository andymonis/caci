# Evaluation harness (local development only)

Runs a golden set of sample notes through the real `categorise` on several models and prints their
results side by side, so the model for categorising is chosen on evidence rather than guesswork.
**It is never part of the library or the published package.**

```
npm run eval -- --scripted                         # checks the harness itself: free, no key
npm run eval -- --models fast,balanced,deep        # plans a real run and prints it; sends nothing
npm run eval -- --models fast,balanced,deep --yes  # makes the real calls
```

A real run needs `ANTHROPIC_API_KEY` in the environment (`source ./set-key.sh` if you keep the key
in the vault file), makes (cases × models × repeat) calls, **costs money, and sends the notes and
category names in the golden set to Anthropic**. That is why it prints a plan and stops unless you
add `--yes`. The key is read once, passed to the client and never printed or saved.

## Options

| Option | Meaning |
| --- | --- |
| `--capability c` | What to evaluate: `categorise` (default) or `status` (R-011) |
| `--controls DIR` | Try a candidate folder of LLM controls (the six files of `controls/`) instead of the shipped one. It is checked first, with the service's own code; a bad folder stops with every problem listed before any call |
| `--models a,b,c` | Tiers (`fast`, `balanced`, `deep`) or exact model ids. Default: all three tiers |
| `--repeat n` | Runs per case and model, 1 to 10. Models are not deterministic, so 3 gives a steadier pass rate |
| `--golden file` | Your own golden set (`.json`, or `.mjs` exporting `GOLDEN`) instead of the built-in one |
| `--only a,b` | Run only these case ids |
| `--scripted` | A scripted model answers every case correctly: proves the harness works and costs nothing |
| `--yes` | Actually call the real model |
| `--out dir` | Where results are saved (default `eval-results/`, which git ignores) |

## What it reports

Per model: pass rate, how many calls answered, how many needed the repair attempt, latency (median,
95th percentile, slowest), tokens in and out and per run; the most common failed checks; any errors by
code; then a case-by-model grid and the reasons for each failure. Tokens, not prices, are shown,
because prices change. The full results, with every check, the proposal and the tokens for each run,
are saved as JSON in `eval-results/`.

## The golden set

`golden.mjs` has 15 invented notes with loose expectations, so a sensible model passes without
matching one exact answer: it reuses an existing category (`reuse`), does not link where it should
not (`avoidReuse`), does not invent a duplicate of an existing category (`mustNotCreate`, matched by
whole word, so `doctor` catches `doctor-visits`), and stays within a number of new categories and
links. Every case also needs the call to succeed and its preview to have no problems. The set covers
a plain reuse, a note that fits nothing, an empty graph, 60 categories, a very short note, a
rambling one, a note in French, a prompt-injection attempt and a near-duplicate trap.

To use your own notes, put them in a file outside the repository's tracked files (or in
`eval-results/`) and pass `--golden`. Real notes sent this way go to Anthropic, as above.

## How it is tested

`npm test` runs the plumbing only, against the scripted model: the checks, the runner, the report,
the arguments and the command. Two tests matter most: an ideal scripted model must pass **every**
case (so the set can be satisfied), and deliberately poor ones (always the first category, an invented
duplicate, links to everything) must fail many (so the checks discriminate).

| File | Purpose |
| --- | --- |
| `run.mjs` | Entry point: loads the built library, reads the key, calls `cli.mjs` |
| `cli.mjs` | The command, with everything it touches passed in |
| `args.mjs` | Options |
| `golden.mjs` | The golden set |
| `evaluate.mjs` | Pure checks of one run against one case, and validation of a golden set |
| `runner.mjs` | Runs cases on models, one call at a time, using `categorise` and its trace |
| `report.mjs` | Figures and the side-by-side text report |
| `scripted.mjs` | The ideal scripted model |

## Evaluating `status`

```
npm run eval -- --capability status --scripted                      # free: checks the harness
npm run eval -- --capability status --models fast,balanced,deep     # plans; sends nothing
npm run eval -- --capability status --models fast,balanced,deep --yes
```

Six invented cases (`status-golden.mjs`): a morning check, "I am heading into town", nothing relevant, many
entries over the budget, an instruction hidden in a note, and two circles with conflicting facts. Checks are
loose and each is reported: the call succeeds, the right entries are cited (and the irrelevant ones are not),
"nothing relevant" is said exactly when it should be, the number of points is within bounds, no number appears
that is not in the request or the entries (nothing invented), and a forbidden word (the one the hidden
instruction asks for) never appears. The default tier for `status` (`balanced`) stays provisional until a
real run compares the tiers; a real run sends the requests and the notes in the golden set to Anthropic.

## Trying a change to the controls (R-012)

The words and limits that steer the model live in `controls/` (see the README's "Controlling what the model is told").
To see what a change does without deploying it:

```
cp -r controls /tmp/candidate                       # edit the files in /tmp/candidate
npm run eval -- --scripted --controls /tmp/candidate                     # does it still load and run? (free)
npm run eval -- --models fast,balanced --repeat 3 --controls /tmp/candidate --yes    # real calls, the same set
npm run eval -- --models fast,balanced --repeat 3 --yes                  # the shipped controls, for comparison
```

The report header and the saved results name the folder (`Controls: ...`, or `the shipped controls/ folder`), so two
runs can be compared. A limit in `settings.json` moves the prompt, the schema and the guard together: for example
`"maxPoints": 1` makes the scripted ideal model's two-point answers fail with `BAD_OUTPUT`, which is how you see a
limit has taken effect. The LLM lab takes the same option: `npm run dev:lab -- --controls /tmp/candidate`.
