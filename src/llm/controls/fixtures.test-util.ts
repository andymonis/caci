import { CONTROL_FILES } from './controls.js';

/** Small valid contents for the six files, for tests of the controls model (the shipped files are in `controls/`). */
export function validFiles(): Record<string, string> {
  return {
    'categorise/system.txt': 'You file notes. The note id is "{{itemId}}". At most {{maxOps}} operations: {{allowedOps}}.\n',
    'categorise/frame.txt': 'Data below.\n\n{{contextBlock}}\n\n{{requestBlock}}\n\nReply with JSON.',
    'categorise/settings.json': JSON.stringify({
      maxOps: 25, maxTextChars: 8000, maxContextChars: 12000, maxDataBytes: 2304, maxIdLength: 128, maxOutputChars: 32000, maxRationaleChars: 500, maxReplaces: 5, maxFacts: 1, keyMaxChars: 80,
      titleMaxChars: 120, summaryMaxChars: 300, categoryNameMaxChars: 60,
      descriptions: { title: 'A short title.', summary: 'One line.', key: 'A short key.', name: 'A short name.' },
    }),
    'status/system.txt': 'Status. Entries 1 to {{entryCount}}. Now {{now}}. Headline {{maxHeadline}}, {{maxPoints}} points of {{maxPointChars}}, {{maxRefs}} refs.{{horizonSection}}',
    'status/frame.txt': 'Data below.\n\n{{entriesBlock}}\n\n{{requestBlock}}\n\nReply with JSON.',
    'status/settings.json': JSON.stringify({
      maxHeadline: 160, maxPoints: 5, maxPointChars: 240, maxRefs: 5, maxRequestChars: 500, maxEntries: 500, maxEntryChars: 1500, maxTotalChars: 30000, maxOutputChars: 8000,
      descriptions: { headline: 'One line.', pointText: 'One short line.', refs: 'Entry numbers.', nothing: 'True only when nothing is relevant.' },
      horizons: { rules: 'Only the window.', week: { maxPoints: 3, focus: 'A week.' }, month: { maxPoints: 4, focus: 'A month.' }, year: { maxPoints: 5, focus: 'A year.' } },
    }),
  };
}

export const FILE_NAMES: readonly string[] = CONTROL_FILES;
