/**
 * Migrated audio smoke tests: WAVEFORMATEX parsing, DirectSound volume/pan conversion, and the event sequence from the DirectSound COM bridge (CreateSoundBuffer/Lock/Unlock/Play) to Win32AudioSink.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  directSoundPanToStereo,
  directSoundVolumeToGain,
  parsePcmWaveFormatEx,
  WebAudioPcmSink,
  type PcmWaveFormat,
} from '../../src/adapter/audio';
import type { Win32AudioSink } from '../../src/vm86/win32';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';

const waveFormat = Uint8Array.from([
  0xff,
  0xff, // Leading padding verifies the offset
  0x01,
  0x00, // WAVE_FORMAT_PCM
  0x02,
  0x00, // stereo
  0x22,
  0x56,
  0x00,
  0x00, // 22050 Hz
  0x88,
  0x58,
  0x01,
  0x00, // 88200 bytes/s
  0x04,
  0x00, // block align
  0x10,
  0x00, // 16 bit
  0x00,
  0x00, // cbSize
]);

describe('WAVEFORMATEX 与音量/声像换算（原 audioSmoke）', () => {
  it('parsePcmWaveFormatEx 按 offset 解析 PCM 格式头', () => {
    expect(parsePcmWaveFormatEx(waveFormat, 2)).toEqual({
      wFormatTag: 1,
      nChannels: 2,
      nSamplesPerSec: 22_050,
      nAvgBytesPerSec: 88_200,
      nBlockAlign: 4,
      wBitsPerSample: 16,
      cbSize: 0,
    });
  });

  it('DirectSound 音量（百分之一 dB）转线性 gain', () => {
    expect(directSoundVolumeToGain(0)).toBe(1);
    expect(directSoundVolumeToGain(-10_000)).toBe(0);
    expect(Math.abs(directSoundVolumeToGain(-600) - 0.501187) < 0.000001).toBeTruthy();
  });

  it('DirectSound 声像转 -1..1', () => {
    expect(directSoundPanToStereo(-10_000)).toBe(-1);
    expect(directSoundPanToStereo(2_500)).toBe(0.25);
    expect(directSoundPanToStereo(10_000)).toBe(1);
  });
});

describe('DirectSound COM 桥（原 audioSmoke）', () => {
  it('CreateSoundBuffer/Lock/Unlock/Play 全流程驱动 Win32AudioSink', () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const audioEvents: string[] = [];
    let createdFormat: PcmWaveFormat | null = null;
    let writtenPcm = new Uint8Array();
    let playing = false;
    const audio: Win32AudioSink = {
      createBuffer(_id, size, format) {
        audioEvents.push(`create:${size}`);
        createdFormat = { ...format };
      },
      duplicateBuffer() {
        return true;
      },
      setFormat() {
        return true;
      },
      writeBuffer(_id, offset, bytes) {
        audioEvents.push(`write:${offset}:${bytes.length}`);
        writtenPcm = bytes.slice();
        return bytes.length;
      },
      play(_id, options) {
        playing = true;
        audioEvents.push(`play:${options?.loop ? 1 : 0}`);
        return true;
      },
      stop() {
        return true;
      },
      setCurrentPosition() {
        return true;
      },
      setVolume() {
        return true;
      },
      setPan() {
        return true;
      },
      setFrequency() {
        return true;
      },
      getState() {
        return { positionBytes: 0, playing };
      },
      releaseBuffer() {
        return true;
      },
    };
    const shim = createTestShim(memory, { firstDynamicId: 1, audio });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const desc = 0x1000;
    const formatPtr = 0x1100;
    const objectOut = 0x1200;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    writeU32(memory, desc, 20);
    writeU32(memory, desc + 8, 6);
    writeU32(memory, desc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, desc, objectOut, 0]).eax).toBe(0);
    const object = readU32(memory, objectOut);
    expect(object).toBeTruthy();
    // createdFormat is assigned inside the sink closure, but TS control flow still narrows it to its initial null; explicitly restore its declared type.
    expect((createdFormat as PcmWaveFormat | null)?.nSamplesPerSec).toBe(22_050);

    const pointerOut = 0x1210;
    const bytesOut = 0x1214;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Lock', [object, 0, 6, pointerOut, bytesOut, 0, 0, 0]).eax).toBe(
      0,
    );
    const pcm = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    memory.write_memory(pcm, readU32(memory, pointerOut));
    expect(
      dispatchSound('DSOUND.COM!IDirectSoundBuffer.Unlock', [
        object,
        readU32(memory, pointerOut),
        readU32(memory, bytesOut),
        0,
        0,
      ]).eax,
    ).toBe(0);
    expect(writtenPcm).toEqual(pcm);
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Play', [object, 0, 0, 1]).eax).toBe(0);
    expect(readU32(memory, object + 12)).toBe(0); // Force the first cursor query back to the host after the state change
    const cursorOut = 0x1220;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [object, cursorOut, 0]).eax).toBe(0);
    expect(readU32(memory, object + 8)).toBe(readU32(memory, cursorOut));
    expect(readU32(memory, object + 12)).toBe(1023);
    const vtable = readU32(memory, object);
    const getCurrentPositionStub = readU32(memory, vtable + 4 * 4);
    expect(memory.read_memory(getCurrentPositionStub, 4)).toEqual(new Uint8Array([0x8b, 0x4c, 0x24, 0x04]));
    expect(audioEvents).toEqual(['create:6', 'write:0:6', 'play:1']);
  });
});

/** Headless sink with no playback observations; exercises the explicit clock fallback. */
const createHeadlessAudio = (): Win32AudioSink => ({
  createBuffer() {},
  duplicateBuffer() {
    return true;
  },
  setFormat() {
    return true;
  },
  writeBuffer(_id, _offset, bytes) {
    return bytes.length;
  },
  play() {
    return true;
  },
  stop() {
    return true;
  },
  setCurrentPosition() {
    return true;
  },
  setVolume() {
    return true;
  },
  setPan() {
    return true;
  },
  setFrequency() {
    return true;
  },
  getState() {
    return null;
  },
  releaseBuffer() {
    return true;
  },
});

describe('DirectSound 流式音乐（RA2 增补，原 audioSmoke）', () => {
  // Streaming music regression: after Unlock overwrites a playing DirectSound ring buffer,
  // switch to a single live reader; do not keep looping the first snapshot or recreate the source for every write.
  it('环形 buffer 首次动态覆写后切到实时 PCM 流且保持连续游标', () => {
    class FakeAudioBuffer {
      readonly duration: number;
      private readonly channels: Float32Array[];
      readonly numberOfChannels: number;
      readonly length: number;
      constructor(
        channelCount: number,
        frameCount: number,
        readonly sampleRate: number,
      ) {
        this.numberOfChannels = channelCount;
        this.length = frameCount;
        this.duration = frameCount / sampleRate;
        this.channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
      }
      getChannelData(channel: number): Float32Array {
        return this.channels[channel]!;
      }
    }
    class FakeAudioParam {
      value = 0;
      setValueAtTime(value: number): void {
        this.value = value;
      }
      linearRampToValueAtTime(value: number): void {
        this.value = value;
      }
    }
    class FakeNode {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }
    class FakeSource extends FakeNode {
      buffer: FakeAudioBuffer | null = null;
      loop = false;
      playbackRate = new FakeAudioParam();
      onended: (() => void) | null = null;
      startedWhen = -1;
      startedOffset = -1;
      stopped = false;
      stoppedWhen = -1;
      start(when: number, offset: number): void {
        this.startedWhen = when;
        this.startedOffset = offset;
      }
      stop(when = 0): void {
        this.stopped = true;
        this.stoppedWhen = when;
      }
    }
    class FakeProcessor extends FakeNode {
      onaudioprocess: ((event: { outputBuffer: FakeAudioBuffer }) => void) | null = null;
      constructor(
        private readonly frames: number,
        private readonly channels: number,
      ) {
        super();
      }
      process(): FakeAudioBuffer {
        const output = new FakeAudioBuffer(this.channels, this.frames, 22_050);
        this.onaudioprocess?.({ outputBuffer: output });
        return output;
      }
    }
    class FakeAudioContext {
      currentTime = 0;
      sampleRate = 22_050;
      state = 'running';
      destination = new FakeNode();
      readonly sources: FakeSource[] = [];
      readonly processors: FakeProcessor[] = [];
      createBuffer(channels: number, frames: number, rate: number): FakeAudioBuffer {
        return new FakeAudioBuffer(channels, frames, rate);
      }
      createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
      }
      createScriptProcessor(frames: number, _inputs: number, channels: number): FakeProcessor {
        const processor = new FakeProcessor(frames, channels);
        this.processors.push(processor);
        return processor;
      }
      createGain(): FakeNode & { gain: FakeAudioParam } {
        return Object.assign(new FakeNode(), { gain: new FakeAudioParam() });
      }
      createStereoPanner(): FakeNode & { pan: FakeAudioParam } {
        return Object.assign(new FakeNode(), { pan: new FakeAudioParam() });
      }
    }
    const fakeContext = new FakeAudioContext();
    const streamingSink = new WebAudioPcmSink({
      contextFactory: () => fakeContext as unknown as AudioContext,
    });
    streamingSink.createBuffer('music', 88_200, {
      wFormatTag: 1,
      nChannels: 2,
      nSamplesPerSec: 22_050,
      nAvgBytesPerSec: 88_200,
      nBlockAlign: 4,
      wBitsPerSample: 16,
      cbSize: 0,
    });
    streamingSink.writeBuffer('music', 0, new Uint8Array(88_200));
    expect(streamingSink.play('music', { loop: true })).toBe(true);
    expect(fakeContext.sources.length).toBe(1);
    fakeContext.currentTime = 0.25;
    const firstSource = fakeContext.sources[0]!;
    // 0.25 seconds is near frame 5512; write full-scale left-channel samples, which the live callback must read from its first frame.
    streamingSink.writeBuffer('music', 5_512 * 4, Uint8Array.from([0xff, 0x7f, 0, 0]));
    expect(firstSource.stopped).toBe(true);
    expect(fakeContext.sources.length).toBe(1);
    expect(fakeContext.processors.length).toBe(1);
    const output = fakeContext.processors[0]!.process();
    expect(output.getChannelData(0)[0]).toBeGreaterThan(0.99);
    expect(output.getChannelData(1)[0]).toBe(0);
    // Subsequent Unlock calls only update PCM; they do not create a new source/processor.
    streamingSink.writeBuffer('music', 30_000, Uint8Array.from([1, 2, 3, 4]));
    expect(fakeContext.sources.length).toBe(1);
    expect(fakeContext.processors.length).toBe(1);
    expect(streamingSink.getState('music')!.positionBytes).toBeGreaterThan(5_512 * 4);
    expect(streamingSink.getState('music')?.playing).toBe(true);
  });

  // DSBLOCK_ENTIREBUFFER with dwBytes=0 must still return the entire buffer.
  it('Lock 带 DSBLOCK_ENTIREBUFFER 且 dwBytes=0 时返回完整缓冲区', () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const shim = createTestShim(memory, { firstDynamicId: 1, audio: createHeadlessAudio() });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const desc = 0x1000;
    const formatPtr = 0x1100;
    const objectOut = 0x1200;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    writeU32(memory, desc, 20);
    writeU32(memory, desc + 8, 6);
    writeU32(memory, desc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, desc, objectOut, 0]).eax).toBe(0);
    const object = readU32(memory, objectOut);
    expect(object).toBeTruthy();

    const entirePointerOut = 0x1220;
    const entireBytesOut = 0x1224;
    expect(
      dispatchSound('DSOUND.COM!IDirectSoundBuffer.Lock', [object, 0, 0, entirePointerOut, entireBytesOut, 0, 0, 2])
        .eax,
    ).toBe(0);
    expect(readU32(memory, entirePointerOut) !== 0).toBe(true);
    expect(readU32(memory, entireBytesOut)).toBe(6);
  });

  // Headless output has no audio clock; retain an explicit fallback for asset-free execution.
  it('advances the headless fallback when the sink provides no playback observations', async () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const shim = createTestShim(memory, { firstDynamicId: 1, audio: createHeadlessAudio() });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const formatPtr = 0x1100;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    const streamDesc = 0x1240;
    const streamOut = 0x1260;
    writeU32(memory, streamDesc, 20);
    writeU32(memory, streamDesc + 8, 88_200);
    writeU32(memory, streamDesc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, streamDesc, streamOut, 0]).eax).toBe(0);
    const streamObject = readU32(memory, streamOut);
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Play', [streamObject, 0, 0, 1]).eax).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cursorOut = 0x1270;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [streamObject, cursorOut, 0]).eax).toBe(0);
    expect(readU32(memory, cursorOut), 'Headless DirectSound fallback cursor did not advance').toBeGreaterThan(0);
  });

  // Preferred AudioWorklet path: render live streams off the main thread and synchronize written ranges through the port.
  it('支持 AudioWorklet 时实时流走 worklet 节点并同步写入区间', async () => {
    class FakeAudioParam {
      value = 0;
      setValueAtTime(value: number): void {
        this.value = value;
      }
    }
    class FakeNode {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }
    class FakeSource extends FakeNode {
      buffer: unknown = null;
      loop = false;
      playbackRate = new FakeAudioParam();
      onended: (() => void) | null = null;
      stopped = false;
      start(): void {}
      stop(): void {
        this.stopped = true;
      }
    }
    const posted: Array<Record<string, unknown>> = [];
    const workletNodes: FakeWorkletNode[] = [];
    class FakeWorkletNode extends FakeNode {
      readonly port: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: Record<string, unknown>) => void;
      } = {
        onmessage: null,
        postMessage: (message) => {
          posted.push(message);
        },
      };
      constructor() {
        super();
        workletNodes.push(this);
      }
    }
    class FakeWorkletContext extends FakeNode {
      currentTime = 0;
      sampleRate = 22_050;
      state = 'running';
      destination = new FakeNode();
      readonly audioWorklet = { addModule: () => Promise.resolve() };
      readonly sources: FakeSource[] = [];
      createBuffer(_channels: number, frames: number): { duration: number; getChannelData: () => Float32Array } {
        return { duration: frames / this.sampleRate, getChannelData: () => new Float32Array(frames) };
      }
      createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
      }
      createGain(): FakeNode & { gain: FakeAudioParam } {
        return Object.assign(new FakeNode(), { gain: new FakeAudioParam() });
      }
      createStereoPanner(): FakeNode & { pan: FakeAudioParam } {
        return Object.assign(new FakeNode(), { pan: new FakeAudioParam() });
      }
    }
    const fakeContext = new FakeWorkletContext();
    (globalThis as Record<string, unknown>).AudioWorkletNode = FakeWorkletNode;
    try {
      const sink = new WebAudioPcmSink({
        contextFactory: () => fakeContext as unknown as AudioContext,
      });
      sink.createBuffer('music', 88_200, {
        wFormatTag: 1,
        nChannels: 2,
        nSamplesPerSec: 22_050,
        nAvgBytesPerSec: 88_200,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
      });
      sink.writeBuffer('music', 0, new Uint8Array(88_200));
      expect(sink.play('music', { loop: true })).toBe(true);
      // The second write during playback triggers the live-stream switch (stop the old source; let the worklet take over).
      sink.writeBuffer('music', 5_512 * 4, Uint8Array.from([0xff, 0x7f, 0, 0]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workletNodes.length).toBe(1);
      const create = posted.find((message) => message.kind === 'create')!;
      expect(create).toBeTruthy();
      expect(create.frames).toBe(88_200 / 4);
      expect(create.frequency).toBe(22_050);
      expect(create.loop).toBe(true);
      // Initial full mirror synchronization: 88,200 bytes = 22,050 frames x 2 channels.
      const initialUpdate = posted.find((message) => message.kind === 'update')!;
      expect((initialUpdate.data as Float32Array).length).toBe(44_100);
      expect(initialUpdate.offsetFrames).toBe(0);
      // Subsequent writes use incremental updates.
      posted.length = 0;
      sink.writeBuffer('music', 30_000, Uint8Array.from([1, 2, 3, 4]));
      const update = posted.find((message) => message.kind === 'update')!;
      expect(update.offsetFrames).toBe(7_500);
      expect((update.data as Float32Array).length).toBe(2);
      // Cursor reports: after the worklet reports a frame, the main thread extrapolates using currentTime.
      const worklet = workletNodes[0]!;
      const frameMessage = { kind: 'position', frame: 10_000, at: 1, revision: 0 };
      // Delivery is delayed by main-thread work; the cursor still belongs to audio time 1.
      fakeContext.currentTime = 1.2;
      worklet.port.onmessage?.({ data: frameMessage } as unknown as MessageEvent);
      fakeContext.currentTime = 1.5;
      // 10,000 + 0.5 s x 22050 = 21,025 frames -> x 4 bytes.
      expect(sink.getState('music')!.positionBytes).toBe(21_025 * 4);
      sink.setCurrentPosition('music', 400);
      worklet.port.onmessage?.({ data: frameMessage } as unknown as MessageEvent);
      expect(sink.getState('music')!.positionBytes).toBe(400);
      fakeContext.currentTime = 1.75;
      const beforeRateChange = sink.getState('music')!.positionBytes;
      sink.setFrequency('music', 11_025);
      expect(sink.getState('music')!.positionBytes).toBe(beforeRateChange);
      worklet.port.onmessage?.({
        data: { kind: 'position', frame: 999, at: 1.7, revision: 1 },
      } as unknown as MessageEvent);
      expect(sink.getState('music')!.positionBytes).toBe(beforeRateChange);
      fakeContext.currentTime = 2.75;
      expect(sink.getState('music')!.positionBytes).toBe((beforeRateChange + 11_025 * 4) % 88_200);
      // A report can describe the next quantum boundary; never extrapolate backwards.
      worklet.port.onmessage?.({
        data: { kind: 'position', frame: 500, at: 2.751, revision: 2 },
      } as unknown as MessageEvent);
      expect(sink.getState('music')!.positionBytes).toBe(2_000);
      worklet.port.onmessage?.({
        data: { kind: 'position', frame: 22_050, at: 2.75, revision: 1, playing: false },
      } as unknown as MessageEvent);
      expect(sink.getState('music')!.playing).toBe(true);
      worklet.port.onmessage?.({
        data: { kind: 'position', frame: 22_050, at: 2.75, revision: 2, playing: false },
      } as unknown as MessageEvent);
      expect(sink.getState('music')).toMatchObject({ playing: false, positionBytes: 0 });
      expect(worklet.port.onmessage).toBeNull();
      expect(sink.play('music', { loop: true })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fakeContext.sources).toHaveLength(2);
      expect(fakeContext.sources[1]!.stopped).toBe(false);
      expect(sink.getState('music')!.playing).toBe(true);
      Object.assign(fakeContext, { getOutputTimestamp: () => ({ contextTime: 2.85 }) });
      fakeContext.currentTime = 2.95;
      const cursors = sink.getState('music')!;
      expect(cursors.writePositionBytes).toBeGreaterThan(cursors.positionBytes);
      expect(cursors.writePositionBytes - cursors.positionBytes).toBeCloseTo(1102.5 * 4, -1);
      expect(sink.getState('music')).toEqual(cursors);
      // stop tears down the worklet and sends destroy.
      sink.stop('music');
      expect(posted.some((message) => message.kind === 'destroy')).toBe(true);
      expect(workletNodes[0]!.port.onmessage).toBeNull();
    } finally {
      delete (globalThis as Record<string, unknown>).AudioWorkletNode;
    }
  });
});

describe('PCM 流 worklet 处理器生命周期', () => {
  /** Load the worklet module with AudioWorklet globals stubbed, returning the registered processor class. */
  async function loadProcessor(): Promise<
    new () => {
      port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
      process: (inputs: unknown, outputs: Float32Array[][]) => boolean;
    }
  > {
    const globals = globalThis as unknown as Record<string, unknown>;
    let registered: unknown = null;
    globals.AudioWorkletProcessor = class {
      readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: () => {} };
    };
    globals.registerProcessor = (_name: string, processor: unknown) => {
      registered = processor;
    };
    globals.sampleRate = 48_000;
    globals.currentTime = 0;
    vi.resetModules();
    // Plain JS worklet source with no declarations; it is loaded for its registerProcessor side effect only.
    // @ts-expect-error -- untyped module
    await import('../../src/adapter/pcmStreamWorklet.js');
    return registered as never;
  }

  it.each([4, 128])('reports non-looping completion within the final quantum (%i frames)', async (frames) => {
    const Processor = await loadProcessor();
    const processor = new Processor();
    const report = vi.fn();
    processor.port.postMessage = report;
    processor.port.onmessage?.({
      data: { kind: 'create', channels: 1, frames, frequency: 48_000, loop: false, frame: 0, revision: 3 },
    });
    processor.port.onmessage?.({ data: { kind: 'update', offsetFrames: 0, data: new Float32Array(frames).fill(0.5) } });
    const output = new Float32Array(128);
    processor.process(null, [[output]]);
    expect(Array.from(output.slice(0, frames))).toEqual(Array(frames).fill(0.5));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ playing: false, frame: frames, revision: 3 }));
    processor.process(null, [[output]]);
    expect(output.every((value) => value === 0)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    processor.port.onmessage?.({ data: { kind: 'destroy' } });
  });

  it('destroy 后 process 返回 false，浏览器才能回收已断开的节点', async () => {
    const Processor = await loadProcessor();
    const processor = new Processor();
    const outputs = [[new Float32Array(128)]];
    processor.port.onmessage?.({
      data: { kind: 'create', channels: 1, frames: 4, frequency: 48_000, loop: true, frame: 0 },
    });
    const reports: Array<{ at: number; frame: number; revision: number }> = [];
    processor.port.postMessage = (message) => reports.push(message as (typeof reports)[number]);
    processor.port.onmessage?.({
      data: { kind: 'update', offsetFrames: 0, data: new Float32Array([0, 0.25, 0.5, 0.75]) },
    });
    processor.port.onmessage?.({ data: { kind: 'set-position', frame: 1, revision: 1 } });
    (globalThis as unknown as Record<string, unknown>).currentTime = 0.2;
    expect(processor.process(null, outputs)).toBe(true);
    expect(Array.from(outputs[0]![0]!.slice(0, 8))).toEqual([0.25, 0.5, 0.75, 0, 0.25, 0.5, 0.75, 0]);
    expect(reports[0]).toMatchObject({ at: 0.2 + 128 / 48_000, frame: 1, revision: 1 });
    // A live stream keeps rendering; only destroy ends processing. Returning true after destroy leaks the node's
    // per-quantum work onto the audio thread for the whole session, which silences the game over a long match.
    expect(processor.process(null, outputs)).toBe(true);
    processor.port.onmessage?.({ data: { kind: 'destroy' } });
    expect(processor.process(null, outputs)).toBe(false);
  });
});
