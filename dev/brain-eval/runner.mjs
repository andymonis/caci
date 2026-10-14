// Runs the chosen arms over the chosen scenarios, one scenario at a time.
import { runBrainArm } from './brain-arm.mjs';
import { runReplayArm } from './replay-arm.mjs';

/** The number of model calls a run makes at least (a repair or a refused filing can add or remove a few). */
export function plannedCalls({ scenarios, arms, answerWith, repeat }) {
  const notes = scenarios.reduce((n, s) => n + s.notes.length, 0);
  const questions = scenarios.reduce((n, s) => n + s.questions.length, 0);
  const answers = questions * answerWith.length * repeat;
  return {
    filing: arms.includes('brain') ? notes : 0,
    brain: arms.includes('brain') ? answers : 0,
    replay: arms.includes('replay') ? answers : 0,
    total: (arms.includes('brain') ? notes + answers : 0) + (arms.includes('replay') ? answers : 0),
  };
}

export async function runEval({ lib, controls, scenarios, arms, fileWith, answerWith, repeat, order, windowTokens, makeClient, signal, onResult }) {
  const results = [];
  const filing = [];
  const collect = (r) => {
    results.push(r);
    onResult?.(r, results.length);
  };
  const stopped = () => signal?.aborted === true;
  for (const scenario of scenarios) {
    if (arms.includes('brain')) {
      const r = await runBrainArm({ lib, controls, scenario, fileWith, answerWith, makeClient, repeat, signal, onResult: collect });
      filing.push(...r.filing.map((f) => ({ scenario: scenario.id, ...f })));
    }
    if (arms.includes('replay')) await runReplayArm({ lib, controls, scenario, answerWith, makeClient, repeat, order, windowTokens, signal, onResult: collect });
  }
  return { results, filing, aborted: stopped() };
}
