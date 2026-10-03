import { describe, expect, it } from 'vitest';
import { err, ok } from '../../graph_store/index.js';
import { llmError, type ModelClient, type ModelRequest } from '../index.js';
import { createScriptedModelClient, modelClientCases, runModelClientConformance, scriptFor, type ClientScenario } from './index.js';

const scripted = (scenario: ClientScenario): ModelClient => createScriptedModelClient(scriptFor(scenario));

// The scripted client is held to the same contract as every real client.
runModelClientConformance((scenario) => scripted(scenario), { describe, it });

/** A client that behaves, except for one defect. */
type Defect = (inner: ModelClient, scenario: ClientScenario) => ModelClient;

const defects: Array<[string, Defect]> = [
  ['throws instead of returning an error when the provider fails', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      if (!reply.ok && reply.error.code === 'MODEL_ERROR') throw new Error('provider failed');
      return reply;
    },
  })],
  ['ignores a request for JSON and returns the reply as text', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return reply.ok && reply.value.output.kind === 'json' ? ok({ ...reply.value, output: { kind: 'text', text: JSON.stringify(reply.value.output.value) } }) : reply;
    },
  })],
  ['does not turn prose into BAD_OUTPUT: returns it as text', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'BAD_OUTPUT' ? ok({ model: r.model, output: { kind: 'text', text: 'prose' }, usage: { inputTokens: 1, outputTokens: 1 } }) : reply;
    },
  })],
  ['reports a refusal as MODEL_ERROR', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'REFUSED' ? err(llmError('MODEL_ERROR', 'declined')) : reply;
    },
  })],
  ['reports a rate limit as not retryable', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'RATE_LIMITED' ? err(llmError('RATE_LIMITED', 'slow down', { retryable: false })) : reply;
    },
  })],
  ['loses how long a rate limit asked callers to wait', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'RATE_LIMITED' ? err(llmError('RATE_LIMITED', 'slow down')) : reply;
    },
  })],
  ['reports a provider server fault as not retryable', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'MODEL_ERROR' && reply.error.retryable ? err(llmError('MODEL_ERROR', 'server fault')) : reply;
    },
  })],
  ['reports an unknown model as MODEL_ERROR instead of CONFIG', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'CONFIG' && /does not know/.test(reply.error.message) ? err(llmError('MODEL_ERROR', 'no such model')) : reply;
    },
  })],
  ['never gives up on a provider that does not answer (ignores its time limit)', (inner, scenario) => ({
    complete: (r) => (scenario.kind === 'hangs' ? new Promise(() => undefined) : inner.complete(r)),
  })],
  ['reports a time-out as MODEL_ERROR', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'TIMEOUT' ? err(llmError('MODEL_ERROR', 'timed out')) : reply;
    },
  })],
  ['ignores the cancellation signal', (inner) => ({
    complete: (r) => {
      const withoutSignal: Record<string, unknown> = { ...r };
      delete withoutSignal.signal;
      return inner.complete(withoutSignal as unknown as ModelRequest);
    },
  })],
  ['reports a cancellation as a time-out', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return !reply.ok && reply.error.code === 'CANCELLED' ? err(llmError('TIMEOUT', 'timed out')) : reply;
    },
  })],
  ['sends anything, never checking the request', (inner) => ({
    complete: async (r) => (r !== null && typeof r === 'object' && typeof r.model === 'string' && r.model.length > 0 && Array.isArray(r.messages) && r.messages.length > 0 && r.timeoutMs > 0 && r.maxOutputTokens > 0 && !('temprature' in r) ? inner.complete(r) : ok({ model: 'm', output: { kind: 'text', text: 'sent anyway' }, usage: { inputTokens: 0, outputTokens: 0 } })),
  })],
  ['changes the request it is given', (inner) => ({
    complete: async (r) => {
      (r.messages as unknown as Array<unknown>).push({ role: 'user', content: 'added by the client' });
      return inner.complete(r);
    },
  })],
  ['reports negative token usage', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return reply.ok ? ok({ ...reply.value, usage: { inputTokens: -5, outputTokens: reply.value.usage.outputTokens } }) : reply;
    },
  })],
  ['overwrites the model the provider reported with the one asked for', (inner) => ({
    complete: async (r) => {
      const reply = await inner.complete(r);
      return reply.ok ? ok({ ...reply.value, model: r.model }) : reply;
    },
  })],
  ['can only handle one call at a time', (inner) => {
    let busy = false;
    return {
      complete: async (r) => {
        if (busy) return err(llmError('MODEL_ERROR', 'busy'));
        busy = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await inner.complete(r);
        } finally {
          busy = false;
        }
      },
    };
  }],
];

async function failedCases(defect: Defect): Promise<string[]> {
  const failed: string[] = [];
  for (const testCase of modelClientCases()) {
    try {
      await testCase.run(async (scenario) => defect(scripted(scenario), scenario));
    } catch {
      failed.push(testCase.name);
    }
  }
  return failed;
}

describe('the contract suite catches clients that break the contract', () => {
  it.each(defects)('%s', async (_name, defect) => {
    expect((await failedCases(defect)).length).toBeGreaterThan(0);
  }, 60_000);

  it('passes a client with no defect (so every failure above is real)', async () => {
    expect(await failedCases((inner) => inner)).toEqual([]);
  });

  it('has enough cases to mean something', () => {
    expect(modelClientCases().length).toBeGreaterThanOrEqual(19);
    expect(new Set(modelClientCases().map((c) => c.name)).size).toBe(modelClientCases().length);
  });
});
