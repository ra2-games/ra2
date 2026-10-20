import type { VmFrame, Win32Call, VmNetworkStatus } from '../../vm86/win32';

export type VmPhase = 'loading' | 'ready' | 'running' | 'blocked' | 'exited' | 'stopped' | 'error';

export interface VmStatus {
  phase: VmPhase;
  detail: string;
}

export interface VmCallBatch {
  /** Global call sequence number at the end of the batch. */
  ordinal: number;
  /** Calls in this batch, used for HC/s without sending a cross-thread message per call. */
  delta: number;
  /** DirectDraw frame boundaries in this batch, distinct from native simulation frames. */
  logicFrames: number;
  /** Calls in this batch aggregated by API. */
  histogram: Array<[key: string, count: number]>;
  /** Debug logs retain sparse sampling: the first 200 calls, then every 256th call. */
  samples: Array<{ call: Win32Call; ordinal: number }>;
}

export interface GameVmCallbacks {
  onNetworkStatus?: (status: VmNetworkStatus) => void;
  onStatus?: (status: VmStatus) => void;
  onCall?: (call: Win32Call, ordinal: number) => void;
  /** Workers return aggregates every 500ms; main-thread fallback continues using onCall. */
  onCallBatch?: (batch: VmCallBatch) => void;
  onBlocked?: (call: Win32Call) => void;
  onFrame?: (frame: VmFrame) => void;
  /** DirectDraw frame boundaries: main-thread count is 1; Workers return batches every 500ms. Use getGamePerformance for native logic frames. */
  onLogicFrame?: (count: number) => void;
  /** RA2/YR shell-title changes, such as GUI:MainMenu/CampaignMenu, for UI diagnostics and browser regressions. */
  onShellPage?: (title: string) => void;
}
