# Brain evaluation (local development only)

Asks one question: **does the CaCi brain answer questions about a person's notes better than keeping all the notes as text and replaying them?** It files invented, dated notes through the real product path, asks questions at chosen points, and scores the answers by rules. **It is never part of the library or the published package, and only invented text belongs in a scenario.** The design is in `specs/R-013-brain-evaluation.md`; the overview is in the main README under *Testing the brain against replaying the text*.

```
npm run brain-eval -- --demo     # free: a stand-in model checks the plumbing, says nothing about quality
npm run brain-eval               # plans a real run and prints it; sends nothing
npm run brain-eval -- --yes      # makes the real calls
```

A real run needs `ANTHROPIC_API_KEY` in the environment (`source ./set-key.sh` if you keep the key in the vault file), **costs money, and sends every note and question in the scenarios to Anthropic**. That is why it prints a plan and stops unless you add `--yes`. The key is read once, passed to the client and never printed or saved.

## Options

| Option | Meaning |
|--------|---------|
| `--scenarios DIR` | the folder of scenario files (default `dev/brain-eval/scenarios`) |
| `--only a,b` | run only these scenario ids |
| `--file-with m` | the model that files the notes into the brain: a tier (`fast`, `balanced`, `deep`) or an exact model id (default `fast`) |
| `--answer-with a,b` | the models that answer (default `fast,balanced,deep`) |
| `--arms a,b` | `brain`, `replay` or both (default both) |
| `--repeat n` | times each question is asked of each model, 1 to 10 (default 3) |
| `--order o` | replay order: `oldest-first` (default) or `newest-first` |
| `--window n` | replay: a transcript above about n tokens is not sent (default 150000) |
| `--pad n,m` | filler notes mixed into each scenario, one number or a list such as `0,100,300` (default 0) |
| `--seed n` | seed for the filler, so a run can be repeated (default 1) |
| `--controls DIR` | try a candidate folder of LLM controls instead of `controls/`; it is checked first |
| `--compare A B` | compare two saved results and exit; no model is called |
| `--rescore FILE` | re-score a saved result with the current rules, offline (no model, no key), and save it beside the original as `NAME-rescored.json` |
| `--force` | with `--compare` or `--rescore`: go on even if the scenarios or questions have changed |
| `--demo` | use the free demo model; refuses `--yes` |
| `--yes` | actually call the real models |
| `--out DIR` | where results are saved (default `brain-eval-results`, git-ignored) |

## What is in here

| File | What it does |
|------|--------------|
| `scenario.mjs` | the scenario format, the loader and the validator (every problem listed at once) |
| `text.mjs`, `score.mjs` | the scoring rules: normalisation, whole-word phrase matching, stale phrases and the cues that excuse them |
| `brain-arm.mjs` | the brain arm: the real stack in memory, notes filed at their dates, questions as status requests, and the diagnostic |
| `replay-arm.mjs` | the replay arm: the same capability, shown every raw note |
| `pad.mjs` | the seeded filler |
| `args.mjs`, `runner.mjs`, `report.mjs`, `compare.mjs`, `rescore.mjs`, `cli.mjs`, `run.mjs` | the options, running, the report, comparing two runs, re-scoring a saved run, the command |
| `list.mjs` | prints the whole library on one page (`scenarios/REVIEW.md`) |
| `scenarios/` | the invented scenarios, a `README.md` on writing one and `REVIEW.md` |

`*.test.mjs` and `*.test-util.mjs` are tests and their helpers.

## Honest limits

Invented scenarios show whether the mechanism works, not how real notes behave. Rules miss correct answers given in other words. Real models vary, so use repeats and compare runs. The brain currently stores both the old and the new fact and does not resolve changes when storing; this tool measures how that works out and does not change it.
