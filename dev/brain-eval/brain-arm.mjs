// The brain arm (R-013 D5): the real product stack in memory, notes filed through the real propose and approve at their own
// dates, questions asked as status requests. Nothing here creates a model client: the caller supplies them, so a real one
// exists only when the caller (the command, behind its real-run switch) made it.
import { askedAt, timeOf } from './scenario.mjs';
import { scoreAnswer } from './score.mjs';
import { containsPhrase, tokens } from './text.mjs';

const HUGE = 1_000_000;
const DAY = 86_400_000;
const PASSWORD = 'correct horse 7 staple';

const unescapeBlock = (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const sum = (usages) => usages.reduce((t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens }), { inputTokens: 0, outputTokens: 0 });

/** Wraps a client so every request and the tokens it used are kept, per capability. */
export function recordingClient(inner) {
  const log = [];
  return {
    log,
    client: {
      async complete(request) {
        const entry = { capability: request.meta?.capability ?? null, model: request.model, content: request.messages.map((m) => m.content).join('\n'), usage: null };
        log.push(entry);
        const result = await inner.complete(request);
        if (result.ok) entry.usage = result.value.usage;
        return result;
      },
    },
  };
}

/** The text of the entries block of a status request, as the model saw it. */
export function entriesOf(content) {
  const m = /<entries>\n?([\s\S]*?)\n?<\/entries>/.exec(content);
  return m === null ? '' : unescapeBlock(m[1]);
}

const groupsIn = (groups, texts) => groups.map((group) => group.some((alt) => texts.some((t) => containsPhrase(t, tokens(alt)))));

/**
 * Where the first missing fact was lost, or null when every must group got through. A fact that is not in the brain was either
 * never stored ('filing') or stored and then deleted because a later note replaced it ('replace', R-014): `inRemoved` says, per
 * group, whether an item a filing removed held it.
 */
export function lostAt(inBrain, inContext, inAnswer, inRemoved = []) {
  if (inBrain.some((x) => !x)) return inBrain.some((held, i) => !held && inRemoved[i] === true) ? 'replace' : 'filing';
  if (inContext.some((x) => !x)) return 'context';
  if (inAnswer.some((x) => !x)) return 'answer';
  return null;
}

/**
 * Files the scenario's notes and asks its questions.
 * @param {object} p
 * @param {object} p.lib     the library pieces (see `LIB` in the tests)
 * @param {object} p.controls the LLM controls
 * @param {object} p.scenario a validated scenario
 * @param {{label:string, choice:object}} p.fileWith the model that files the notes
 * @param {{label:string, choice:object}[]} p.answerWith the models that answer
 * @param {(who:{role:'file'|'answer', label:string, choice:object}) => object} p.makeClient
 * @param {number} [p.repeat] how many times each question is asked of each model
 * @param {boolean} [p.replace] whether a note that changes an existing one replaces it (the product's behaviour, R-014); false files notes only, adding
 * @param {AbortSignal} [p.signal]
 * @param {(event:object)=>void} [p.onResult]
 */
export async function runBrainArm({ lib, controls, scenario, fileWith, answerWith, makeClient, repeat = 1, replace = true, signal, onResult }) {
  const filing = [];
  const answers = [];
  const clock = { value: timeOf(scenario.notes[0].at) };
  const now = () => clock.value;

  const adapter = lib.createMemoryAdapter();
  const users = lib.createUserController({
    users: lib.createMemoryUserStore(),
    sessions: lib.createMemorySessionStore({ idleMs: HUGE * DAY, absoluteMs: HUGE * DAY, renewEveryMs: DAY }),
    graphAdapter: adapter,
    hasher: lib.createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
    loginThrottle: lib.createLoginThrottle(),
    registrationThrottle: lib.createRegistrationThrottle({ max: HUGE }),
    clock: now,
  });
  const registered = await users.register({ username: 'tester', displayName: 'Tester', password: PASSWORD }, { clientKey: 'eval' });
  const login = registered.ok ? await users.login({ username: 'tester', password: PASSWORD }, { clientKey: 'eval' }) : registered;
  if (!login.ok) throw new Error('the evaluation user could not be made');
  const token = login.value.token;

  const config = (capability, choice) => {
    const r = lib.createLlmConfig({ capabilities: { [capability]: choice } });
    if (!r.ok) throw new Error(`bad model choice: ${r.error.message}`);
    return r.value;
  };
  const filer = recordingClient(makeClient({ role: 'file', label: fileWith.label, choice: fileWith.choice }));
  const fileLlm = lib.createLlm({ client: filer.client, controls, config: config('categorise', fileWith.choice), now });
  const capture = lib.createController({
    adapter, llm: fileLlm, now, ...(replace && controls.categorise.settings.maxReplaces > 0 ? {} : { candidates: false }), ids: lib.createItemIdGenerator({ now, prefix: 'note' }), proposalIds: lib.createItemIdGenerator({ now, prefix: 'prop' }), maxPending: HUGE,
  });
  const limits = { maxPendingPerUser: HUGE, proposalsPerHour: HUGE, statusPerHour: HUGE, status: { maxPerScope: HUGE, maxReadPerScope: HUGE } };
  const base = { users, capture, graphAdapter: adapter, clock: now, limits };
  const filerCaci = lib.createCaciController(base);
  const answerers = answerWith.map((m) => {
    const rec = recordingClient(makeClient({ role: 'answer', label: m.label, choice: m.choice }));
    const llm = lib.createLlm({ client: rec.client, controls, config: config('status', m.choice), now });
    return { model: m, rec, caci: lib.createCaciController({ ...base, llm }) };
  });

  /** The text of every stored item, one string per item. */
  async function stored() {
    const out = [];
    let cursor = null;
    do {
      const r = await lib.query(adapter, { version: 1, graphId: login.value.graphId, from: { all: true }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true }, page: { limit: 500, ...(cursor === null ? {} : { cursor }) } });
      if (!r.ok) throw new Error(`could not read the brain: ${r.error.message}`);
      for (const n of r.value.nodes) out.push(tokens(Object.values(n.data ?? {}).filter((v) => typeof v === 'string').join(' ')));
      cursor = r.value.nextCursor ?? null;
    } while (cursor !== null);
    return out;
  }

  /** The text of every item a filing replaced (R-014), so a fact that was deleted can be told from one never stored. */
  const removedTexts = [];
  const stopped = () => signal?.aborted === true;

  async function ask(question) {
    const items = await stored();
    for (const a of answerers) {
      for (let run = 1; run <= repeat; run++) {
        if (stopped()) return false;
        clock.value = askedAt(scenario, question);
        const before = a.rec.log.length;
        const r = await a.caci.status(token, { text: question.ask, timeZone: 'UTC' });
        const requests = a.rec.log.slice(before).filter((e) => e.capability === 'status');
        const usage = sum(requests.map((e) => e.usage).filter((u) => u !== null));
        const view = r.ok ? r.value : null;
        const score = scoreAnswer(question, view === null ? null : { headline: view.headline, points: view.points, nothing: view.nothing });
        let diagnostic = null;
        if (question.expectNothing !== true) {
          const sent = requests[0] === undefined ? [] : [tokens(entriesOf(requests[0].content))];
          const inBrain = groupsIn(question.must, items);
          const inContext = groupsIn(question.must, sent);
          const inAnswer = score.groups.map((g) => g.met);
          const inRemoved = groupsIn(question.must, removedTexts);
          diagnostic = { inBrain, inContext, inAnswer, inRemoved, lostAt: lostAt(inBrain, inContext, inAnswer, inRemoved) };
        }
        const record = {
          arm: 'brain', scenario: scenario.id, question: question.id, kind: question.kind, model: a.model.label, run,
          pass: score.pass, score, error: r.ok ? null : { source: r.error.source, code: r.error.error?.code ?? null, message: r.error.error?.message ?? null },
          answer: view === null ? null : { headline: view.headline, points: view.points.map((p) => p.text), nothing: view.nothing },
          tokens: usage, attempts: requests.length, entriesUsed: view?.entriesUsed ?? null, entriesLeftOut: view?.entriesLeftOut ?? null, diagnostic,
        };
        answers.push(record);
        onResult?.(record);
      }
    }
    return true;
  }

  for (const note of scenario.notes) {
    if (stopped()) return { filing, answers, aborted: true };
    clock.value = Math.max(clock.value, timeOf(note.at));
    const before = filer.log.length;
    const proposed = await filerCaci.propose(token, { text: note.text });
    let error = null;
    const replaced = proposed.ok && Array.isArray(proposed.value.summary?.removed) ? proposed.value.summary.removed.map((r) => ({ id: r.id, title: r.title, summary: r.summary })) : [];
    let tidied = 0;
    if (!proposed.ok) error = { stage: 'propose', source: proposed.error.source, code: proposed.error.error?.code ?? null, message: proposed.error.error?.message ?? null };
    else {
      const approved = await filerCaci.approve(token, proposed.value.id);
      if (!approved.ok) error = { stage: 'approve', source: approved.error.source, code: approved.error.error?.code ?? null, message: approved.error.error?.message ?? null };
      else {
        tidied = approved.value.tidied?.length ?? 0;
        for (const r of replaced) removedTexts.push(tokens(`${r.title} ${r.summary}`));
      }
    }
    const requests = filer.log.slice(before).filter((e) => e.capability === 'categorise');
    filing.push({ note: note.id, at: note.at, ok: error === null, error, attempts: requests.length, tokens: sum(requests.map((e) => e.usage).filter((u) => u !== null)), replaced: error === null ? replaced : [], tidied });
    for (const q of scenario.questions.filter((x) => x.after === note.id)) {
      if (!(await ask(q))) return { filing, answers, aborted: true };
      clock.value = Math.max(clock.value, timeOf(note.at));
    }
  }
  return { filing, answers, aborted: false };
}
