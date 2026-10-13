import { err, ok, type Result } from '../../graph_store/index.js';
import { parseCategoriseSettings, parseStatusSettings, type CategoriseSettings, type StatusSettings } from './settings.js';
import { parseTemplate, type Template } from './template.js';

// The controls of the LLM component (R-012): the instructions, the words around the request and the context, and the
// limits, read from six text files. This module is pure: it is given the contents of the files and checks them; the
// service and the dev tools read the folder.

/** The six files, relative to the controls folder. Nothing else is ever read. */
export const CONTROL_FILES = Object.freeze([
  'categorise/system.txt',
  'categorise/frame.txt',
  'categorise/settings.json',
  'status/system.txt',
  'status/frame.txt',
  'status/settings.json',
] as const);

export type ControlFile = (typeof CONTROL_FILES)[number];

/** The slots each template may use, and which are required (R-012 D9). */
export const SLOT_RULES = Object.freeze({
  'categorise/system.txt': Object.freeze({ allowed: ['itemId', 'maxOps', 'allowedOps'], required: ['itemId'] }),
  'categorise/frame.txt': Object.freeze({ allowed: ['contextBlock', 'requestBlock'], once: ['contextBlock', 'requestBlock'] }),
  'status/system.txt': Object.freeze({ allowed: ['entryCount', 'now', 'maxHeadline', 'maxPoints', 'maxPointChars', 'maxRefs'] }),
  'status/frame.txt': Object.freeze({ allowed: ['entriesBlock', 'requestBlock'], once: ['entriesBlock', 'requestBlock'] }),
});

export interface CategoriseControls {
  readonly system: Template;
  readonly frame: Template;
  readonly settings: CategoriseSettings;
}

export interface StatusControls {
  readonly system: Template;
  readonly frame: Template;
  readonly settings: StatusSettings;
}

export interface Controls {
  readonly categorise: CategoriseControls;
  readonly status: StatusControls;
}

const quote = (token: string): string => JSON.stringify(token.length > 40 ? `${token.slice(0, 39)}…` : token);

/**
 * Checks the contents of the six files and returns the controls, or **every** problem at once, each naming its file.
 * `files` maps a file name (as in `CONTROL_FILES`) to its text. Never throws.
 */
export function parseControls(files: unknown): Result<Controls, readonly string[]> {
  try {
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return err(['the controls must be given as an object of file names to text']);
    const given = files as Record<string, unknown>;
    const problems: string[] = [];
    for (const name of Object.keys(given)) if (!(CONTROL_FILES as readonly string[]).includes(name)) problems.push(`${quote(name)}: not one of the six controls files`);
    for (const name of CONTROL_FILES) if (!Object.hasOwn(given, name)) problems.push(`${name}: is missing`);
    if (problems.length > 0) return err(problems);

    const template = (name: keyof typeof SLOT_RULES): Template | undefined => {
      const r = parseTemplate(name, given[name], SLOT_RULES[name]);
      if (!r.ok) {
        problems.push(...r.problems);
        return undefined;
      }
      return r.value;
    };
    const cSystem = template('categorise/system.txt');
    const cFrame = template('categorise/frame.txt');
    const sSystem = template('status/system.txt');
    const sFrame = template('status/frame.txt');
    const cSettings = parseCategoriseSettings('categorise/settings.json', given['categorise/settings.json']);
    const sSettings = parseStatusSettings('status/settings.json', given['status/settings.json']);
    if (!cSettings.ok) problems.push(...cSettings.problems);
    if (!sSettings.ok) problems.push(...sSettings.problems);
    if (problems.length > 0 || !cSystem || !cFrame || !sSystem || !sFrame || !cSettings.ok || !sSettings.ok) return err(problems);
    return ok(
      Object.freeze({
        categorise: Object.freeze({ system: cSystem, frame: cFrame, settings: cSettings.value }),
        status: Object.freeze({ system: sSystem, frame: sFrame, settings: sSettings.value }),
      }),
    );
  } catch {
    return err(['the controls could not be read']);
  }
}
