import type { AudioOp, AudioStateReport } from './vmProtocol';
import type { Win32AudioSink } from '../vm86/win32';

/** Session-owned observation loop. Sampling never advances the sink's audio clock. */
export class AudioStateFeedback {
  private readonly revisions = new Map<number, number>();
  private readonly previous = new Map<number, AudioStateReport>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: Win32AudioSink,
    private readonly send: (states: AudioStateReport[]) => void,
  ) {}

  applied(op: AudioOp, revision: number | undefined): void {
    if (op.op === 'releaseBuffer') {
      this.revisions.delete(op.id);
      this.previous.delete(op.id);
      if (!this.revisions.size) this.clear();
      return;
    }
    if (revision === undefined) return;
    const id = op.op === 'duplicateBuffer' ? op.destinationId : op.id;
    this.revisions.set(id, revision);
    this.publish();
    this.timer ??= setInterval(() => this.publish(), 10);
  }

  private publish(): void {
    const reports: AudioStateReport[] = [];
    for (const [id, revision] of this.revisions) {
      const state = this.sink.getState(id);
      if (!state) continue;
      const report = {
        id,
        revision,
        positionBytes: state.positionBytes,
        writePositionBytes: state.writePositionBytes ?? state.positionBytes,
        playing: state.playing,
      };
      const previous = this.previous.get(id);
      if (
        previous?.revision === revision &&
        previous.positionBytes === report.positionBytes &&
        previous.writePositionBytes === report.writePositionBytes &&
        previous.playing === report.playing
      )
        continue;
      this.previous.set(id, report);
      reports.push(report);
    }
    if (reports.length) this.send(reports);
  }

  clear(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.revisions.clear();
    this.previous.clear();
  }
}
