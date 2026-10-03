import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../graph_store/index.js';
import { runWithDeadline } from './deadline.js';
import { llmError } from './errors.js';

afterEach(() => vi.useRealTimers());

const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));

describe('runWithDeadline', () => {
  it('returns what the work returns when it finishes in time', async () => {
    expect(await runWithDeadline(async () => ok('done'), { timeoutMs: 1000 })).toEqual({ ok: true, value: 'done' });
  });

  it("passes the work's own error results through unchanged", async () => {
    const refusal = err(llmError('REFUSED', 'no'));
    expect(await runWithDeadline(async () => refusal, { timeoutMs: 1000 })).toEqual(refusal);
  });

  it('is a retryable TIMEOUT when the work takes too long, and tells the work to stop', async () => {
    let received: AbortSignal | undefined;
    const r = await runWithDeadline((signal) => ((received = signal), never(signal)), { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    expect(received?.aborted).toBe(true);
  });

  it('is CANCELLED, not retryable, when the caller cancels, and tells the work to stop', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const pending = runWithDeadline((signal) => ((received = signal), never(signal)), { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED', retryable: false } });
    expect(received?.aborted).toBe(true);
  });

  it('does not start the work at all when the signal was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => ok('x'));
    expect(await runWithDeadline(work, { timeoutMs: 1000, signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(work).not.toHaveBeenCalled();
  });

  it('turns work that throws, or rejects, into a MODEL_ERROR instead of throwing', async () => {
    expect(await runWithDeadline(async () => { throw new Error('socket closed'); }, { timeoutMs: 1000 })).toMatchObject({
      ok: false,
      error: { code: 'MODEL_ERROR', message: expect.stringContaining('socket closed') },
    });
    expect(await runWithDeadline(() => { throw new TypeError('sync failure'); }, { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR' } });
    expect(await runWithDeadline(async () => Promise.reject('plain text'), { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR' } });
  });

  it('does not report an unhandled error when the work fails after the deadline', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await runWithDeadline((signal) => never(signal), { timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('leaves no timer running, whether the work finishes, times out or is cancelled', async () => {
    vi.useFakeTimers();
    const finished = runWithDeadline(async () => ok(1), { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    await finished;
    expect(vi.getTimerCount()).toBe(0);

    const timedOut = runWithDeadline((signal) => never(signal), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    await timedOut;
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const cancelled = runWithDeadline((signal) => never(signal), { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its listener from the caller signal when it is done', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await runWithDeadline(async () => ok(1), { timeoutMs: 1000, signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('a result that arrives just before the deadline wins', async () => {
    const r = await runWithDeadline(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ok('in time');
      },
      { timeoutMs: 200 },
    );
    expect(r).toEqual({ ok: true, value: 'in time' });
  });
});
