import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEmulatorProbe } from '../../src/platform/browser/emulatorProbe';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('measures actual waits and CPU work while preserving ticks, requested delays and method ownership', () => {
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  const engine = {
    tick_counter: 0,
    yield: vi.fn((_delay: number, _tick: number) => {}),
    yield_callback(tick: number) {
      if (this.tick_counter === tick) this.cpu.main_loop();
    },
    cpu: {
      main_loop() {
        at += 2;
        return 17;
      },
    },
  };
  const methods = { yield: engine.yield, callback: engine.yield_callback, loop: engine.cpu.main_loop };
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'message-channel');
  expect(engine.yield).toBe(methods.yield);
  probe.start();
  engine.yield(0, ++engine.tick_counter);
  at = 5;
  engine.yield_callback(1);
  engine.yield(10, ++engine.tick_counter);
  at = 20;
  engine.yield_callback(1); // Superseded notification must not count as a wait or execute the CPU.
  engine.yield_callback(2);
  expect(probe.sample()).toMatchObject({
    supported: true,
    scheduler: 'message-channel',
    staleCallbacks: 1,
    immediateWaits: { count: 1, totalMs: 5 },
    delayedWaitOvershoot: { count: 1, totalMs: 3 },
    cpuSlices: { count: 2, totalMs: 4 },
    jitDisabled: null,
  });
  expect(methods.yield.mock.calls).toEqual([
    [0, 1],
    [10, 2],
  ]);
  probe.stop();
  expect(engine.yield).toBe(methods.yield);
  expect(engine.yield_callback).toBe(methods.callback);
  expect(engine.cpu.main_loop).toBe(methods.loop);
  at = 100;
  expect(probe.sample().elapsedMs).toBe(22);
  probe.start();
  expect(probe.sample().cpuSlices.count).toBe(0);
  probe.detach();
  expect(engine.cpu.main_loop).toBe(methods.loop);
});

it('reports unsupported interfaces and reads JIT configuration without modifying it', () => {
  const probe = new BrowserEmulatorProbe();
  probe.attach({}, 'upstream-other');
  probe.start();
  expect(probe.sample()).toMatchObject({ supported: false, jitDisabled: null, cpuSlices: { count: 0, meanMs: null } });
  probe.stop();
  const getConfig = vi.fn(() => 0);
  probe.attach(
    {
      tick_counter: 0,
      yield() {},
      yield_callback() {},
      cpu: {
        main_loop() {
          return 0;
        },
        wm: { exports: { get_jit_config: getConfig, jit_get_cache_size: () => 100 } },
      },
    },
    'upstream-worker',
  );
  probe.start();
  expect(probe.sample()).toMatchObject({ supported: true, jitDisabled: false, jitCacheSize: 100 });
  expect(getConfig).toHaveBeenCalledWith(0);
  probe.detach();
});

it('restores uninstrumented methods if the capture client disappears', () => {
  vi.useFakeTimers();
  const engine = {
    tick_counter: 0,
    yield() {},
    yield_callback() {},
    cpu: {
      main_loop() {
        return 0;
      },
    },
  };
  const original = engine.cpu.main_loop;
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'upstream-worker');
  probe.start();
  expect(engine.cpu.main_loop).not.toBe(original);
  vi.advanceTimersByTime(30_000);
  expect(engine.cpu.main_loop).toBe(original);
  expect(probe.sample().active).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  probe.detach();
});
