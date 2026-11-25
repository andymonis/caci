// Test support (not published): sets N resolutions one at a time in the resolution store in the file, as a second process.
import process from 'node:process';
import { createSqliteResolutionStore } from './sqlite-store.ts';

const [path, name, count] = process.argv.slice(2);
const store = createSqliteResolutionStore({ path, busyTimeoutMs: 20000 });
for (let i = 0; i < Number(count); i++) {
  const r = await store.set({ userId: 'u0000000000000001', scope: { kind: 'circle', circleId: 'c0000000000000001' }, factId: `${name}-${i}`, verb: 'pay', at: 10_000 + i });
  if (!r.ok) {
    process.stderr.write(`${JSON.stringify(r.error)}\n`);
    process.exit(1);
  }
}
store.close();
