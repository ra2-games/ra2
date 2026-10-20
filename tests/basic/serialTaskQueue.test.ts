import { describe, expect, it } from 'vitest';
import { SerialTaskQueue } from '../../src/utils/serialTaskQueue';

describe('SerialTaskQueue', () => {
  it('严格按入队顺序等待异步任务', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new SerialTaskQueue(() => undefined);

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.enqueue(() => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('单项失败后继续处理后续任务', async () => {
    const errors: unknown[] = [];
    const queue = new SerialTaskQueue((error) => errors.push(error));
    const failed = queue.enqueue(() => {
      throw new Error('boom');
    });
    const order: string[] = [];
    const recovered = queue.enqueue(() => {
      order.push('recovered');
    });

    await expect(failed).rejects.toThrow('boom');
    await recovered;
    expect(errors).toHaveLength(1);
    expect(order).toEqual(['recovered']);
  });
});
