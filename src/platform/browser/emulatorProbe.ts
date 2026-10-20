import { TimingStats } from '../../utils/timingStats';
import type { VmExecutionProbe, VmExecutionSample } from '../../vm86/diagnostics';

interface Engine {
  tick_counter: number;
  yield(delay: number, tick: number): void;
  yield_callback(tick: number): void;
  cpu: {
    main_loop(): number;
    wasm_memory?: WebAssembly.Memory;
    wm?: { exports?: { get_jit_config?: (index: number) => number; jit_get_cache_size?: () => number } };
  };
}

/** Observe the existing v86 scheduler only during an explicit capture; never change deadlines or execute extra ticks. */
export class BrowserEmulatorProbe implements VmExecutionProbe {
  private engine: Engine | null = null;
  private scheduler = 'unavailable';
  private restore: (() => void) | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private stoppedAt: number | null = null;
  private slices = new TimingStats();
  private immediate = new TimingStats();
  private delayed = new TimingStats();
  private stale = 0;

  attach(candidate: unknown, scheduler: string): void {
    this.stop();
    this.scheduler = scheduler;
    const engine = candidate as Engine | null;
    this.engine =
      engine &&
      typeof engine.tick_counter === 'number' &&
      typeof engine.yield === 'function' &&
      typeof engine.yield_callback === 'function' &&
      typeof engine.cpu?.main_loop === 'function'
        ? engine
        : null;
  }

  start(): void {
    this.stop();
    this.startedAt = performance.now();
    this.stoppedAt = null;
    this.slices = new TimingStats();
    this.immediate = new TimingStats();
    this.delayed = new TimingStats();
    this.stale = 0;
    const engine = this.engine;
    if (!engine) return;
    // A lost client or RPC must not leave hot-path instrumentation enabled indefinitely.
    this.watchdog = setTimeout(() => this.stop(), 30_000);
    const originalYield = engine.yield;
    const originalCallback = engine.yield_callback;
    const originalLoop = engine.cpu.main_loop;
    let pendingTick = -1,
      pendingAt = 0,
      pendingDelay = 0;
    engine.yield = (delay, tick) => {
      pendingTick = tick;
      pendingAt = performance.now();
      pendingDelay = delay < 1 ? 0 : delay;
      originalYield.call(engine, delay, tick);
    };
    engine.yield_callback = (tick) => {
      // v86 discards superseded callbacks. They must not inflate measured scheduling waits.
      if (tick !== engine.tick_counter) this.stale++;
      else if (pendingTick === tick) {
        const elapsed = performance.now() - pendingAt;
        if (pendingDelay === 0) this.immediate.add(elapsed);
        else this.delayed.add(Math.max(0, elapsed - pendingDelay));
        pendingTick = -1;
      }
      originalCallback.call(engine, tick);
    };
    engine.cpu.main_loop = () => {
      const at = performance.now();
      try {
        return originalLoop.call(engine.cpu);
      } finally {
        this.slices.add(performance.now() - at);
      }
    };
    this.restore = () => {
      engine.yield = originalYield;
      engine.yield_callback = originalCallback;
      engine.cpu.main_loop = originalLoop;
    };
  }

  sample(): VmExecutionSample {
    const exports = this.engine?.cpu.wm?.exports;
    return {
      scheduler: this.scheduler,
      supported: this.engine !== null,
      active: this.restore !== null,
      elapsedMs: Math.max(0, (this.stoppedAt ?? performance.now()) - this.startedAt),
      cpuSlices: this.slices.snapshot(),
      immediateWaits: this.immediate.snapshot(),
      delayedWaitOvershoot: this.delayed.snapshot(),
      staleCallbacks: this.stale,
      jitDisabled: exports?.get_jit_config ? exports.get_jit_config(0) !== 0 : null,
      jitCacheSize: exports?.jit_get_cache_size?.() ?? null,
      wasmMemoryBytes: this.engine?.cpu.wasm_memory?.buffer.byteLength ?? null,
    };
  }

  stop(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.restore?.();
    this.restore = null;
    this.stoppedAt ??= performance.now();
  }

  detach(): void {
    this.stop();
    this.engine = null;
  }
}
