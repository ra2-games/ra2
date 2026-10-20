import { V86 } from 'v86';
import type { BrowserEmulatorProbe } from './emulatorProbe';

interface CpuScheduler {
  running: boolean;
  worker: { terminate(): void } | null;
  yield(delay: number, tick: number): void;
  yield_callback(tick: number): void;
  unregister_yield(): void;
}

/** Internal scheduling interface of v86 0.5.441; preserve upstream behavior if its shape differs. */
export function installWorkerCpuScheduler(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object' || typeof MessageChannel !== 'function') return false;
  const engine = candidate as CpuScheduler;
  if (
    engine.running !== false ||
    typeof engine.yield !== 'function' ||
    typeof engine.yield_callback !== 'function' ||
    typeof engine.unregister_yield !== 'function' ||
    typeof engine.worker?.terminate !== 'function'
  )
    return false;

  const channel = new MessageChannel();
  const unregister = engine.unregister_yield.bind(engine);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Initialization has not called run, so there are no CPU ticks to migrate. Release the original nested timer Worker.
  unregister();
  channel.port1.onmessage = (event: MessageEvent<{ delay: number; tick: number }>) => {
    if (closed) return;
    clearTimeout(timer);
    timer = undefined;
    const { delay, tick } = event.data;
    // Preserve upstream positive waits and yield_callback's stale-tick checks.
    if (delay < 1) engine.yield_callback(tick);
    else
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) engine.yield_callback(tick);
      }, delay);
  };
  engine.yield = (delay, tick) => {
    if (!closed) channel.port2.postMessage({ delay, tick });
  };
  engine.unregister_yield = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    unregister();
  };
  return true;
}

/** The browser host owns CPU scheduling ports; V86.destroy releases them through the existing ownership chain. */
export function createBrowserEmulator(
  options: ConstructorParameters<typeof V86>[0],
  probe?: BrowserEmulatorProbe,
): V86 {
  const emulator = new V86(options);
  // Replace only nested Workers inside Dedicated Workers. Window retains the upstream timer Worker,
  // avoiding migration of positive waits to Window.setTimeout, which may be throttled in background tabs.
  const adaptWorker =
    options.autostart === false && typeof (globalThis as { importScripts?: unknown }).importScripts === 'function';
  if (!adaptWorker && !probe) return emulator;
  let disposed = false;
  const ready = () => {
    emulator.remove_listener('emulator-ready', ready);
    if (disposed) return;
    const engine = (emulator as unknown as { v86?: { worker?: unknown } }).v86;
    const adapted = adaptWorker && installWorkerCpuScheduler(engine);
    probe?.attach(engine, adapted ? 'message-channel' : engine?.worker ? 'upstream-worker' : 'upstream-other');
  };
  const destroy = emulator.destroy.bind(emulator);
  emulator.destroy = async () => {
    disposed = true;
    probe?.detach();
    emulator.remove_listener('emulator-ready', ready);
    await destroy();
  };
  emulator.add_listener('emulator-ready', ready);
  return emulator;
}
