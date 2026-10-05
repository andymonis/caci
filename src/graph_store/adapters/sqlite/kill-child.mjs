// Test support: a child process that writes to a database file and is then killed. Not part of the package.
// usage: node --import ./ts-loader.mjs kill-child.mjs <path> <mode>
import process from 'node:process';
import { createSqliteAdapter } from './index.ts';

const [path, mode] = process.argv.slice(2);
const adapter = createSqliteAdapter({ path });
await adapter.graphs.create('g');
await adapter.transaction('g', (tx) => tx.putNodes([{ partition: 'item', id: 'committed' }]));

const nodes = Array.from({ length: 2000 }, (_, i) => ({ partition: 'item', id: `partial-${i}`, data: { n: i } }));
await adapter.transaction('g', async (tx) => {
  await tx.putNodes(nodes);
  await tx.putEdges(nodes.map((n) => ({ item: n.id, category: 'c', weight: 0.5 })));
  process.stdout.write('ready\n'); // written but not committed
  if (mode === 'hang') await new Promise(() => {}); // wait here to be killed
});
