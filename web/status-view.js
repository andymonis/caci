// The words on the status screen (R-011). Pure: no page access, so every sentence can be tested exactly.
// `status-page.js` only puts them on the page. Everything shown is text; the service's words are shown as given.

import { formatTime, withWait } from './capture-view.js';
import { STATUS_MAX } from './notes-client.js';

export { withWait };

export const STATUS_MODE_WORDS = Object.freeze({
  demo: 'Answered by the free demo model: nothing leaves this machine.',
  anthropic: "Answered by Anthropic's model: your request and the notes you can read, yours and your circles', are sent to Anthropic and are not anonymised.",
});
export const STATUS_MODE_UNKNOWN = 'Could not tell which model answers.';
export const STATUS_MODE_LOADING = 'Checking which model answers…';
export const STATUS_CONTEXT = 'Your status uses everything you can read: your own notes and the circles you are in. It is sent with your request.';
export const STATUS_NOTHING = 'Nothing relevant was found in what you can read.';
export const STATUS_LEFT_OUT = 'Some notes were left out because there were too many; the newest were used.';
export const STATUS_SUGGESTIONS = Object.freeze(['Give me a morning status check', 'I am heading into town', 'What is happening this week?']);
export const STATUS_NOT_SAVED = 'This is not saved anywhere. It is gone when you leave this screen.';

/** The notice about which model answers, from the mode state of the status session. */
export function statusModeNotice(mode) {
  if (mode && mode.status === 'known' && Object.hasOwn(STATUS_MODE_WORDS, mode.value)) return STATUS_MODE_WORDS[mode.value];
  if (mode && mode.status === 'loading') return STATUS_MODE_LOADING;
  return STATUS_MODE_UNKNOWN;
}

/** `n / 500` under the box. */
export const requestCount = (length) => `${Math.max(0, Number.isSafeInteger(length) ? length : 0).toLocaleString('en-GB')} / ${STATUS_MAX.toLocaleString('en-GB')}`;

/** Where a point came from, by name, each place once: `From: "Parent care", your own notes`. */
export function sourcesText(sources) {
  if (!Array.isArray(sources)) return '';
  const names = [];
  for (const s of sources) {
    const name = s && s.kind === 'personal' ? 'your own notes' : s && s.kind === 'circle' ? `"${typeof s.circleName === 'string' && s.circleName !== '' ? s.circleName : 'a circle'}"` : '';
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names.length === 0 ? '' : `From: ${names.join(', ')}`;
}

/** One point as one line: the text and, in brackets, where it came from. */
export function pointText(point) {
  const from = sourcesText(point.sources);
  return from === '' ? point.text : `${point.text} (${from})`;
}

const notes = (n) => (n === 1 ? '1 note' : `${n.toLocaleString('en-GB')} notes`);

/** The small print under an answer: how many notes it was based on, and when it was made. */
export function metaLine(answer) {
  const when = formatTime(answer.generatedAt);
  return `Based on ${notes(answer.entriesUsed)}.${when === '' ? '' : ` Made ${when}.`}`;
}
