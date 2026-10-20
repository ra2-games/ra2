import type { TimingSummary } from '../utils/timingStats';

/** Host execution measurements, independent of game policy and the presentation thread. */
export interface VmExecutionSample {
  scheduler: string;
  supported: boolean;
  active: boolean;
  elapsedMs: number;
  cpuSlices: TimingSummary;
  immediateWaits: TimingSummary;
  delayedWaitOvershoot: TimingSummary;
  staleCallbacks: number;
  jitDisabled: boolean | null;
  /** Raw upstream jit_get_cache_size value; do not infer resident memory from it. */
  jitCacheSize: number | null;
  wasmMemoryBytes: number | null;
}

export interface VmExecutionProbe {
  start(): void;
  sample(): VmExecutionSample;
  stop(): void;
}
