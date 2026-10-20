import type { GameFrameCounters, GamePerformanceSample } from '../games/performance';
export type { GameFrameReader, GamePerformanceSample } from '../games/performance';

/** Sample on demand without creating timers; measure actual progress against host monotonic time rather than the guest clock. */
export class GamePerformanceMeter {
  private previous: { frame: number; at: number } | null = null;
  reset(): void {
    this.previous = null;
  }
  sample(counters: GameFrameCounters, at: number, active: boolean): GamePerformanceSample {
    const previous = this.previous;
    this.previous = active ? { frame: counters.frame, at } : null;
    const intervalMs = previous && active ? at - previous.at : null;
    const status = !active
      ? 'inactive'
      : !previous
        ? 'baseline'
        : counters.frame < previous.frame || !Number.isFinite(intervalMs) || intervalMs! <= 0
          ? 'reset'
          : 'sample';
    return {
      ...counters,
      sampledAtMs: at,
      intervalMs,
      logicFps: status === 'sample' ? ((counters.frame - previous!.frame) * 1000) / intervalMs! : null,
      status,
    };
  }
}
