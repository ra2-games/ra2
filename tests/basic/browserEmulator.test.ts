import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEmulator, installWorkerCpuScheduler } from '../../src/platform/browser/emulator';

vi.mock('v86', () => ({
  V86: class {
    listeners = new Set<() => void>();
    v86 = {
      running: false,
      worker: { terminate: vi.fn() } as { terminate(): void } | null,
      yield: vi.fn(),
      yield_callback: vi.fn(),
      unregister_yield() {
        this.worker?.terminate();
        this.worker = null;
      },
    };
    add_listener(_name: string, callback: () => void) {
      this.listeners.add(callback);
    }
    remove_listener(_name: string, callback: () => void) {
      this.listeners.delete(callback);
    }
    ready() {
      for (const callback of this.listeners) callback();
    }
    async destroy() {
      this.v86.unregister_yield();
    }
  },
}));

class Port {
  onmessage: ((event: MessageEvent<{ delay: number; tick: number }>) => void) | null = null;
  close = vi.fn();
  messages: unknown[] = [];
  postMessage = vi.fn((data: unknown) => {
    this.messages.push(data);
  });
}
class Channel {
  static instances: Channel[] = [];
  port1 = new Port();
  port2 = new Port();
  constructor() {
    Channel.instances.push(this);
  }
  deliver() {
    for (const data of this.port2.messages.splice(0)) {
      this.port1.onmessage?.({ data } as MessageEvent);
    }
  }
}
function scheduler() {
  const seen: number[] = [];
  return {
    running: false,
    worker: { terminate: vi.fn() } as { terminate(): void } | null,
    yield: vi.fn<(delay: number, tick: number) => void>(),
    tick: 1,
    seen,
    yield_callback(tick: number) {
      if (tick === this.tick) seen.push(tick);
    },
    unregister_yield: vi.fn(function (this: { worker: { terminate(): void } | null }) {
      this.worker?.terminate();
      this.worker = null;
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Channel.instances = [];
  vi.stubGlobal('MessageChannel', Channel);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('浏览器 Worker CPU 调度', () => {
  it.each([0, 0.5])('短等待 %s 保留异步任务边界与上游 tick 过滤', (delay) => {
    const engine = scheduler();
    expect(installWorkerCpuScheduler(engine)).toBe(true);
    const channel = Channel.instances[0]!;
    engine.yield(delay, 0); // Expired; still filtered by the upstream callback
    engine.yield(delay, 1);
    expect(engine.seen).toEqual([]);
    channel.deliver();
    expect(engine.seen).toEqual([1]);
    engine.unregister_yield();
  });

  it('保留正等待时长，新 tick 取消旧等待', () => {
    const engine = scheduler();
    installWorkerCpuScheduler(engine);
    const channel = Channel.instances[0]!;
    engine.yield(12, 1);
    channel.deliver();
    vi.advanceTimersByTime(11);
    expect(engine.seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(engine.seen).toEqual([1]);
    engine.yield(50, 1);
    channel.deliver();
    engine.tick = 2;
    engine.yield(0, 2);
    channel.deliver();
    vi.advanceTimersByTime(100);
    expect(engine.seen).toEqual([1, 2]);
    engine.unregister_yield();
  });

  it('销毁取消计时、关闭端口，晚到回调和重复销毁无效', () => {
    const engine = scheduler(),
      unregister = engine.unregister_yield;
    const terminate = engine.worker!.terminate;
    installWorkerCpuScheduler(engine);
    expect(terminate).toHaveBeenCalledTimes(1);
    const channel = Channel.instances[0]!;
    engine.yield(50, 1);
    channel.deliver();
    const late = channel.port1.onmessage!;
    engine.unregister_yield();
    engine.unregister_yield();
    late({ data: { delay: 0, tick: 1 } } as MessageEvent);
    engine.yield(0, 1);
    vi.advanceTimersByTime(100);
    expect(engine.seen).toEqual([]);
    expect(channel.port2.postMessage).toHaveBeenCalledTimes(1);
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('缺少上游计时 Worker 或接口不匹配时保留原实现', () => {
    const engine = scheduler();
    engine.worker = null;
    const original = engine.yield;
    expect(installWorkerCpuScheduler(engine)).toBe(false);
    expect(engine.yield).toBe(original);
    expect(installWorkerCpuScheduler({ worker: {}, yield: () => {} })).toBe(false);
    expect(Channel.instances).toHaveLength(0);
  });

  it('不在已运行的 CPU 中途替换调度器', () => {
    const engine = scheduler();
    engine.running = true;
    const original = engine.yield;
    expect(installWorkerCpuScheduler(engine)).toBe(false);
    expect(engine.yield).toBe(original);
    expect(engine.unregister_yield).not.toHaveBeenCalled();
  });

  it.each([true, false])('构造所有权：ready 前销毁=%s 不留下调度资源', async (early) => {
    vi.stubGlobal('importScripts', () => {});
    const emulator = createBrowserEmulator({ autostart: false });
    const fake = emulator as unknown as { ready(): void; listeners: Set<() => void> };
    if (early) await emulator.destroy();
    fake.ready();
    expect(fake.listeners.size).toBe(0);
    expect(Channel.instances).toHaveLength(early ? 0 : 1);
    await emulator.destroy();
    if (!early) expect(Channel.instances[0]!.port1.close).toHaveBeenCalledTimes(1);
  });

  it('非 Worker 构造保留上游计时器', async () => {
    vi.stubGlobal('importScripts', undefined);
    const emulator = createBrowserEmulator({ autostart: false });
    expect(Channel.instances).toHaveLength(0);
    await emulator.destroy();
  });
});
