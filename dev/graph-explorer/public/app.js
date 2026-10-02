import { computeLayout, describeDiff, diffGraphs, edgePath, mergeOrder, nodeKey } from './layout.js';
import { rejected, scenarios } from './scenarios.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = $('canvas');
const edgeLayer = svgEl('g');
const nodeLayer = svgEl('g');
svg.append(edgeLayer, nodeLayer);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  graphId: null,
  data: null, // last snapshot of the current graph
  order: { item: [], category: [] },
  nodes: new Map(), // key -> { g, shape, text, x, y, tx, ty, exiting }
  edges: new Map(), // key -> { g, line, hit, item, category, weight, exiting, d }
  selection: null, // { type: 'node', key } | { type: 'edge', key }
  scenario: { def: scenarios[0], index: 0, timer: null },
  frame: 0,
  rawDirty: false,
};

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function html(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, String(value));
  }
  el.append(...children);
  return el;
}

// ---------- talking to the local server ----------

async function api(path, method = 'GET', body) {
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (response.ok) return json;
    return { ok: false, error: { code: `HTTP_${response.status}`, message: json.error ?? response.statusText } };
  } catch (error) {
    return { ok: false, error: { code: 'NETWORK', message: String(error.message ?? error) } };
  }
}

// ---------- log and status ----------

function log(label, request, result) {
  const ok = result.ok === true;
  const tag = ok ? 'ok' : result.error?.code ?? 'error';
  const summary = html('summary', {}, html('span', { class: 'tag' }, tag), html('span', {}, label), html('time', {}, new Date().toLocaleTimeString()));
  const body = html('pre', {}, `${request === undefined ? '' : `request\n${JSON.stringify(request, null, 2)}\n\n`}result\n${JSON.stringify(result, null, 2)}`);
  const item = html('li', { class: ok ? 'ok' : 'err' }, html('details', {}, summary, body));
  const list = $('log');
  list.prepend(item);
  while (list.children.length > 100) list.lastChild.remove();
}

function setChange(text, isError = false) {
  const el = $('change');
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : 'var(--accent)';
}

// ---------- rendering ----------

function render(value, { animate }) {
  const previous = animate ? state.data : null;
  state.data = value;
  const empty = value === null;
  const graph = empty ? { items: [], categories: [], edges: [] } : value;

  state.order.item = mergeOrder(state.order.item, graph.items.map((n) => n.id));
  state.order.category = mergeOrder(state.order.category, graph.categories.map((n) => n.id));
  const pick = (ids, list) => {
    const byId = new Map(list.map((n) => [n.id, n]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  };
  const layout = computeLayout({ items: pick(state.order.item, graph.items), categories: pick(state.order.category, graph.categories), edges: graph.edges });
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  $('empty').hidden = !empty && (graph.items.length > 0 || graph.categories.length > 0);

  const diff = diffGraphs(previous, graph);
  const flash = new Set([...diff.nodes.added, ...diff.nodes.changed, ...diff.edges.added, ...diff.edges.changed]);
  reconcileNodes(layout, flash, previous !== null);
  reconcileEdges(layout, flash, previous !== null);
  startTween();
  renderCounts(value);
  renderLists(graph);
  if (previous !== null) setChange(describeDiff(diff));
  if (state.selection) renderSelection();
}

function reconcileNodes(layout, flash, animate) {
  for (const node of layout.nodes.values()) {
    let rec = state.nodes.get(node.key);
    if (rec === undefined) {
      const isItem = node.partition === 'item';
      const shape = isItem ? svgEl('circle', { r: 9, class: 'shape' }) : svgEl('rect', { x: -9, y: -9, width: 18, height: 18, rx: 4, class: 'shape' });
      const text = svgEl('text', { x: isItem ? -16 : 16, y: 4 });
      const title = svgEl('title');
      const g = svgEl('g', { class: `node ${node.partition}`, tabindex: 0, role: 'button' });
      g.append(shape, text, title);
      g.addEventListener('click', () => select({ type: 'node', key: node.key }));
      g.addEventListener('keydown', (event) => event.key === 'Enter' && select({ type: 'node', key: node.key }));
      g.addEventListener('mouseenter', () => highlight(node.key));
      g.addEventListener('mouseleave', () => highlight(null));
      rec = { g, text, title, x: node.x, y: node.y, tx: node.x, ty: node.y, exiting: false };
      if (animate) g.classList.add('enter');
      nodeLayer.append(g);
      state.nodes.set(node.key, rec);
      place(rec);
    }
    rec.tx = node.x;
    rec.ty = node.y;
    if (rec.exiting) {
      rec.exiting = false;
      rec.g.classList.remove('exit');
    }
    rec.text.textContent = node.id;
    rec.title.textContent = node.data === undefined ? node.id : `${node.id}\n${JSON.stringify(node.data)}`;
    if (animate && flash.has(node.key)) pulse(rec.g);
  }
  for (const [key, rec] of state.nodes) {
    if (!layout.nodes.has(key) && !rec.exiting) retire(state.nodes, key, rec);
  }
}

function reconcileEdges(layout, flash, animate) {
  const live = new Set();
  for (const edge of layout.edges) {
    live.add(edge.key);
    let rec = state.edges.get(edge.key);
    if (rec === undefined) {
      const line = svgEl('path', { class: 'edge' });
      const hit = svgEl('path', { class: 'edge-hit' });
      const title = svgEl('title');
      const g = svgEl('g');
      g.append(line, hit, title);
      const choose = () => select({ type: 'edge', key: edge.key });
      hit.addEventListener('click', choose);
      line.addEventListener('click', choose);
      rec = { g, line, hit, title, item: edge.item, category: edge.category, exiting: false, d: '' };
      if (animate) g.classList.add('enter');
      edgeLayer.append(g);
      state.edges.set(edge.key, rec);
    }
    if (rec.exiting) {
      rec.exiting = false;
      rec.g.classList.remove('exit');
    }
    rec.weight = edge.weight;
    rec.line.style.strokeWidth = String(1.5 + Math.min(Math.max(edge.weight ?? 1, 0), 5) * 0.8);
    rec.title.textContent = `${edge.item} → ${edge.category}${edge.weight === undefined ? '' : `  (weight ${edge.weight})`}`;
    if (animate && flash.has(edge.key)) pulse(rec.line);
  }
  for (const [key, rec] of state.edges) {
    if (!live.has(key) && !rec.exiting) retire(state.edges, key, rec);
  }
}

function retire(map, key, rec) {
  rec.exiting = true;
  rec.g.classList.remove('enter');
  rec.g.classList.add('exit');
  setTimeout(() => {
    if (rec.exiting) {
      rec.g.remove();
      map.delete(key);
    }
  }, reducedMotion ? 0 : 360);
}

function pulse(el) {
  if (reducedMotion) return;
  el.classList.remove('flash');
  void el.getBoundingClientRect(); // restart the animation if it is already running
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1150);
}

function place(rec) {
  rec.g.setAttribute('transform', `translate(${rec.x} ${rec.y})`);
}

function drawEdges() {
  for (const rec of state.edges.values()) {
    const from = state.nodes.get(nodeKey('item', rec.item));
    const to = state.nodes.get(nodeKey('category', rec.category));
    if (from === undefined || to === undefined) continue;
    const d = edgePath(from.x, from.y, to.x, to.y);
    if (d !== rec.d) {
      rec.d = d;
      rec.line.setAttribute('d', d);
      rec.hit.setAttribute('d', d);
    }
  }
}

/** Slides every node to its target position; edges follow each frame. */
function startTween() {
  cancelAnimationFrame(state.frame);
  const step = () => {
    let moving = false;
    for (const rec of state.nodes.values()) {
      const dx = rec.tx - rec.x;
      const dy = rec.ty - rec.y;
      if (reducedMotion || Math.hypot(dx, dy) < 0.4) {
        rec.x = rec.tx;
        rec.y = rec.ty;
      } else {
        rec.x += dx * 0.22;
        rec.y += dy * 0.22;
        moving = true;
      }
      place(rec);
    }
    drawEdges();
    if (moving) state.frame = requestAnimationFrame(step);
  };
  step();
}

function renderCounts(value) {
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const { itemCount, categoryCount, edgeCount } = value?.info ?? {};
  $('counts').textContent = value === null ? '' : `${count(itemCount, 'item', 'items')} · ${count(categoryCount, 'category', 'categories')} · ${count(edgeCount, 'link', 'links')}`;
}

function renderLists(graph) {
  const fill = (id, list) => $(id).replaceChildren(...list.map((n) => html('option', { value: n.id })));
  fill('items-list', graph.items);
  fill('categories-list', graph.categories);
}

// ---------- selection and highlight ----------

function highlight(key) {
  svg.classList.toggle('dim', key !== null);
  for (const rec of state.nodes.values()) rec.g.classList.remove('hot');
  for (const rec of state.edges.values()) rec.line.classList.remove('hot');
  if (key === null) return;
  state.nodes.get(key)?.g.classList.add('hot');
  for (const rec of state.edges.values()) {
    const touches = key === nodeKey('item', rec.item) || key === nodeKey('category', rec.category);
    if (!touches) continue;
    rec.line.classList.add('hot');
    state.nodes.get(nodeKey('item', rec.item))?.g.classList.add('hot');
    state.nodes.get(nodeKey('category', rec.category))?.g.classList.add('hot');
  }
}

function select(selection) {
  state.selection = selection;
  for (const [key, rec] of state.nodes) rec.g.classList.toggle('selected', selection?.type === 'node' && selection.key === key);
  renderSelection();
}

function renderSelection() {
  const box = $('selection');
  const sel = state.selection;
  const graph = state.data;
  if (sel === null || graph === null) return box.replaceChildren('Nothing selected.');
  if (sel.type === 'node') {
    const [partition, ...rest] = sel.key.split(':');
    const id = rest.join(':');
    const node = (partition === 'item' ? graph.items : graph.categories).find((n) => n.id === id);
    if (node === undefined) {
      state.selection = null;
      return box.replaceChildren('Nothing selected.');
    }
    const links = graph.edges.filter((e) => (partition === 'item' ? e.item === id : e.category === id));
    box.replaceChildren(
      html('div', {}, html('strong', {}, id), ` (${partition})`),
      html('pre', {}, node.data === undefined ? 'no data' : JSON.stringify(node.data, null, 2)),
      html('div', { class: 'hint' }, `${links.length} link${links.length === 1 ? '' : 's'}`),
      ...links.map((e) => html('div', { class: 'row' }, html('span', {}, partition === 'item' ? `→ ${e.category}` : `← ${e.item}`), html('button', { class: 'ghost', onclick: () => unlinkPair(e.item, e.category) }, 'Unlink'))),
      html('button', { class: 'danger', onclick: () => deleteNode(partition, id) }, 'Delete node'),
    );
    return;
  }
  const [item, category] = sel.key.split('\u0000');
  const edge = graph.edges.find((e) => e.item === item && e.category === category);
  if (edge === undefined) {
    state.selection = null;
    return box.replaceChildren('Nothing selected.');
  }
  box.replaceChildren(
    html('div', {}, html('strong', {}, item), ' → ', html('strong', {}, category)),
    html('pre', {}, JSON.stringify({ weight: edge.weight, data: edge.data }, null, 2)),
    html('button', { class: 'danger', onclick: () => unlinkPair(item, category) }, 'Unlink'),
  );
}

// ---------- actions ----------

function mutation(ops) {
  return { version: 1, kind: 'mutation', graphId: state.graphId, ops };
}

/** Sends a mutation, logs it, redraws, and then reports a failure (the redraw would otherwise overwrite it). */
async function submit(label, request) {
  const result = await api('/api/write', 'POST', request);
  log(label, request, result);
  await refresh({ animate: true });
  if (!result.ok) setChange(`${result.error?.code}: ${result.error?.message ?? ''}`.slice(0, 160), true);
  return result;
}

async function send(label, request) {
  if (request.graphId === null || request.graphId === undefined) {
    setChange('Create or select a graph first.', true);
    return { ok: false };
  }
  return submit(label, request);
}

const unlinkPair = (item, category) => send(`unlink ${item} → ${category}`, mutation([{ op: 'unlink', item, category }]));
const deleteNode = (partition, id) => send(`delete ${partition} ${id}`, mutation([{ op: 'deleteNode', partition, id }]));

async function loadGraphs() {
  const list = await api('/api/graphs');
  const ids = list.ok ? list.value.items : [];
  const select = $('graph-select');
  select.replaceChildren(...ids.map((id) => html('option', { value: id }, id)));
  if (state.graphId !== null && !ids.includes(state.graphId)) state.graphId = null;
  if (state.graphId === null && ids.length > 0) state.graphId = ids[0];
  if (state.graphId !== null) select.value = state.graphId;
  return ids;
}

async function refresh({ animate = true } = {}) {
  await loadGraphs();
  if (state.graphId === null) return render(null, { animate: false });
  const result = await api(`/api/graphs/${encodeURIComponent(state.graphId)}`);
  if (!result.ok) return render(null, { animate: false });
  render(result.value, { animate });
}

async function switchGraph(graphId) {
  state.graphId = graphId;
  state.data = null;
  state.selection = null;
  state.order = { item: [], category: [] };
  for (const rec of [...state.nodes.values(), ...state.edges.values()]) rec.g.remove();
  state.nodes.clear();
  state.edges.clear();
  highlight(null);
  renderSelection();
  setChange('');
  if (!state.rawDirty) $('raw').value = sampleRaw();
  await refresh({ animate: false });
}

function sampleRaw() {
  return JSON.stringify(
    { version: 1, kind: 'mutation', graphId: state.graphId ?? 'demo', ops: [{ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Hello' } }, { op: 'upsertNode', partition: 'category', id: 'ideas' }, { op: 'link', item: 'note-1', category: 'ideas', weight: 0.8 }] },
    null,
    2,
  );
}

function parseJsonField(text, what) {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
    return { ok: true, value };
  } catch (error) {
    setChange(`${what}: ${error.message}`, true);
    return { ok: false };
  }
}

// ---------- scenarios ----------

function scenarioStatus(text) {
  $('scenario-status').textContent = text;
}

function loadScenario(id) {
  stopScenario();
  state.scenario.def = scenarios.find((s) => s.id === id) ?? scenarios[0];
  state.scenario.index = 0;
  $('scenario-summary').textContent = state.scenario.def.summary;
  scenarioStatus(`${state.scenario.def.steps.length} steps. Press Play or Step.`);
  $('play').textContent = 'Play';
}

function stopScenario() {
  clearTimeout(state.scenario.timer);
  state.scenario.timer = null;
  $('play').textContent = 'Play';
}

async function startScenarioGraph() {
  const { graphId } = state.scenario.def;
  await api(`/api/graphs/${encodeURIComponent(graphId)}`, 'DELETE');
  const created = await api('/api/graphs', 'POST', { graphId });
  log(`new graph ${graphId} for the scenario`, { graphId }, created);
  await switchGraph(graphId);
}

async function runStep() {
  const { def } = state.scenario;
  if (state.scenario.index >= def.steps.length) return false;
  if (state.scenario.index === 0) await startScenarioGraph();
  const step = def.steps[state.scenario.index];
  const result = await send(`${def.title}: ${step.label}`, { version: 1, kind: 'mutation', graphId: def.graphId, ops: step.ops });
  state.scenario.index += 1;
  const n = def.steps.length;
  const note = step.expectFailure ? (result.ok ? ' (expected a failure, but it succeeded)' : ' (rejected as intended, the graph is unchanged)') : '';
  scenarioStatus(`Step ${state.scenario.index}/${n}: ${step.label}${note}`);
  if (state.scenario.index >= n) {
    stopScenario();
    scenarioStatus(`Finished (${n}/${n}): ${step.label}${note}. Press Restart to replay.`);
  }
  return state.scenario.index < n;
}

async function play() {
  if (state.scenario.timer !== null) return stopScenario();
  if (state.scenario.index >= state.scenario.def.steps.length) state.scenario.index = 0;
  $('play').textContent = 'Pause';
  const tick = async () => {
    const more = await runStep();
    if (more && state.scenario.timer !== null) {
      state.scenario.timer = setTimeout(tick, Math.max(100, Number($('delay').value) || 900));
    } else {
      stopScenario();
    }
  };
  state.scenario.timer = setTimeout(() => {}, 0);
  tick();
}

// ---------- wiring ----------

$('graph-select').addEventListener('change', (event) => switchGraph(event.target.value));

$('form-graph').addEventListener('submit', async (event) => {
  event.preventDefault();
  const graphId = $('new-graph').value.trim();
  const result = await api('/api/graphs', 'POST', { graphId });
  log(`create graph ${graphId}`, { graphId }, result);
  if (!result.ok) setChange(`${result.error?.code}: ${result.error?.message ?? ''}`.slice(0, 160), true);
  if (result.ok) {
    $('new-graph').value = '';
    await switchGraph(graphId);
  }
});

$('drop-graph').addEventListener('click', async () => {
  if (state.graphId === null) return;
  const dropped = state.graphId;
  const result = await api(`/api/graphs/${encodeURIComponent(dropped)}`, 'DELETE');
  log(`drop graph ${dropped}`, undefined, result);
  const ids = await loadGraphs();
  await switchGraph(ids[0] ?? null);
});

$('form-node').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = parseJsonField($('node-data').value, 'node data');
  if (!data.ok) return;
  const op = { op: 'upsertNode', partition: $('node-partition').value, id: $('node-id').value.trim(), mode: $('node-mode').value, ...(data.value === undefined ? {} : { data: data.value }) };
  const result = await send(`upsert ${op.partition} ${op.id}`, mutation([op]));
  if (result.ok) $('node-id').value = '';
});

$('form-link').addEventListener('submit', async (event) => {
  event.preventDefault();
  const weight = $('link-weight').value;
  const op = { op: 'link', item: $('link-item').value.trim(), category: $('link-category').value.trim(), ensureNodes: $('link-ensure').checked, ...(weight === '' ? {} : { weight: Number(weight) }) };
  await send(`link ${op.item} → ${op.category}`, mutation([op]));
});

$('unlink').addEventListener('click', () => unlinkPair($('link-item').value.trim(), $('link-category').value.trim()));

$('form-delete').addEventListener('submit', async (event) => {
  event.preventDefault();
  await deleteNode($('delete-partition').value, $('delete-id').value.trim());
  $('delete-id').value = '';
});

$('raw').addEventListener('input', () => {
  state.rawDirty = true;
});

$('send-raw').addEventListener('click', async () => {
  let request;
  try {
    request = JSON.parse($('raw').value);
  } catch (error) {
    return setChange(`raw mutation: ${error.message}`, true);
  }
  await submit('raw mutation', request);
});

for (const entry of rejected) {
  $('rejected').append(
    html('button', {
      class: 'ghost',
      onclick: async () => {
        await submit(`try: ${entry.label}`, entry.build(state.graphId ?? 'demo'));
      },
    }, entry.label),
  );
}

$('scenario').replaceChildren(...scenarios.map((s) => html('option', { value: s.id }, s.title)));
$('scenario').addEventListener('change', (event) => loadScenario(event.target.value));
$('play').addEventListener('click', play);
$('step').addEventListener('click', () => {
  stopScenario();
  return runStep();
});
$('restart').addEventListener('click', () => {
  loadScenario(state.scenario.def.id);
});

let autoTimer = null;
$('auto-refresh').addEventListener('change', (event) => {
  clearInterval(autoTimer);
  autoTimer = event.target.checked ? setInterval(() => refresh({ animate: true }), 1000) : null;
});

let resetArmed = false;
$('reset').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!resetArmed) {
    resetArmed = true;
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
      resetArmed = false;
      button.textContent = 'Reset everything';
    }, 3000);
    return;
  }
  resetArmed = false;
  button.textContent = 'Reset everything';
  stopScenario();
  log('reset everything', undefined, await api('/api/reset', 'POST', {}));
  await switchGraph(null);
  await ensureDemoGraph();
});

async function ensureDemoGraph() {
  const ids = await loadGraphs();
  if (ids.length === 0) {
    const result = await api('/api/graphs', 'POST', { graphId: 'demo' });
    log('create graph demo (first run)', { graphId: 'demo' }, result);
  }
  const all = await loadGraphs();
  await switchGraph(all[0] ?? null);
}

loadScenario(scenarios[0].id);
await ensureDemoGraph();
