// `npm run users -- recover-admin <username>`: sets a new password for an admin account when nobody can
// sign in as one. The password is read from standard input, never from an argument. See the README.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { RECOVER_USAGE, recoverAdmin } from '../dist/service/index.js';

/** Reads the whole of standard input (a pipe), dropping one trailing newline. */
async function fromPipe() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Asks on the terminal without showing what is typed, twice. */
function fromTerminal() {
  const ask = (label) =>
    new Promise((resolve, reject) => {
      process.stderr.write(label);
      let text = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const done = (fn) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        fn();
      };
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return done(() => resolve(text));
          if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
          else if (ch >= ' ') text += ch;
        }
      };
      process.stdin.on('data', onData);
    });
  return async () => {
    const first = await ask('New password: ');
    const second = await ask('Again: ');
    if (first !== second) throw new Error('the two entries differ');
    return first;
  };
}

const [command, ...rest] = process.argv.slice(2);
if (command !== 'recover-admin') {
  process.stderr.write(`${RECOVER_USAGE}\n`);
  process.exit(2);
}
const code = await recoverAdmin(rest, process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readPassword: process.stdin.isTTY ? fromTerminal() : fromPipe,
});
process.exit(code);
