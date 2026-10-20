import type { VmAudioSink } from './vmCore';
import type { AudioOp, AudioStateReport, WorkerToMainMessage } from './vmProtocol';
import { normalizePcmWaveFormat, type PcmPlayOptions, type PcmWaveFormat } from '../vm86/audio';

interface BufferState {
  revision: number;
  byteLength: number;
  format: PcmWaveFormat;
  positionBytes: number;
  writePositionBytes: number;
  playing: boolean;
}

/** Worker-owned command state. Only the output sink advances playback cursors. */
export class ProxyAudioSink implements VmAudioSink {
  private readonly buffers = new Map<number, BufferState>();
  private revision = 0;

  constructor(private readonly post: (message: WorkerToMainMessage, transfer?: Transferable[]) => void) {}

  acceptState(reports: readonly AudioStateReport[]): void {
    for (const report of reports) {
      const state = this.buffers.get(report.id);
      if (!state || state.revision !== report.revision) continue;
      state.positionBytes = report.positionBytes;
      state.writePositionBytes = report.writePositionBytes;
      state.playing = report.playing;
    }
  }

  private command(id: number, op: AudioOp): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.revision = ++this.revision;
    this.post({ type: 'audio', op, revision: state.revision });
    return true;
  }

  createBuffer(id: number, byteLength: number, format: PcmWaveFormat): void {
    this.buffers.set(id, {
      revision: 0,
      byteLength,
      format: normalizePcmWaveFormat(format),
      positionBytes: 0,
      writePositionBytes: 0,
      playing: false,
    });
    this.command(id, { op: 'createBuffer', id, byteLength, format });
  }

  duplicateBuffer(sourceId: number, destinationId: number): boolean {
    const source = this.buffers.get(sourceId);
    if (!source) return false;
    this.buffers.set(destinationId, { ...source, positionBytes: 0, writePositionBytes: 0, playing: false });
    return this.command(destinationId, { op: 'duplicateBuffer', sourceId, destinationId });
  }

  setFormat(id: number, format: PcmWaveFormat): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.format = normalizePcmWaveFormat(format);
    return this.command(id, { op: 'setFormat', id, format });
  }

  writeBuffer(id: number, offset: number, bytes: Uint8Array): number {
    const state = this.buffers.get(id);
    if (!state) return 0;
    const start = Math.max(0, Math.min(Math.trunc(offset), state.byteLength));
    const length = Math.min(bytes.byteLength, state.byteLength - start);
    if (!length) return 0;
    // The caller retains its memory, even when its view spans the entire buffer.
    const snapshot = bytes.slice(0, length);
    this.post({ type: 'audio', op: { op: 'writeBuffer', id, offset: start, bytes: snapshot } }, [snapshot.buffer]);
    return length;
  }

  play(id: number, options: PcmPlayOptions = {}): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    if (options.fromByte !== undefined) this.position(state, options.fromByte);
    if (state.positionBytes >= state.byteLength) this.position(state, 0);
    state.playing = true;
    return this.command(id, { op: 'play', id, options });
  }

  stop(id: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.playing = false;
    state.writePositionBytes = state.positionBytes;
    return this.command(id, { op: 'stop', id });
  }

  setCurrentPosition(id: number, byteOffset: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    this.position(state, byteOffset);
    return this.command(id, { op: 'setCurrentPosition', id, byteOffset });
  }

  private position(state: BufferState, byteOffset: number): void {
    const align = state.format.nBlockAlign;
    state.positionBytes = Math.floor(Math.max(0, Math.min(byteOffset, state.byteLength)) / align) * align;
    state.writePositionBytes = state.positionBytes;
  }

  setVolume(id: number, volume: number): boolean {
    if (!this.buffers.has(id)) return false;
    this.post({ type: 'audio', op: { op: 'setVolume', id, volume } });
    return true;
  }
  setPan(id: number, pan: number): boolean {
    if (!this.buffers.has(id)) return false;
    this.post({ type: 'audio', op: { op: 'setPan', id, pan } });
    return true;
  }
  setFrequency(id: number, frequency: number): boolean {
    return this.command(id, { op: 'setFrequency', id, frequency });
  }
  getState(id: number): { positionBytes: number; writePositionBytes: number; playing: boolean } | null {
    const state = this.buffers.get(id);
    return state
      ? { positionBytes: state.positionBytes, writePositionBytes: state.writePositionBytes, playing: state.playing }
      : null;
  }
  releaseBuffer(id: number): boolean {
    if (!this.buffers.delete(id)) return false;
    this.post({ type: 'audio', op: { op: 'releaseBuffer', id }, revision: ++this.revision });
    return true;
  }
  setMasterVolume(linear: number): void {
    this.post({ type: 'audio-control', action: 'master-volume', linear });
  }
  stopAll(): void {
    for (const id of this.buffers.keys()) this.stop(id);
  }
  async destroy(): Promise<void> {
    this.buffers.clear();
    this.post({ type: 'audio-control', action: 'destroy' });
  }
}
