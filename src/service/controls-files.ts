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
