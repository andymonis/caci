import { execFile } from 'node:child_process';

// Runs one program and tells what happened. Arguments are an array and never go through a shell, so nothing in an
// argument (a ref, a path) can be read as a command. Every run has a time limit; the program's output is captured and
// only its tail is kept.

const TAIL = 2000;
const tail = (text) => (text.length > TAIL ? `…${text.slice(-TAIL)}` : text);

/**
 * @returns {(file: string, args: readonly string[], options?: { cwd?: string, env?: Record<string, string>, timeoutMs?: number }) => Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, detail: string }>}
 */
export function createRunner({ execFileFn = execFile } = {}) {
  return (file, args, { cwd, env, timeoutMs = 300_000 } = {}) =>
    new Promise((resolve) => {
      try {
        execFileFn(file, [...args], { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true }, (error, stdout, stderr) => {
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');
          if (error === null || error === undefined) return resolve({ ok: true, code: 0, stdout: out, stderr: err, detail: tail(out.trim()) });
          const code = typeof error.code === 'number' ? error.code : null;
          const why = error.killed === true ? `${file} was stopped after ${Math.round(timeoutMs / 1000)} s` : code === null ? `${file} could not be run (${error.code ?? error.message})` : `${file} exited with ${code}`;
          resolve({ ok: false, code, stdout: out, stderr: err, detail: `${why}${err.trim() === '' ? '' : `: ${tail(err.trim())}`}` });
        });
      } catch (cause) {
        resolve({ ok: false, code: null, stdout: '', stderr: '', detail: `${file} could not be run (${cause instanceof Error ? cause.message : String(cause)})` });
      }
    });
}
