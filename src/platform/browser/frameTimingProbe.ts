import { TimingStats } from '../../utils/timingStats';

/** Observe display opportunities and page visibility only while a capture owns this object. */
export class FrameTimingProbe {
  private readonly startedAt = performance.now();
  private readonly intervals = new TimingStats();
  private lastFrame: number | null = null;
  private raf: number;
  private frames = 0;
  private longTasks = new TimingStats();
  private readonly observer: PerformanceObserver | null;
  private readonly visibility: Array<{ elapsedMs: number; state: DocumentVisibilityState }> = [];
  private readonly visibilityChanged = () => {
    this.visibility.push({ elapsedMs: performance.now() - this.startedAt, state: document.visibilityState });
  };

  constructor() {
    const tick = (at: number) => {
      if (this.lastFrame !== null) this.intervals.add(at - this.lastFrame);
      this.lastFrame = at;
      this.frames++;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.visibilityChanged();
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.observer =
      typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) this.longTasks.add(entry.duration);
          })
        : null;
    this.observer?.observe({ entryTypes: ['longtask'] });
  }

  sample() {
    return {
      elapsedMs: performance.now() - this.startedAt,
      rafCount: this.frames,
      rafIntervals: this.intervals.snapshot(),
      mainThreadLongTasks: this.observer ? this.longTasks.snapshot() : null,
      visibility: this.visibility.slice(),
    };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    document.removeEventListener('visibilitychange', this.visibilityChanged);
  }
}
