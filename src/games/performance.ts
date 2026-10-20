/** Native simulation counters, not DirectDraw/VBlank, rAF, or target frame rates. */
export interface GameFrameCounters {
  frame: number;
  gameSpeed: number;
  sessionSpeed: number;
  requestedFps: number;
}
export type GameFrameReader = () => GameFrameCounters | null;
export interface GamePerformanceSample extends GameFrameCounters {
  sampledAtMs: number;
  intervalMs: number | null;
  logicFps: number | null;
  status: 'baseline' | 'sample' | 'reset' | 'inactive';
}
