import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteCircleStore } from '../circles/sqlite/index.js';
import { createSqliteAdapter, GRAPH_APPLICATION_ID } from '../graph_store/adapters/sqlite/index.js';
import { query, type JsonObject, type NodesOutput, type SubgraphOutput } from '../graph_store/index.js';
import { createSqliteLedgerStore } from '../ledger/sqlite/index.js';
import { circleGraphId } from '../scopes/index.js';
import { snapshotDatabase } from '../sqlite/snapshot.js';
import { userGraphId } from '../users/index.js';
import { createSqliteUserStore, USERS_APPLICATION_ID } from '../users/sqlite/index.js';

// Exporting one brain (R-017 D11, D12): a person's own or a circle's, as one JSON document. It never opens the live files for anything
// but the consistent copy it makes (`VACUUM INTO`, which reads in one transaction), so it is safe while the service runs; everything
// else is read from that copy in a temporary owner-only folder, which is removed afterwards, also on failure. The document holds the
// facts, categories, links, who wrote what (as usernames, never ids) and the change log with the words typed. It holds no password,
// hash, session or email, and nothing of any other brain.

export const EXPORT_FORMAT = 'caci-brain-export';
export const EXPORT_VERSION = 1;
const PAGE = 200;
const MAX_PAGES = 10_000;

export type ExportTarget = { readonly kind: 'user'; readonly username: string } | { readonly kind: 'circle'; readonly circleId: string };

export interface ExportFact {
  readonly id: string;
  readonly title?: string;
  readonly summary?: string;
  readonly key?: string;
  /** The username of who entered it, when a circle's fact is stamped and the account still exists. */
  readonly author?: string;
  readonly at?: number;
  readonly categories: ReadonlyArray<{ readonly id: string; readonly weight: number }>;
}

export interface ExportEntry {
  readonly at: number;
  readonly action: 'added' | 'updated' | 'removed';
  readonly kind: 'item' | 'category' | 'input';
  readonly subject?: string;
  readonly by?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly text?: string;
}

export interface BrainExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: typeof EXPORT_VERSION;
  readonly exportedAt: number;
  readonly brain: { readonly kind: 'personal' | 'circle'; readonly name: string; readonly circleId?: string };
  readonly counts: { readonly facts: number; readonly categories: number; readonly links: number; readonly entries: number; readonly inputs: number };
  readonly categories: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  readonly facts: readonly ExportFact[];
  readonly ledger: readonly ExportEntry[];
}

export type ExportResult = { readonly ok: true; readonly value: BrainExport } | { readonly ok: false; readonly code: 'MISSING_DATABASE' | 'NOT_FOUND' | 'FAILED'; readonly message: string };

const refuse = (code: 'MISSING_DATABASE' | 'NOT_FOUND' | 'FAILED', message: string): ExportResult => ({ ok: false, code, message });
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Exports one brain from the data folder. Never throws; every failure is a fixed sentence (no path, SQL or note text). */
export async function exportBrain(options: { readonly dataDir: string; readonly target: ExportTarget; readonly now?: () => number }): Promise<ExportResult> {
  const now = options.now ?? Date.now;
  const graphsPath = join(options.dataDir, 'graphs.db');
  const usersPath = join(options.dataDir, 'users.db');
  for (const [file, path] of [['graphs.db', graphsPath], ['users.db', usersPath]] as const) {
    if (!existsSync(path)) return refuse('MISSING_DATABASE', `there is no ${file} in the data folder (nothing was created)`);
  }
  let temp: string | undefined;
  const closers: Array<() => unknown> = [];
  try {
    temp = mkdtempSync(join(tmpdir(), 'caci-export-'));
    const copy = join(temp, 'copy');
    mkdirSync(copy, { mode: 0o700 });
    const g = snapshotDatabase(graphsPath, join(copy, 'graphs.db'), { applicationIds: [GRAPH_APPLICATION_ID] });
    const u = snapshotDatabase(usersPath, join(copy, 'users.db'), { applicationIds: [USERS_APPLICATION_ID] });
    if (!g.ok || !u.ok) return refuse('FAILED', 'the databases could not be copied for reading');

    const graphs = createSqliteAdapter({ path: join(copy, 'graphs.db') });
    closers.push(() => graphs.close());
    const users = createSqliteUserStore({ path: join(copy, 'users.db') });
    closers.push(() => users.close());
    const circles = createSqliteCircleStore({ path: join(copy, 'users.db') });
    closers.push(() => circles.close());
    const ledger = createSqliteLedgerStore({ path: join(copy, 'users.db') });
    closers.push(() => ledger.close());

    // who is being exported
    let graphId: string;
    let scope: { readonly kind: 'personal'; readonly userId: string } | { readonly kind: 'circle'; readonly circleId: string };
    let brain: BrainExport['brain'];
    if (options.target.kind === 'user') {
      const user = await users.getByUsername(options.target.username);
      if (user === undefined) return refuse('NOT_FOUND', 'there is no such user');
      graphId = userGraphId(user.id);
      scope = { kind: 'personal', userId: user.id };
      brain = { kind: 'personal', name: user.username };
    } else {
      const circle = await circles.getCircle(options.target.circleId);
      if (circle === undefined) return refuse('NOT_FOUND', 'there is no such circle');
      graphId = circleGraphId(circle.id);
      scope = { kind: 'circle', circleId: circle.id };
      brain = { kind: 'circle', name: circle.name, circleId: circle.id };
    }

    const names = new Map<string, string | undefined>();
    const nameOf = async (id: string): Promise<string | undefined> => {
      if (!names.has(id)) names.set(id, (await users.get(id))?.username);
      return names.get(id);
    };

    // the graph, a page at a time
    const categories: Array<{ id: string; name?: string }> = [];
    const facts: ExportFact[] = [];
    const links = new Map<string, Array<{ id: string; weight: number }>>();
    const items = new Map<string, JsonObject | undefined>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await query(graphs, { version: 1, graphId, from: { all: true }, return: { shape: 'subgraph', includeData: true }, page: { limit: PAGE, ...(cursor === null ? {} : { cursor }) } });
      if (!r.ok) return refuse('FAILED', 'the brain could not be read');
      const out = r.value as SubgraphOutput & NodesOutput;
      for (const n of out.nodes) {
        if (n.partition === 'item') items.set(n.id, n.data);
        else categories.push({ id: n.id, ...(text(n.data?.['name']) === undefined ? {} : { name: text(n.data?.['name']) as string }) });
      }
      for (const e of out.edges) {
        const list = links.get(e.item) ?? [];
        list.push({ id: e.category, weight: e.weight });
        links.set(e.item, list);
      }
      cursor = out.nextCursor;
      if (cursor === null) break;
    }
    for (const [id, data] of items) {
      const by = typeof data?.['contributedBy'] === 'string' ? await nameOf(data['contributedBy']) : undefined;
      const at = data?.['contributedAt'];
      facts.push({
        id,
        ...(text(data?.['title']) === undefined ? {} : { title: text(data?.['title']) as string }),
        ...(text(data?.['summary']) === undefined ? {} : { summary: text(data?.['summary']) as string }),
        ...(text(data?.['key']) === undefined ? {} : { key: text(data?.['key']) as string }),
        ...(by === undefined ? {} : { author: by }),
        ...(typeof at === 'number' && Number.isSafeInteger(at) ? { at } : {}),
        categories: links.get(id) ?? [], // the graph store lists a page's edges by item and then by category
      });
    }

    // the change log, newest first
    const entries: ExportEntry[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await ledger.list(scope, { limit: 100, cursor: after });
      for (const e of listed.items) {
        const by = await nameOf(e.actor);
        entries.push({
          at: e.at,
          action: e.action,
          kind: e.kind,
          ...(e.kind === 'input' ? {} : { subject: e.subject }),
          ...(by === undefined ? {} : { by }),
          ...(e.title === undefined ? {} : { title: e.title }),
          ...(e.summary === undefined ? {} : { summary: e.summary }),
          ...(e.text === undefined ? {} : { text: e.text }),
        });
      }
      after = listed.nextCursor;
      if (after === null) break;
    }

    const value: BrainExport = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: now(),
      brain,
      counts: { facts: facts.length, categories: categories.length, links: [...links.values()].reduce((n, l) => n + l.length, 0), entries: entries.length, inputs: entries.filter((e) => e.kind === 'input').length },
      categories,
      facts,
      ledger: entries,
    };
    return { ok: true, value };
  } catch {
    return refuse('FAILED', 'the brain could not be exported');
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch {
        // already closed, or nothing to do
      }
    }
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
  }
}
