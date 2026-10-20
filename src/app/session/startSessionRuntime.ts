import type { SessionRuntime } from './runtime';

/** Centralize startup-failure handling and cleanup without depending on pages, React, or a specific VM factory. */
export async function startSessionRuntime<T extends SessionRuntime>(
  start: () => Promise<T | null>,
  onStartupError: (error: unknown, detail: string) => void,
  releaseRuntime: () => Promise<void>,
  onStarted: (vm: T) => void = () => {},
): Promise<T | null> {
  try {
    const vm = await start();
    if (vm) onStarted(vm);
    return vm;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onStartupError(error, detail);
    try {
      await releaseRuntime();
    } catch (cleanupError) {
      console.error('[VM] 启动失败后的清理失败', cleanupError);
    }
    return null;
  }
}
