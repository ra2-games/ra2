import type { VmFrame } from '../vm86/win32';

export interface CursorPresentation {
  x: number;
  y: number;
  visible: boolean;
}
export interface FrameOutput {
  clear(): void;
  destroy(): void;
  draw(frame: VmFrame, width: number, height: number, cursor: CursorPresentation, cursorFrame: VmFrame): void;
}
export interface PresentationHooks {
  targetSize(): { width: number; height: number };
  transform?(frame: VmFrame): VmFrame | null;
  presented?(): void;
  tick?(): void;
}
export interface FrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

/**
 * Own the latest frame reference and one rAF, not VM lifecycle, React state, or specific upscaling models.
 * submit must replace the reference before the VM reclaims the previous frame, without whole-frame copies or historical frame queues.
 */
export class FramePresenter {
  private latest: VmFrame | null = null;
  private version = 0;
  private drawnVersion = -1;
  private cursor: CursorPresentation = { x: 400, y: 300, visible: false };
  private cursorVersion = 0;
  private drawnCursorVersion = -1;
  private pending: number | null = null;
  private dead = false;
  private cursorDrawnBeforeFrame = false;
  private tickPending = false;
  private presentations = 0;

  get presentedFrames(): number {
    return this.presentations;
  }

  constructor(
    private output: FrameOutput,
    private hooks: PresentationHooks,
    private scheduler: FrameScheduler = {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    },
  ) {}

  get frame(): VmFrame | null {
    return this.latest;
  }
  get frameVersion(): number {
    return this.version;
  }

  submit(frame: VmFrame): void {
    if (this.dead) return;
    this.latest = frame;
    this.version++;
    this.schedule();
  }
  invalidate(): void {
    if (!this.dead) {
      this.drawnVersion = -1;
      this.schedule();
    }
  }
  schedule(updateStatus = true): void {
    if (this.dead) return;
    this.tickPending ||= updateStatus;
    if (this.pending !== null) return;
    this.pending = this.scheduler.request(() => {
      this.pending = null;
      const updateStatus = this.tickPending;
      this.tickPending = false;
      if (updateStatus) this.render();
      else this.draw();
      this.cursorDrawnBeforeFrame = false;
    });
  }
  render(): void {
    if (this.dead) return;
    if (this.latest) this.draw();
    else this.output.clear();
    this.hooks.tick?.();
  }
  presentCursor(x: number, y: number, visible: boolean): void {
    if (this.dead || (x === this.cursor.x && y === this.cursor.y && visible === this.cursor.visible)) return;
    const redraw = visible || this.cursor.visible;
    this.cursor = { x, y, visible };
    if (!redraw) return;
    this.cursorVersion++;
    // Respond immediately to the first movement; subsequent events within the refresh cycle update position only, presenting the latest coordinates at frame end.
    // High-polling-rate mice must not rerun the whole WebGL/enhancement pipeline per event or accumulate historical coordinates.
    if (!this.cursorDrawnBeforeFrame) {
      this.cursorDrawnBeforeFrame = true;
      this.draw();
    }
    this.schedule(false);
  }
  private draw(): void {
    const frame = this.latest;
    if (!frame || (this.drawnVersion === this.version && this.drawnCursorVersion === this.cursorVersion)) return;
    const enhanced = this.hooks.transform?.(frame);
    const target = this.hooks.targetSize();
    // Even when enhancement lags, sample and position the cursor from the latest original frame.
    this.output.draw(enhanced ?? frame, target.width, target.height, this.cursor, frame);
    this.presentations++;
    this.drawnVersion = this.version;
    this.drawnCursorVersion = this.cursorVersion;
    this.hooks.presented?.();
  }
  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.pending !== null) this.scheduler.cancel(this.pending);
    this.pending = null;
    this.latest = null;
    this.output.destroy();
  }
}
