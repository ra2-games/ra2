import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmShell } from '../../src/adapter/vmShell';
import { startSessionRuntime } from '../../src/app/session/startSessionRuntime';

function shell(): VmShell {
  return {
    gameControl: async () => ({ supported: false }),
    runtimeInfo: { mode: 'main-thread', reason: 'default', workerProbeMs: null, fallbackReason: null },
    getDiagnostics: async () => {
      throw new Error('No diagnostic capture in startup tests');
    },
    start: async () => {},
    stop: async () => {},
    flushFiles: async () => {},
    attachMapFiles: async () => ({ attached: [], existing: [] }),
    postMessage: () => {},
    setKeyState: () => {},
    setCursorPosition: () => {},
    setGameClockRate: (rate) => rate,
    setMasterVolume: () => {},
    getPointerState: async () => null,
    getGamePerformance: async () => null,
    setGameSpeedFlag: async () => null,
    startMemRecord: async () => false,
    stopMemRecord: async () => null,
    setCallTracing: () => {},
    destroy: async () => {},
  };
}

async function withoutUnhandledRejection<T>(task: () => Promise<T>): Promise<{ value: T; reasons: unknown[] }> {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', handler);
  try {
    const value = await task();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { value, reasons };
  } finally {
    process.off('unhandledRejection', handler);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('page VM startup boundary', () => {
  it('keeps the original startup error, cleans once, and never installs input after failure', async () => {
    const error = new Error('page start failed');
    const showError = vi.fn();
    const releaseRuntime = vi.fn(async () => {});
    const installInput = vi.fn();
    const result = await withoutUnhandledRejection(() =>
      startSessionRuntime(
        async () => {
          throw error;
        },
        showError,
        releaseRuntime,
        installInput,
      ),
    );

    expect(result.value).toBeNull();
    expect(result.reasons).toEqual([]);
    expect(showError).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith(error, 'page start failed');
    expect(releaseRuntime).toHaveBeenCalledOnce();
    expect(installInput).not.toHaveBeenCalled();
  });

  it('swallows cleanup failure without replacing the startup error or creating rejection noise', async () => {
    const error = new Error('startup failed');
    const cleanupError = new Error('cleanup failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await withoutUnhandledRejection(() =>
      startSessionRuntime(
        async () => {
          throw error;
        },
        vi.fn(),
        async () => {
          throw cleanupError;
        },
      ),
    );

    expect(result.value).toBeNull();
    expect(result.reasons).toEqual([]);
    expect(log).toHaveBeenCalledWith('[VM] 启动失败后的清理失败', cleanupError);
  });

  it('does not show an error or install input when cancellation returns no shell', async () => {
    const showError = vi.fn();
    const releaseRuntime = vi.fn(async () => {});
    const installInput = vi.fn();
    const result = await startSessionRuntime(async () => null, showError, releaseRuntime, installInput);

    expect(result).toBeNull();
    expect(showError).not.toHaveBeenCalled();
    expect(releaseRuntime).not.toHaveBeenCalled();
    expect(installInput).not.toHaveBeenCalled();
  });

  it('passes a successful shell through to the page continuation', async () => {
    const vm = shell();
    const onStarted = vi.fn();
    const result = await startSessionRuntime(
      async () => vm,
      vi.fn(),
      vi.fn(async () => {}),
      onStarted,
    );

    expect(result).toBe(vm);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledWith(vm);
  });
});
