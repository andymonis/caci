# Running the test applications

A short guide to the things you can start on your own machine. Everything here is for development and testing:
nothing is published, and the tools in `dev/` refuse to run in production.

You need **Node 22.13 or later** and, once, `npm install` in the project folder. Each command below builds the
project first, so you do not need to build by hand.

## 1. The CaCi web app (the real thing, on your laptop)

```
npm run serve
```

Open the address it prints (usually `http://127.0.0.1:8080/`). **Register yourself first**: the first account
becomes the administrator. Notes are filed by the free **demo model**, so nothing leaves your machine.

- Your data is in `./data/` (`graphs.db`, `users.db`). Delete that folder to start again from nothing.
- Another port or folder: `CACI_PORT=9090 CACI_DATA_DIR=/tmp/caci-test npm run serve`
- Stop with Ctrl+C.

**With the real model (Anthropic).** Put your key in the file `set-key.sh` uses, then:

```
npm run live
```

Everything you type is then sent to Anthropic and costs a little money. Do not use other people's data.

## 2. The graph explorer (see the graph being built)

```
npm run dev:explorer
```

Open the address it prints. Pick a scenario, watch nodes and links appear, try the Query panel, or use
**Capture a note** to propose, preview and approve a filing. Add `-- --db ./data/explorer.db` to keep the data
between runs.

## 3. The LLM lab (see exactly what is sent to the model)

```
npm run dev:lab
```

Pick a scenario (the free scripted model) and press Run. You see the three parts of each message (the request,
the context, the controls), the raw reply, what the guard said and the tokens. **Compare** runs one note on several
models. A real call happens only if a key is found **and** you tick the "real model" switch.

To try changed instructions or limits without deploying them:

```
cp -r controls /tmp/candidate        # edit the files in /tmp/candidate
npm run dev:lab -- --controls /tmp/candidate
```

## 4. The evaluation (is the model any good at this?)

```
npm run eval -- --scripted                          # checks the tool itself: free, nothing sent
npm run eval -- --capability status --scripted      # the same for status updates
npm run eval -- --models fast,balanced,deep         # shows the plan for a real run and sends nothing
npm run eval -- --models fast,balanced,deep --yes   # the real run: costs money, sends the sample notes to Anthropic
```

A real run needs `ANTHROPIC_API_KEY` in the environment (`source ./set-key.sh` first). Results are saved in
`eval-results/`. Add `--repeat 3` for steadier numbers, and `--controls /tmp/candidate` to run the same set against
changed instructions (compare the two reports). More options: `npm run eval -- --help`.

## 5. The brain evaluation (does the brain beat replaying the text?)

```
npm run brain-eval -- --demo                        # free: checks the plumbing with a stand-in model
npm run brain-eval                                  # shows the plan for a real run and sends nothing
npm run brain-eval -- --yes                         # the real run: costs money, sends the invented scenarios to Anthropic
npm run brain-eval -- --yes --pad 0,100,300         # also with filler notes, to test volume
npm run brain-eval -- --compare before.json after.json   # what changed between two saved runs
```

It files invented dated notes into the brain and asks questions (such as "what tablets does Mum take?" after a dose changed), then asks the same questions with all the notes shown as plain text, and scores both by rules. Needs `ANTHROPIC_API_KEY` for a real run. Results are saved in `brain-eval-results/`. The scenarios are in `dev/brain-eval/scenarios/` (read `REVIEW.md` there first). Only invented text goes in a scenario.

## 6. The automated tests

```
npm test            # all the tests
npm run gate        # the full check: types, lint, tests and the public API report
```

Run `npm run gate` before every commit.

## 7. Other tools

| Command | What it does |
|---|---|
| `npm run llm:try` | Sends one sample note to the real API (needs a key; costs a little) |
| `npm run bench:sqlite` | Times the database at 10,000 items (add `-- --size smoke` for a quick one) |
| `npm run users -- recover-admin <username>` | Sets a new password for a locked-out administrator (reads it from the terminal) |
| `npm run backup -- --dest ./backups` | Takes a snapshot of the data |
| `npm run restore -- <snapshot folder> --yes` | Puts a snapshot back (stop the service first) |

## Good to know

- **Demo model vs real model.** The demo model is free and deterministic but is not a classifier; use it to try the
  flow. Only the real model tells you about quality.
- **Keys.** Never type a key on a command line. `set-key.sh` is `source`d, not run: `source ./set-key.sh`.
- **Starting again.** `./data/` holds the web app's data; the explorer and lab keep theirs in memory unless told otherwise.
- **Something odd after pulling changes?** Run `npm install`, then try again.
- **The Raspberry Pi** has its own instructions in the README ("Running on a Raspberry Pi").
