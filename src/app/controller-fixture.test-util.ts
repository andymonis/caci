import { expect } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type Op, type StorageAdapter } from '../graph_store/index.js';
import { createLlm } from '../llm/index.js';
import { createScriptedModelClient, type ScriptStep } from '../llm/testing/index.js';
import { createController, type ControllerInit } from './controller.js';
import { recordAdapter } from './recording-adapter.test-util.js';

export const category = (id: string, name = id): Op => ({ op: 'upsertNode', partition: 'category', id, mode: 'merge', data: { name } });
export const item = (id: string): Op => ({ op: 'upsertNode', partition: 'item', id, mode: 'merge', data: { title: id } });
export const link = (i: string, c: string): Op => ({ op: 'link', item: i, category: c, ensureNodes: false });
export const reply = (value: unknown): ScriptStep => ({ reply: JSON.stringify(value) });

export const PROPOSAL = {
  ops: [
    { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Dr X visit', summary: 'Follow up.' } },
    { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } },
    { op: 'link', item: 'note-1', category: 'doctor-x', weight: 0.9 },
    { op: 'link', item: 'note-1', category: 'appointments', weight: 0.7 },
  ],
  rationale: 'About a doctor visit.',
};
export const NOTE = { kind: 'text', text: 'Saw Dr X on Tuesday about the blood test.' };

export type Script = Parameters<typeof createScriptedModelClient>[0];
export async function setup(options: { script?: Script; existing?: Op[]; init?: Partial<ControllerInit>; createGraphFirst?: boolean; wrap?: (adapter: StorageAdapter) => StorageAdapter } = {}) {
  const inner = createMemoryAdapter();
  const recording = recordAdapter(inner);
  if (options.createGraphFirst !== false) {
    await createGraph(inner, 'notes');
    if (options.existing) expect((await write(inner, { version: 1, kind: 'mutation', graphId: 'notes', createIfMissing: false, ops: options.existing })).ok).toBe(true);
  }
  const client = createScriptedModelClient(options.script ?? [reply(PROPOSAL)]);
  let clock = 1_000_000;
  const clockControl = { now: () => clock, advance: (ms: number) => void (clock += ms) };
  let minted = 0;
  const controller = createController({
    adapter: options.wrap ? options.wrap(recording.adapter) : recording.adapter,
    llm: createLlm({ client, now: clockControl.now }),
    ids: () => `note-${++minted}`,
    now: clockControl.now,
    ...options.init,
  });
  return { controller, client, inner, recording, clock: clockControl, minted: () => minted };
}
export const EXISTING: Op[] = [category('appointments', 'Appointments'), category('errands'), item('older-note'), link('older-note', 'appointments')];

