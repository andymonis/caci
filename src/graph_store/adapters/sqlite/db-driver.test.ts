import { describe, expect, it, vi } from 'vitest';

describe('on a Node without node:sqlite', () => {
  it('importing works and opening explains what is wrong', async () => {
    vi.resetModules();
    vi.doMock('node:sqlite', () => {
      throw new Error('No such built-in module: node:sqlite');
    });
    const { openDb, DbError } = await import('./db.js');
    let caught: unknown;
    try {
      openDb();
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(DbError);
    expect((caught as InstanceType<typeof DbError>).code).toBe('DRIVER_UNAVAILABLE');
    expect((caught as Error).message).toMatch(/Node 22\.13/);
    expect((caught as Error).message).toMatch(/built-in node:sqlite \(.+\)/); // the underlying reason is kept
    vi.doUnmock('node:sqlite');
    vi.resetModules();
  });
});
