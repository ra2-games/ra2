export interface TimingSummary {
  count: number;
  totalMs: number;
  meanMs: number | null;
  maxMs: number | null;
}

/** Constant-space aggregate: never retain a sample per CPU slice or browser frame. */
export class TimingStats {
  private count = 0;
  private total = 0;
  private max = 0;

  add(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.count++;
    this.total += milliseconds;
    this.max = Math.max(this.max, milliseconds);
  }

  snapshot(): TimingSummary {
    return {
      count: this.count,
      totalMs: this.total,
      meanMs: this.count ? this.total / this.count : null,
      maxMs: this.count ? this.max : null,
    };
  }
}
