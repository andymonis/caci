// Test support: a child process that adds 1 to a shared counter, n times, as concurrent
// transactions of its own adapter. Not part of the package.
// usage: node --import ./ts-loader.mjs rmw-child.mjs <path> <n>
import process from 'node:process';
import { createSqliteAdapter } from './index.ts';

const [path, n] = process.argv.slice(2);
const adapter = createSqliteAdapter({ path, busyTimeoutMs: 60_000 });
const bump = () =>
  adapter.transaction('g', async (tx) => {
    const [counter] = await tx.getNodes('item', ['counter']);
    await tx.putNodes([{ partition: 'item', id: 'counter', data: { count: (counter?.data?.count ?? 0) + 1 } }]);
  });
await Promise.all(Array.from({ length: Number(n) }, bump));
await adapter.close();
