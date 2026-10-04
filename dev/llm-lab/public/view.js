// Pure helpers for the lab page: no DOM, no network. They turn what the server returns into plain
// structures the page draws, and turn the form into a request. Tested in ../view.test.mjs.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatTokens(usage) {
  return isObject(usage) ? `${usage.inputTokens} in / ${usage.outputTokens} out` : '–';
}

/** How a run ended, for a badge: `{ ok, label, detail }`. */
export function statusOf(record) {
  const result = record?.result;
  if (!isObject(result)) return { ok: false, label: 'Unknown', detail: '' };
  if (result.ok) {
    const repaired = result.proposal.attempts === 2;
    return { ok: true, label: repaired ? 'Accepted after repair' : 'Accepted', detail: repaired ? '2 attempts' : '1 attempt' };
  }
  const { code, retryable, message } = result.error;
  return { ok: false, label: `Failed: ${code}`, detail: `${retryable ? 'retryable. ' : ''}${message ?? ''}`.trim() };
}

/** What was asked for the model, in words. */
export function askedLabel(asked) {
  if (isObject(asked) && typeof asked.model === 'string') return `model ${asked.model}`;
  if (isObject(asked) && typeof asked.tier === 'string') return `tier ${asked.tier}`;
  return 'default tier';
}

/** A raw model output (text or JSON) as text to show. */
export function outputText(output) {
  if (!isObject(output)) return '';
  if (output.kind === 'text') return String(output.text);
  try {
    return JSON.stringify(output.value, null, 2) ?? '';
  } catch {
    return '(unreadable)';
  }
}

/** The prompt that was built: the instructions, the user message and the schema. */
export function promptOf(trace) {
  const event = (trace ?? []).find((e) => e.type === 'prompt');
  if (event === undefined) return null;
  return { system: event.system, user: event.messages.map((m) => m.content).join('\n\n'), schema: event.schema };
}

/**
 * The model calls of a run, in order, each with what was sent, what came back, what the guard said,
 * and (for the repair) the feedback that prompted it.
 */
export function attemptsOf(trace) {
  const attempts = [];
  let feedback = null;
  for (const event of trace ?? []) {
    if (event.type === 'repair') feedback = event.feedback;
    else if (event.type === 'request') {
      attempts.push({ attempt: event.attempt, model: event.model, timeoutMs: event.timeoutMs, repairFeedback: feedback, output: null, usage: null, answeredBy: null, elapsedMs: null, failure: null, verdict: null });
      feedback = null;
    } else if (attempts.length > 0) {
      const current = attempts[attempts.length - 1];
      if (event.type === 'response') Object.assign(current, { output: event.output, usage: event.usage, answeredBy: event.model, elapsedMs: event.elapsedMs });
      else if (event.type === 'failure') Object.assign(current, { failure: event.error, elapsedMs: event.elapsedMs });
      else if (event.type === 'verdict') current.verdict = { accepted: event.accepted, problems: event.problems };
    }
  }
  return attempts;
}

/** One row per run for the compare table. */
export function compareRows(runs) {
  return runs.map((record) => {
    const status = statusOf(record);
    const proposal = record.result?.ok ? record.result.proposal : null;
    const summary = proposal?.summary ?? null;
    return {
      id: record.id,
      asked: askedLabel(record.asked),
      model: record.model ?? '–',
      ok: status.ok,
      status: status.label,
      attempts: proposal ? proposal.attempts : attemptsOf(record.trace).length,
      latency: formatMs(record.latencyMs),
      tokens: formatTokens(record.usage),
      newCategories: summary ? summary.newCategories.length : null,
      reusedCategories: summary ? summary.reusedCategories.length : null,
      links: summary ? summary.newLinks.length : null,
      problems: summary ? summary.problems.length : null,
      rationale: proposal?.rationale ?? null,
    };
  });
}

export function historyLabel(record) {
  const how = record.mode === 'network' ? 'real' : `scripted: ${record.scenario}`;
  return `${record.id} · ${how} · ${record.model ?? 'no model'}`;
}

/** Parses the categories box: empty is none; otherwise a JSON list of objects with a text `id`. */
export function parseCategories(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: true, value: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `Not valid JSON: ${error.message}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, message: 'Must be a list, like [{"id":"health"}]' };
  const at = parsed.findIndex((c) => !isObject(c) || typeof c.id !== 'string' || c.id === '');
  if (at !== -1) return { ok: false, message: `Item ${at + 1} needs a text "id"` };
  return { ok: true, value: parsed };
}

/** The model choice for one run, from the form. */
export function choiceFrom({ mode, tier, model }) {
  if (mode === 'model') return { model: String(model ?? '').trim() };
  if (mode === 'tier' && tier) return { tier };
  return {};
}

/** The choices for a compare: the ticked tiers, then any extra exact model ids (comma, space or line separated), without repeats. */
export function compareChoices({ tiers, extraModels, limit }) {
  const choices = [];
  const seen = new Set();
  const add = (choice, key) => {
    if (!seen.has(key)) {
      seen.add(key);
      choices.push(choice);
    }
  };
  for (const tier of tiers ?? []) add({ tier }, `tier:${tier}`);
  for (const model of String(extraModels ?? '').split(/[\s,]+/).filter(Boolean)) add({ model }, `model:${model}`);
  return limit === undefined ? choices : choices.slice(0, limit);
}

/** The body of a run request from the form, or what is wrong with the form. */
export function buildRequest(form) {
  const categories = parseCategories(form.categoriesText);
  if (!categories.ok) return { ok: false, message: `Categories: ${categories.message}` };
  if (typeof form.text !== 'string' || form.text.trim() === '') return { ok: false, message: 'Write a note first.' };
  const body = { capability: form.capability ?? 'categorise', text: form.text, categories: categories.value };
  if (form.network) body.network = true;
  else if (form.scenario) body.scenario = form.scenario;
  return { ok: true, body };
}

/** What the "uses the network" switch should look like. */
export function networkSwitch({ available, on }) {
  if (!available) {
    return { disabled: true, checked: false, reason: 'No ANTHROPIC_API_KEY was found when the lab started, so only the scripted model is available.', warning: null };
  }
  return {
    disabled: false,
    checked: Boolean(on),
    reason: null,
    warning: on ? 'This sends the note and the category names to Anthropic and costs money.' : null,
  };
}
