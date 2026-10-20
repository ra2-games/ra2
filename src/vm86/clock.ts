const MIN_RATE = 0.25;
const MAX_RATE = 8;

/**
 * Continuous guest clock. Before changing the multiplier, accumulate time under the old multiplier into the anchor so guest time cannot move backward or jump; Win32 timer deadlines remain in guest milliseconds.
 */
export class ScaledClock {
  private rate = 1;
  private hostAnchor: number;
  private guestAnchor = 0;
  private readonly wallAnchor: number;
  private readonly readHostTime: () => number;

  constructor(readHostTime?: () => number, readWallTime?: () => number) {
    this.readHostTime = readHostTime ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
    this.hostAnchor = this.readHostTime();
    // Explicit test clocks share the same epoch; production defaults to Date.now for real wall-clock time.
    this.wallAnchor = (readWallTime ?? (readHostTime ? this.readHostTime : Date.now))();
  }

  now(): number {
    const hostNow = this.readHostTime();
    return this.guestAnchor + (hostNow - this.hostAnchor) * this.rate;
  }

  getRate(): number {
    return this.rate;
  }

  /** Current guest wall clock for dates, SYSTEMTIME, and FILETIME; never use it for runtime timers. */
  wallNow(): number {
    return this.wallAnchor + this.now();
  }

  setRate(requested: number): number {
    const next = normalizeGameClockRate(requested);
    const hostNow = this.readHostTime();
    this.guestAnchor += (hostNow - this.hostAnchor) * this.rate;
    this.hostAnchor = hostNow;
    this.rate = next;
    return next;
  }

  /** Convert guest-millisecond intervals to actual browser wait milliseconds. */
  toHostDelay(guestMilliseconds: number): number {
    if (!Number.isFinite(guestMilliseconds) || guestMilliseconds <= 0) return 0;
    return guestMilliseconds / this.rate;
  }

  /** Convert actual host waits back to guest milliseconds for guest deadlines. */
  toGuestDelay(hostMilliseconds: number): number {
    if (!Number.isFinite(hostMilliseconds) || hostMilliseconds <= 0) return 0;
    return hostMilliseconds * this.rate;
  }
}

export function normalizeGameClockRate(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, requested));
}
