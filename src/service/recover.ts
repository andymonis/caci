import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPasswordHasher, parsePassword, parseUsername } from '../users/index.js';
import { createSqliteSessionStore, createSqliteUserStore } from '../users/sqlite/index.js';
import { parseServiceConfig } from './config.js';

export interface RecoverIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Gives the new password. Called only after the account has been found, so a typo in the name costs no typing. Never from an argument. */
  readonly readPassword: () => Promise<string>;
}

export const USAGE = 'Usage: npm run users -- recover-admin <username>   (the new password is read from standard input)';

/**
 * Sets a new password for an admin account, for when nobody can sign in as an admin: it works on the
 * files in `CACI_DATA_DIR` directly, so being able to run it is the proof of access. It ends all of
 * that account's sessions and changes nothing else. It never prints the password, and a
 * username that does not exist, or is not an admin, changes nothing.
 *
 * @returns 0 done, 1 could not, 2 wrong arguments
 */
export async function recoverAdmin(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: RecoverIo): Promise<0 | 1 | 2> {
  if (args.length !== 1 || args[0] === undefined) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const config = parseServiceConfig(env);
  if (!config.ok) {
    io.stderr(`The settings are not valid:\n${config.error.map((e) => `  ${e.variable}: ${e.message}`).join('\n')}\n`);
    return 2;
  }
  const username = parseUsername(args[0]);
  const file = join(resolve(config.value.dataDir), 'users.db');
  if (!existsSync(file)) {
    io.stderr(`There is no user database at ${file}. Check CACI_DATA_DIR.\n`);
    return 1;
  }

  let users: ReturnType<typeof createSqliteUserStore> | undefined;
  let sessions: ReturnType<typeof createSqliteSessionStore> | undefined;
  try {
    users = createSqliteUserStore({ path: file });
    sessions = createSqliteSessionStore({ path: file });
    const user = username.ok ? await users.getByUsername(username.value) : undefined;
    if (user === undefined || user.role !== 'admin') {
      io.stderr('There is no admin account with that username. Nothing was changed.\n'); // the same words for a missing name and an ordinary user
      return 1;
    }
    const fresh = parsePassword(await io.readPassword(), { username: user.username });
    if (!fresh.ok) {
      io.stderr(`The new password was refused: ${fresh.error.message}. Nothing was changed.\n`);
      return 1;
    }
    const updated = await users.update(user.id, { passwordHash: await createPasswordHasher().hash(fresh.value), updatedAt: Date.now() });
    if (!updated.ok) {
      io.stderr('The password could not be saved. Nothing was changed.\n');
      return 1;
    }
    const ended = await sessions.revokeAllFor(user.id);
    io.stdout(`The password for admin ${user.username} has been reset; ${ended} session${ended === 1 ? ' was' : 's were'} ended. Nobody else was affected.\n`);
    return 0;
  } catch (cause) {
    io.stderr(`Could not reset the password: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  } finally {
    users?.close();
    sessions?.close();
  }
}
