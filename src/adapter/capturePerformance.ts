import type { VmShell } from './vmShell';
import type { VmDiagnostics } from './vmDiagnostics';

export const PERFORMANCE_CAPTURE_MS = 20_000;

/** Bounded, sequential RPC sampling. Missing native counters and failed requests stay explicit in the report. */
export async function capturePerformance<T>(
  vm: Pick<VmShell, 'runtimeInfo' | 'getDiagnostics'>,
  options: {
    signal: AbortSignal;
    sampleHost: () => T;
    progress: (remainingSeconds: number) => void;
    durationMs?: number;
  },
) {
  const duration = options.durationMs ?? PERFORMANCE_CAPTURE_MS;
  const samples: Array<{ elapsedMs: number; requestMs: number; vm: VmDiagnostics; host: T }> = [];
  const errors: string[] = [];
  const at = performance.now();
  let status: 'complete' | 'cancelled' | 'error' = 'complete';
  const sample = async (action: 'start' | 'sample' | 'stop') => {
    const requestAt = performance.now();
    const value = await vm.getDiagnostics(action);
    samples.push({
      elapsedMs: performance.now() - at,
      requestMs: performance.now() - requestAt,
      vm: value,
      host: options.sampleHost(),
    });
  };
  try {
    options.signal.throwIfAborted();
    await sample('start');
    while (performance.now() - at < duration) {
      options.progress(Math.max(0, Math.ceil((duration - (performance.now() - at)) / 1000)));
      await wait(Math.min(1000, duration - (performance.now() - at)), options.signal);
      await sample('sample');
    }
    options.signal.throwIfAborted();
  } catch (error) {
    status = options.signal.aborted ? 'cancelled' : 'error';
    if (status === 'error') errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    // Stop even after a failed start/RPC: the Worker may have enabled instrumentation before its reply was lost.
    try {
      await sample('stop');
    } catch (error) {
      errors.push(`stop: ${error instanceof Error ? error.message : String(error)}`);
      if (status === 'complete') status = 'error';
    }
  }
  return { runtime: { ...vm.runtimeInfo }, status, durationMs: performance.now() - at, samples, errors };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      },
      Math.max(0, ms),
    );
    signal.addEventListener('abort', cancel, { once: true });
  });
}
