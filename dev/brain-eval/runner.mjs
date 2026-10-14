// Runs the chosen arms over the chosen scenarios, one scenario at a time.
import { runBrainArm } from './brain-arm.mjs';
import { padScenario } from './pad.mjs';
import { runReplayArm } from './replay-arm.mjs';

/** The number of model calls a run makes at least (a repair or a refused filing can add or remove a few). */
export function plannedCalls({ scenarios, arms, answerWith, repeat, pads = [0] }) {
  const notes = scenarios.reduce((n, s) => n + s.notes.length, 0);
  const questions = scenarios.reduce((n, s) => n + s.questions.length, 0);
  const answers = questions * answerWith.length * repeat * pads.length;
  const filing = arms.includes('brain') ? pads.reduce((n, pad) => n + notes + (pad > 0 ? pad * scenarios.length : 0), 0) : 0;
  const brain = arms.includes('brain') ? answers : 0;
  const replay = arms.includes('replay') ? answers : 0;
  return { filing, brain, replay, total: filing + brain + replay };
}

export async function runEval({ lib, controls, scenarios, arms, fileWith, answerWith, repeat, order, windowTokens, makeClient, signal, onResult, pads = [0], seed = 1 }) {
  const results = [];
  const filing = [];
  const stopped = () => signal?.aborted === true;
  for (const pad of pads) {
    const collect = (r) => {
      results.push({ ...r, pad });
      onResult?.(results.at(-1), results.length);
    };
    for (const original of scenarios) {
      const scenario = padScenario(original, pad, seed);
      if (arms.includes('brain')) {
        const r = await runBrainArm({ lib, controls, scenario, fileWith, answerWith, makeClient, repeat, signal, onResult: collect });
        filing.push(...r.filing.map((f) => ({ scenario: scenario.id, pad, ...f })));
      }
      if (arms.includes('replay')) await runReplayArm({ lib, controls, scenario, answerWith, makeClient, repeat, order, windowTokens, signal, onResult: collect });
    }
  }
  return { results, filing, aborted: stopped() };
}
