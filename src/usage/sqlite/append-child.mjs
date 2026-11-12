// Test support (not published): appends N records one batch at a time to the usage store in the file, as a second process.
import process from 'node:process';
import { createSqliteUsageStore } from './sqlite-store.ts';

const [path, name, count] = process.argv.slice(2);
const store = createSqliteUsageStore({ path, busyTimeoutMs: 20000 });
for (let i = 0; i < Number(count); i++) {
  const r = await store.append([{ at: 10_000 + i, userId: 'u0000000000000001', capability: 'status', scope: { kind: 'personal' }, model: `model-${name}`, attempt: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, result: 'ok', latencyMs: 5 }]);
  if (!r.ok) {
    process.stderr.write(`${JSON.stringify(r.error)}\n`);
    process.exit(1);
  }
}
store.close();
