import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '../graph_store/index.js';
import { CONTROL_FILES, parseControls, type Controls } from '../llm/index.js';

// Reading the controls folder (R-012). The LLM component's controls model is pure and is given the text of the
// six files; reading them is the service's and the dev tools' job. Exactly the six names are read, each through a
// real directory and an ordinary file, and nothing else in the folder is ever opened.

const MAX_BYTES = 20_000;

/** The `controls/` folder beside the code, found the same way from source and from a build. */
export function defaultControlsDir(): string {
  return fileURLToPath(new URL('../../controls/', import.meta.url));
}

/**
 * Reads the six controls files from `dir` and checks them. Every problem is returned at once, each naming the
 * file; a missing folder is one problem. Never throws.
 */
export function loadControlsFolder(dir: string): Result<Controls, readonly string[]> {
  try {
    let top;
    try {
      top = lstatSync(dir);
    } catch {
      return err([`the controls folder ${dir} does not exist`]);
    }
    if (!top.isDirectory()) return err([`the controls folder ${dir} is not a folder`]);

    const problems: string[] = [];
    const files: Record<string, string> = {};
    for (const name of CONTROL_FILES) {
      const folder = name.split('/')[0] as string;
      let folderStat;
      try {
        folderStat = lstatSync(join(dir, folder));
      } catch {
        problems.push(`${name}: is missing (there is no folder "${folder}" in ${dir})`);
        continue;
      }
      if (!folderStat.isDirectory()) {
        problems.push(`${name}: "${folder}" in ${dir} is not an ordinary folder`);
        continue;
      }
      const path = join(dir, ...name.split('/'));
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        problems.push(`${name}: is missing in ${dir}`);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`${name}: is not an ordinary file`);
        continue;
      }
      if (stat.size > MAX_BYTES) {
        problems.push(`${name}: ${stat.size} bytes, over the limit of ${MAX_BYTES}`);
        continue;
      }
      try {
        files[name] = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
      } catch {
        problems.push(`${name}: is not valid UTF-8 text`);
      }
    }
    if (problems.length > 0) return err(problems);
    const parsed = parseControls(files);
    return parsed.ok ? ok(parsed.value) : err(parsed.error);
  } catch {
    return err([`the controls folder ${dir} could not be read`]);
  }
}

/** The longest check text: the same as the longest status request the API accepts (R-016 D21, R-018 D10). */
export const MAX_PULSE_CHARS = 500;

/** The three server-held check texts (R-018 D10): the file of each and the name the API and the pages use. */
export const CHECK_FILES = Object.freeze({ pulse: 'pulse.txt', 'coming-up': 'coming-up.txt', 'long-range': 'long-range.txt' } as const);
export type CheckName = keyof typeof CHECK_FILES;
export const CHECK_NAMES = Object.freeze(Object.keys(CHECK_FILES) as CheckName[]);

/**
 * Reads one check text from the controls folder (R-016 D21): the predefined request a check button sends. One ordinary
 * file, strict UTF-8, trimmed, one paragraph of plain text, 1 to 500 characters. Every problem names the file; never throws.
 */
function loadCheckText(dir: string, file: string): Result<string, readonly string[]> {
  const path = join(dir, file);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return err([`${file}: is missing in ${dir}`]);
  }
  if (!stat.isFile()) return err([`${file}: is not an ordinary file`]);
  if (stat.size > 4 * MAX_PULSE_CHARS + 16) return err([`${file}: ${stat.size} bytes, too long (the text may be at most ${MAX_PULSE_CHARS} characters)`]);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).trim();
  } catch {
    return err([`${file}: is not valid UTF-8 text`]);
  }
  if (text === '') return err([`${file}: is empty`]);
  if ([...text].length > MAX_PULSE_CHARS) return err([`${file}: ${[...text].length} characters, over the limit of ${MAX_PULSE_CHARS}`]);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(text)) return err([`${file}: must be one paragraph of plain text (no line breaks or control characters)`]);
  return ok(text);
}

/** Reads `pulse.txt` (the week check): see `loadCheckText`. */
export function loadPulseText(dir: string): Result<string, readonly string[]> {
  return loadCheckText(dir, CHECK_FILES.pulse);
}

/** The three check texts, by name. */
export type CheckTexts = Readonly<Record<CheckName, string>>;

/**
 * Reads `pulse.txt`, `coming-up.txt` and `long-range.txt` (R-018 D10). Every problem of every file is reported, each naming
 * its file; one bad file gives no texts. Never throws.
 */
export function loadCheckTexts(dir: string): Result<CheckTexts, readonly string[]> {
  const texts: Partial<Record<CheckName, string>> = {};
  const problems: string[] = [];
  for (const name of CHECK_NAMES) {
    const r = loadCheckText(dir, CHECK_FILES[name]);
    if (r.ok) texts[name] = r.value;
    else problems.push(...r.error);
  }
  return problems.length > 0 ? err(problems) : ok(Object.freeze({ ...texts }) as CheckTexts);
}
