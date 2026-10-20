import type { GamePerformanceSample } from '../games/performance';
import type { VmExecutionSample } from '../vm86/diagnostics';
import type { VmPhase } from '../app/session/runtimeEvents';

export type VmDiagnosticAction = 'start' | 'sample' | 'stop';

export interface VmRuntimeInfo {
  mode: 'worker' | 'main-thread';
  reason: 'default' | 'requested' | 'worker-unavailable' | 'probe-failed';
  workerProbeMs: number | null;
  fallbackReason: string | null;
}

export interface VmDiagnostics {
  sampledAtMs: number;
  phase: VmPhase;
  hypercalls: number;
  clockRate: number;
  execution: VmExecutionSample | null;
  game: GamePerformanceSample | null;
}
