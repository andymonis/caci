// Local development tool: a tiny HTTP server for trying the LLM component (the "LLM lab").
// It is not part of the library or the published package, and it only ever listens on loopback
// (the server and its safety checks come from ../shared/server-kit.mjs).
//
// The scripted model is the default. The real model is used only when the server found an API key
// in its environment at start-up AND the request says `network: true`. The key is held here and
// never sent to the browser.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDevelopment as assertLocal, createLoopbackServer, HttpError } from '../shared/server-kit.mjs';
import { defaultTimeoutMs, isScenario, SCENARIOS, scenarioNames, scenarioScript } from './scenarios.mjs';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
export const HISTORY_LIMIT = 50;
export const MAX_COMPARE_MODELS = 6;
export const MAX_NOTE_CHARS = 20_000;
export const MAX_CATEGORIES = 200;

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (message) => new HttpError(400, message);

/** Refuses to run anywhere that looks like a deployment. */
export function assertLocalDevelopment(env = process.env) {
  assertLocal('The LLM lab', env);
}

function checkFields(body, allowed, where) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw bad(`${where}: unknown field "${key}"`);
}

/** Checks what the lab itself needs; everything about the note and categories is left to `categorise`, which reports it as a result. */
function checkCommon(body, lib) {
  if (!isObject(body)) throw bad('send a JSON object');
  if (body.capability !== undefined && !lib.CAPABILITIES.includes(body.capability)) throw bad(`capability: must be one of ${lib.CAPABILITIES.join(', ')}`);
  if (typeof body.text !== 'string') throw bad('text: must be text');
  if (body.text.length > MAX_NOTE_CHARS) throw bad(`text: over the lab's limit of ${MAX_NOTE_CHARS} characters`);
  if (body.categories !== undefined && (!Array.isArray(body.categories) || body.categories.length > MAX_CATEGORIES)) throw bad(`categories: must be a list of at most ${MAX_CATEGORIES}`);
  if (body.scenario !== undefined && !isScenario(body.scenario)) throw bad(`scenario: must be one of ${scenarioNames().join(', ')}`);
  if (body.network !== undefined && typeof body.network !== 'boolean') throw bad('network: must be true or false');
  if (body.network === true && body.scenario !== undefined) throw bad('scenario: applies to the scripted model only, not to a real call');
  if (body.timeoutMs !== undefined && !(Number.isSafeInteger(body.timeoutMs) && body.timeoutMs >= 100 && body.timeoutMs <= 120_000)) throw bad('timeoutMs: must be a whole number from 100 to 120000');
}

const COMMON = ['capability', 'text', 'categories', 'scenario', 'network', 'timeoutMs', 'graphId', 'itemId'];

/**
 * @param lib the pieces to try, passed in so the tool runs against the build (`dist`) or the sources (tests):
 *            { createLlm, createScriptedModelClient, summarise, describeSummary, createAnthropicClient,
 *              CAPABILITIES, MODEL_TIERS, DEFAULT_TIERS, DEFAULT_ROUTES }
 * @param options.apiKey the API key found in the environment at start-up, if any (held here, never sent out)
 * @param options.now the clock in milliseconds (tests replace it)
 */
export function createApp(lib, options = {}) {
  const apiKey = typeof options.apiKey === 'string' && options.apiKey !== '' ? options.apiKey : undefined;
  const now = options.now ?? Date.now;
  const history = [];
  let counter = 0;

  /** Defence in depth: whatever is sent to the browser has the key removed, wherever it might have come from. */
  const scrub = (value) => (apiKey === undefined ? value : JSON.parse(JSON.stringify(value).split(apiKey).join('[redacted]')));

  const status = () => ({
    capabilities: [...lib.CAPABILITIES],
    tiers: Object.fromEntries(lib.MODEL_TIERS.map((tier) => [tier, lib.DEFAULT_TIERS[tier]])),
    routes: Object.fromEntries(lib.CAPABILITIES.map((c) => [c, lib.DEFAULT_ROUTES[c]])),
    scenarios: scenarioNames().map((name) => ({ name, description: SCENARIOS[name].description })),
    defaults: { scenario: 'good', graphId: 'lab', itemId: 'note-lab-1', timeoutMs: 30_000 },
    // whether a real call is possible; never the key, not even part of it
    network: { available: apiKey !== undefined },
    limits: { history: HISTORY_LIMIT, compareModels: MAX_COMPARE_MODELS, noteChars: MAX_NOTE_CHARS, categories: MAX_CATEGORIES },
    historyCount: history.length,
  });

  /** One run of `categorise`, recorded in the history. Anything that goes wrong inside is data in the record, not an HTTP error. */
  async function runOne(body, choice) {
    const network = body.network === true;
    const graphId = body.graphId ?? 'lab';
    const itemId = body.itemId ?? 'note-lab-1';
    const categories = body.categories ?? [];
    const scenario = network ? undefined : (body.scenario ?? 'good');
    const client = network
      ? options.realClient?.(apiKey) ?? lib.createAnthropicClient({ apiKey })
      : lib.createScriptedModelClient(scenarioScript(scenario, { itemId, categories }));
    const llm = lib.createLlm({ client, now });

    const trace = [];
    const started = now();
    const result = await llm.categorise(
      { text: body.text, graphId, itemId, categories },
      { ...choice, timeoutMs: body.timeoutMs ?? defaultTimeoutMs(scenario), trace: (event) => void trace.push(event) },
    );
    const latencyMs = now() - started;

    let outcome;
    if (result.ok) {
      const existing = { items: [], categories: Array.isArray(categories) ? categories.map((c) => c?.id).filter((id) => typeof id === 'string') : [] };
      const summary = lib.summarise(result.value.mutation, existing);
      outcome = {
        ok: true,
        proposal: {
          mutation: result.value.mutation,
          rationale: result.value.rationale ?? null,
          attempts: result.value.attempts,
          usage: result.value.usage,
          model: result.value.model,
          summary: summary.ok ? summary.value : null,
          text: summary.ok ? lib.describeSummary(summary.value) : `(no summary: ${summary.error.message})`,
        },
      };
    } else {
      outcome = { ok: false, error: result.error };
    }

    const asked = trace.find((e) => e.type === 'request');
    counter += 1;
    const record = scrub({
      id: `run-${counter}`,
      at: new Date(now()).toISOString(),
      capability: body.capability ?? 'categorise',
      mode: network ? 'network' : 'scripted',
      scenario: scenario ?? null,
      asked: { ...(choice.tier === undefined ? {} : { tier: choice.tier }), ...(choice.model === undefined ? {} : { model: choice.model }) },
      model: asked?.model ?? null,
      note: body.text,
      categories,
      trace,
      result: outcome,
      latencyMs,
      usage: result.ok ? result.value.usage : (trace.filter((e) => e.type === 'response').at(-1)?.usage ?? null),
    });
    history.unshift(record);
    history.length = Math.min(history.length, HISTORY_LIMIT);
    return record;
  }

  function checkNetwork(body) {
    if (body.network === true && apiKey === undefined) {
      throw new HttpError(409, 'a real call needs ANTHROPIC_API_KEY in the environment when the lab starts; none was found');
    }
  }

  async function api(req, res, url, { send, readJson }) {
    const parts = url.pathname.split('/').slice(2); // after /api
    const route = parts.join('/');

    if (route === 'status' && req.method === 'GET') return send(res, 200, { ok: true, value: status() });
    if (route === 'history' && req.method === 'GET') return send(res, 200, { ok: true, value: { items: history } });
    if (route === 'history' && req.method === 'DELETE') {
      history.length = 0;
      return send(res, 200, { ok: true, value: { items: [] } });
    }
    if (route === 'run' && req.method === 'POST') {
      const body = await readJson(req);
      checkCommon(body, lib);
      checkFields(body, [...COMMON, 'model', 'tier'], 'run');
      checkNetwork(body);
      const choice = { ...(body.tier === undefined ? {} : { tier: body.tier }), ...(body.model === undefined ? {} : { model: body.model }) };
      return send(res, 200, { ok: true, value: await runOne(body, choice) });
    }
    if (route === 'compare' && req.method === 'POST') {
      const body = await readJson(req);
      checkCommon(body, lib);
      checkFields(body, [...COMMON, 'models'], 'compare');
      if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > MAX_COMPARE_MODELS) throw bad(`models: must be a list of 1 to ${MAX_COMPARE_MODELS} choices like { "tier": "fast" } or { "model": "..." }`);
      for (const [i, m] of body.models.entries()) {
        if (!isObject(m)) throw bad(`models[${i}]: must be an object like { "tier": "fast" } or { "model": "..." }`);
        checkFields(m, ['tier', 'model'], `models[${i}]`);
      }
      checkNetwork(body);
      const runs = [];
      for (const choice of body.models) runs.push(await runOne(body, choice));
      return send(res, 200, { ok: true, value: { runs } });
    }
    throw new HttpError(404, 'no such API route');
  }

  return createLoopbackServer({ files: FILES, publicDir: PUBLIC_DIR, api });
}
