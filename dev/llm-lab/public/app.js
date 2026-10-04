// The lab page. Everything the server returns, and everything the model wrote, is untrusted text:
// it is only ever put on the page with textContent, never as HTML.
import { askedLabel, attemptsOf, buildRequest, choiceFrom, compareChoices, compareRows, formatMs, formatTokens, historyLabel, networkSwitch, outputText, promptOf, statusOf } from './view.js';

const $ = (id) => document.getElementById(id);
const SAMPLE_CATEGORIES = '[\n  { "id": "health", "data": { "name": "Health" }, "linkCount": 12 },\n  { "id": "appointments", "data": { "name": "Appointments" }, "linkCount": 7 },\n  { "id": "errands" }\n]';

const state = { status: null, history: [], view: null /* { kind: 'run', id } | { kind: 'compare', ids, selected } */ };

/** Builds an element. Text goes in as text; there is no way to pass HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  return { status: response.status, json };
}

const showError = (id, message) => {
  const box = $(id);
  box.textContent = message ?? '';
  box.hidden = !message;
};
const setBusy = (text) => {
  $('busy').textContent = text;
  for (const id of ['run', 'compare']) $(id).disabled = text !== '';
};

// ---- the form ----

function readForm() {
  return {
    capability: $('capability').value,
    text: $('note').value,
    categoriesText: $('categories').value,
    network: $('network').checked,
    scenario: $('scenario').value,
  };
}

function modelChoice() {
  const mode = document.querySelector('input[name="model-mode"]:checked').value;
  return choiceFrom({ mode, tier: $('tier').value, model: $('model').value });
}

function refreshForm() {
  const mode = document.querySelector('input[name="model-mode"]:checked').value;
  $('tier').disabled = mode !== 'tier';
  $('model').disabled = mode !== 'model';
  const route = state.status?.routes?.[$('capability').value];
  const tierModel = state.status?.tiers?.[$('tier').value];
  $('model-hint').textContent =
    mode === 'default' ? `Uses the configured route for this capability${route ? ` (tier ${route.tier ?? route.model})` : ''}.`
    : mode === 'tier' ? `Tier ${$('tier').value} is ${tierModel ?? 'unknown'}.`
    : 'Any model id your key can use; the scripted model accepts any.';

  const available = state.status?.network?.available === true;
  const sw = networkSwitch({ available, on: $('network').checked });
  $('network').disabled = sw.disabled;
  if (sw.disabled) $('network').checked = false;
  $('network-note').textContent = '';
  $('network-note').className = 'hint';
  const note = sw.reason ?? sw.warning;
  if (note) {
    $('network-note').textContent = note;
    $('network-note').className = sw.warning ? 'warning' : 'hint';
  }
  const scripted = !$('network').checked;
  $('scenario').disabled = !scripted;
  const description = state.status?.scenarios?.find((s) => s.name === $('scenario').value)?.description;
  $('scenario-hint').textContent = scripted ? (description ?? '') : 'A real call has no scenario.';

  const badge = $('mode-badge');
  badge.textContent = scripted ? 'scripted model (free)' : 'REAL model (uses the network)';
  badge.className = `badge ${scripted ? 'scripted' : 'network'}`;
}

function fillSelect(select, options, selected) {
  select.replaceChildren(...options.map(([value, label]) => el('option', { value, text: label, selected: value === selected })));
}

// ---- drawing results ----

const fact = (key, value) => el('div', { class: 'fact' }, el('div', { class: 'k', text: key }), el('div', { class: 'v', text: String(value) }));

function runHead(record) {
  const status = statusOf(record);
  return el(
    'div',
    { class: 'run-head' },
    el('span', { class: 'id', text: record.id }),
    el('span', { class: `badge ${status.ok ? 'ok' : 'bad'}`, text: status.label }),
    el('span', { class: `badge ${record.mode === 'network' ? 'network' : 'scripted'}`, text: record.mode === 'network' ? 'real model' : `scripted: ${record.scenario}` }),
    el('span', { class: 'hint', text: status.detail }),
  );
}

function proposalSection(record) {
  const result = record.result;
  if (!result.ok) {
    return el('details', { open: true }, el('summary', { text: 'No proposal' }), el('p', { class: 'error', text: `${result.error.code}${result.error.retryable ? ' (retryable)' : ''}: ${result.error.message}` }));
  }
  const p = result.proposal;
  return el(
    'details',
    { open: true },
    el('summary', { text: 'Proposal (what you would be asked to approve)' }),
    p.rationale ? el('p', {}, el('strong', { text: 'Why: ' }), p.rationale) : null,
    el('pre', { text: p.text }),
    p.summary?.problems.length ? el('p', { class: 'error', text: 'This would fail if approved: see "Problems" above.' }) : null,
    el('h3', { text: 'Operations' }),
    el('pre', { text: JSON.stringify(p.mutation.ops, null, 2) }),
  );
}

function attemptsSection(record) {
  const attempts = attemptsOf(record.trace);
  return el(
    'details',
    { open: true },
    el('summary', { text: `Attempts (${attempts.length})` }),
    attempts.length === 0 ? el('p', { class: 'hint', text: 'No call was made: the note or categories were refused before sending.' }) : null,
    attempts.map((a) => {
      const verdict = a.verdict;
      const cls = a.failure ? 'failed' : verdict?.accepted ? 'accepted' : 'rejected';
      return el(
        'div',
        { class: `attempt ${cls}` },
        a.repairFeedback ? el('div', { class: 'repair' }, el('strong', { text: 'Repair feedback sent back: ' }), el('pre', { text: a.repairFeedback })) : null,
        el('strong', { text: `Attempt ${a.attempt}${a.attempt === 2 ? ' (repair)' : ''}` }),
        el('div', { class: 'hint', text: `asked ${a.model} · time limit ${formatMs(a.timeoutMs)} · took ${formatMs(a.elapsedMs)}${a.answeredBy && a.answeredBy !== a.model ? ` · answered by ${a.answeredBy}` : ''}${a.usage ? ` · ${formatTokens(a.usage)}` : ''}` }),
        a.failure ? el('p', { class: 'error', text: `Failed: ${a.failure.code}${a.failure.retryable ? ' (retryable)' : ''}: ${a.failure.message}` }) : null,
        a.output ? [el('div', { class: 'hint', text: 'Raw output' }), el('pre', { text: outputText(a.output) })] : null,
        verdict
          ? verdict.accepted
            ? el('p', { class: 'badge ok', text: 'The output guard accepted this.' })
            : [el('p', { text: 'The output guard rejected this:' }), el('ol', { class: 'problems' }, verdict.problems.map((p) => el('li', { text: p })))]
          : null,
      );
    }),
  );
}

function promptSection(record) {
  const prompt = promptOf(record.trace);
  if (!prompt) return null;
  return el(
    'details',
    {},
    el('summary', { text: 'Prompt that was sent' }),
    el('h3', { text: 'System (fixed instructions, no user text)' }),
    el('pre', { text: prompt.system }),
    el('h3', { text: 'User message (the note and categories sit in their own escaped blocks)' }),
    el('pre', { text: prompt.user }),
    el('h3', { text: 'Output schema' }),
    el('pre', { text: JSON.stringify(prompt.schema, null, 2) }),
  );
}

function renderRun(record) {
  return el(
    'div',
    {},
    runHead(record),
    el(
      'div',
      { class: 'facts' },
      fact('Asked for', askedLabel(record.asked)),
      fact('Model used', record.model ?? '–'),
      fact('Latency', formatMs(record.latencyMs)),
      fact('Tokens', formatTokens(record.usage)),
      fact('Attempts', attemptsOf(record.trace).length),
    ),
    proposalSection(record),
    attemptsSection(record),
    promptSection(record),
  );
}

function renderCompare(runs, selectedId) {
  const rows = compareRows(runs);
  const cell = (value) => el('td', { class: typeof value === 'number' ? 'num' : '', text: value === null ? '–' : String(value) });
  const table = el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, ['Run', 'Asked', 'Model used', 'Result', 'Attempts', 'Latency', 'Tokens', 'New categories', 'Reused', 'Links', 'Problems'].map((h) => el('th', { text: h })))),
      el(
        'tbody',
        {},
        rows.map((r) =>
          el(
            'tr',
            { class: r.id === selectedId ? 'selected' : '' },
            el('td', {}, el('button', { type: 'button', class: 'linklike', text: r.id, onclick: () => selectCompared(r.id) })),
            cell(r.asked), cell(r.model),
            el('td', {}, el('span', { class: `badge ${r.ok ? 'ok' : 'bad'}`, text: r.status })),
            cell(r.attempts), cell(r.latency), cell(r.tokens), cell(r.newCategories), cell(r.reusedCategories), cell(r.links), cell(r.problems),
          ),
        ),
      ),
    ),
  );
  const chosen = runs.find((r) => r.id === selectedId) ?? runs[0];
  return el('div', {}, el('h2', { text: `Comparing ${runs.length} models` }), table, el('h2', { class: 'spaced', text: `Detail of ${chosen.id}` }), renderRun(chosen));
}

function selectCompared(id) {
  if (state.view?.kind !== 'compare') return;
  state.view = { ...state.view, selected: id };
  draw();
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren(
    ...state.history.map((record) => {
      const status = statusOf(record);
      const current = (state.view?.kind === 'run' && state.view.id === record.id) || (state.view?.kind === 'compare' && state.view.ids.includes(record.id));
      return el(
        'li',
        {},
        el(
          'button',
          { type: 'button', 'aria-current': current ? 'true' : undefined, onclick: () => ((state.view = { kind: 'run', id: record.id }), draw()) },
          el('div', { text: historyLabel(record) }),
          el('div', { class: `sub ${status.ok ? 'ok' : 'bad'}`, text: `${status.label} · ${formatMs(record.latencyMs)} · ${formatTokens(record.usage)}` }),
        ),
      );
    }),
  );
  $('history-empty').hidden = state.history.length > 0;
}

function draw() {
  const box = $('result');
  const byId = (id) => state.history.find((r) => r.id === id);
  if (state.view?.kind === 'run' && byId(state.view.id)) box.replaceChildren(renderRun(byId(state.view.id)));
  else if (state.view?.kind === 'compare') {
    const runs = state.view.ids.map(byId).filter(Boolean);
    if (runs.length > 0) box.replaceChildren(renderCompare(runs, state.view.selected));
    else box.replaceChildren(el('p', { class: 'empty', text: 'These runs are no longer in the history.' }));
  } else box.replaceChildren(el('p', { class: 'empty' }, 'Write a note and press ', el('strong', { text: 'Run' }), '. The scripted model is used unless you switch on the real one.'));
  renderHistory();
}

// ---- actions ----

async function loadHistory() {
  const r = await api('/api/history');
  state.history = r.json.value?.items ?? [];
}

async function run(event) {
  event.preventDefault();
  showError('form-error', '');
  const built = buildRequest(readForm());
  if (!built.ok) return showError('form-error', built.message);
  setBusy('Running…');
  try {
    const r = await api('/api/run', 'POST', { ...built.body, ...modelChoice() });
    if (r.status !== 200) return showError('form-error', r.json.error ?? `HTTP ${r.status}`);
    await loadHistory();
    state.view = { kind: 'run', id: r.json.value.id };
    draw();
  } finally {
    setBusy('');
  }
}

async function compare() {
  showError('compare-error', '');
  const form = readForm();
  const built = buildRequest(form);
  if (!built.ok) return showError('compare-error', built.message);
  const tiers = [...document.querySelectorAll('#compare-tiers input:checked')].map((box) => box.value);
  const models = compareChoices({ tiers, extraModels: $('compare-extra').value, limit: state.status.limits.compareModels + 1 });
  if (models.length < 2) return showError('compare-error', 'Choose at least two models to compare (tick tiers or add model ids).');
  if (models.length > state.status.limits.compareModels) return showError('compare-error', `At most ${state.status.limits.compareModels} models at a time.`);
  setBusy(`Comparing ${models.length} models…`);
  try {
    const r = await api('/api/compare', 'POST', { ...built.body, models });
    if (r.status !== 200) return showError('compare-error', r.json.error ?? `HTTP ${r.status}`);
    await loadHistory();
    const ids = r.json.value.runs.map((x) => x.id);
    state.view = { kind: 'compare', ids, selected: ids[0] };
    draw();
  } finally {
    setBusy('');
  }
}

async function clearHistory() {
  await api('/api/history', 'DELETE');
  state.history = [];
  state.view = null;
  draw();
}

async function start() {
  const status = await api('/api/status');
  state.status = status.json.value;
  const s = state.status;
  fillSelect($('capability'), s.capabilities.map((c) => [c, c]), s.capabilities[0]);
  fillSelect($('tier'), Object.entries(s.tiers).map(([tier, model]) => [tier, `${tier} (${model})`]), 'fast');
  fillSelect($('scenario'), s.scenarios.map((x) => [x.name, x.name]), s.defaults.scenario);
  $('compare-tiers').replaceChildren(...Object.keys(s.tiers).map((tier) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', value: tier, checked: tier !== 'deep' }), tier)));
  $('categories').value = SAMPLE_CATEGORIES;
  for (const id of ['capability', 'tier', 'model', 'network', 'scenario']) $(id).addEventListener('change', refreshForm);
  for (const radio of document.querySelectorAll('input[name="model-mode"]')) radio.addEventListener('change', refreshForm);
  $('form-run').addEventListener('submit', run);
  $('compare').addEventListener('click', compare);
  $('clear').addEventListener('click', clearHistory);
  await loadHistory();
  refreshForm();
  draw();
}

start().catch((error) => {
  $('result').replaceChildren(el('p', { class: 'error', text: `The lab could not start: ${error.message}` }));
});
