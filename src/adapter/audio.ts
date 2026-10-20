/**
 * WebAudio output layer for DirectSound guest PCM buffers.
 *
 * This module does not depend on the Win32 shim: the shim translates CreateSoundBuffer/Lock/Unlock/Play and similar calls into the corresponding operations while retaining ownership of guest memory.
 */
import { DEFAULT_PCM_FORMAT, normalizePcmWaveFormat, type PcmPlayOptions, type PcmWaveFormat } from '../vm86/audio';
export { DEFAULT_PCM_FORMAT, normalizePcmWaveFormat, parsePcmWaveFormatEx } from '../vm86/audio';
export type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';

export type PcmBufferId = number | string;

/**
 * Frames per output quantum for the live ring stream's ScriptProcessor fallback: 4096 gives about 85-93ms of buffering.
 * This callback runs on the main thread; the normal path uses AudioWorklet on the audio thread (see pcmStreamWorklet.js). Only browsers lacking AudioWorklet use this fallback.
 */
const STREAM_PROCESSOR_FRAMES = 4_096;

/** Registration name used by pcmStreamWorklet.js. */
const PCM_STREAM_WORKLET_NAME = 'ra2-pcm-stream';

/** AudioWorklet module cache: share one addModule call per context and allow retries after failure. */
const workletModules = new WeakMap<AudioContext, Promise<void>>();
function loadPcmStreamWorklet(context: AudioContext): Promise<void> {
  let pending = workletModules.get(context);
  if (!pending) {
    // Processor registration belongs to one context; a later session has a new audio-thread global scope.
    pending = context.audioWorklet.addModule(new URL('./pcmStreamWorklet.js', import.meta.url)).catch((error) => {
      workletModules.delete(context);
      throw error;
    });
    workletModules.set(context, pending);
  }
  return pending;
}

export interface PcmBufferSnapshot {
  byteLength: number;
  positionBytes: number;
  writePositionBytes: number;
  playing: boolean;
  loop: boolean;
  /** DirectSound volume in hundredths of a dB, -10000..0. */
  volume: number;
  /** DirectSound pan, -10000..10000. */
  pan: number;
  /** Actual requested playback frequency in Hz. */
  frequency: number;
  format: PcmWaveFormat;
}

export interface WebAudioPcmSinkOptions {
  /** Supports tests or output into an existing AudioContext. */
  contextFactory?: () => AudioContext;
  /** Connect to context.destination by default. */
  destination?: (context: AudioContext) => AudioNode;
  onError?: (error: unknown) => void;
  /** Development diagnostics: log sink state and guest audio activity at this interval, plus every AudioContext state change. */
  diagnosticsIntervalMs?: number;
}

interface PcmBufferState {
  format: PcmWaveFormat;
  pcm: Uint8Array;
  decoded: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  /** DirectSound ring stream that Lock/Unlock may overwrite during playback (fallback path). */
  stream: ScriptProcessorNode | null;
  /** Preferred live-stream path: AudioWorklet rendering on the audio thread. */
  worklet: AudioWorkletNode | null;
  streamFrame: number;
  /** Context time of the latest worklet position message, used as the cursor extrapolation baseline. */
  workletPositionAt: number;
  /** Reject cursor reports queued before a seek or frequency change. */
  workletRevision: number;
  gain: GainNode | null;
  panner: StereoPannerNode | null;
  positionBytes: number;
  startedAt: number;
  startedFrame: number;
  playing: boolean;
  loop: boolean;
  volume: number;
  pan: number;
  frequency: number;
}

/** Convert DirectSound volume in hundredths of a dB to linear WebAudio gain. */
export function directSoundVolumeToGain(volume: number): number {
  const clamped = clamp(Math.trunc(volume), -10_000, 0);
  return clamped === -10_000 ? 0 : 10 ** (clamped / 2_000);
}

/** Convert DirectSound pan to StereoPannerNode's -1..1 range. */
export function directSoundPanToStereo(pan: number): number {
  return clamp(Math.trunc(pan), -10_000, 10_000) / 10_000;
}

/**
 * Play static DirectSound buffers through WebAudio.
 *
 * AudioContext is created lazily. Call installUserGestureUnlock at page startup; Play calls preceding a user gesture retain their playing state and become audible after unlocking.
 */
/**
 * Initial linear master gain: a 50% slider gives squared gain (0.5)^2. These two constants derive slider percentage and linear gain from one another, avoiding duplicate literals in the page, toolbar, and Worker configuration.
 */
/** Development builds log audio diagnostics every 30s; production and tests leave them off. */
export const AUDIO_DIAGNOSTICS_INTERVAL_MS =
  import.meta.env.DEV && import.meta.env.MODE !== 'test' ? 30_000 : undefined;

export const DEFAULT_MASTER_VOLUME = 0.25;
/** Slider percentage (0..100) equivalent to DEFAULT_MASTER_VOLUME. */
export const DEFAULT_VOLUME_PERCENT = Math.round(Math.sqrt(DEFAULT_MASTER_VOLUME) * 100);

export class WebAudioPcmSink {
  private readonly buffers = new Map<PcmBufferId, PcmBufferState>();
  private context: AudioContext | null = null;
  private destroyed = false;
  private masterGain: GainNode | null = null;
  /** Linear master gain 0..1, applied after all buffers and before the destination. */
  private masterVolume = DEFAULT_MASTER_VOLUME;

  /** Guest activity since the last diagnostics line; only maintained when diagnostics are enabled. */
  private readonly activity = { plays: 0, stops: 0, writes: 0, writeBytes: 0, errors: 0, lastError: '' };
  private diagnosticsTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private lastDiagnosticsContextTime: number | null = null;
  /** Last processor count reported by the audio thread; grows without bound if disconnected nodes are never collected. */
  private liveWorkletProcessors = 0;

  constructor(private readonly options: WebAudioPcmSinkOptions = {}) {
    if (options.diagnosticsIntervalMs) {
      this.diagnosticsTimer = globalThis.setInterval(() => this.logDiagnostics(), options.diagnosticsIntervalMs);
    }
  }

  createBuffer(id: PcmBufferId, byteLength: number, format: PcmWaveFormat = DEFAULT_PCM_FORMAT as PcmWaveFormat): void {
    this.assertAlive();
    this.releaseBuffer(id);
    const normalized = normalizePcmWaveFormat(format);
    const size = clamp(Math.trunc(byteLength), 0, 64 * 1024 * 1024);
    this.buffers.set(id, {
      format: normalized,
      pcm: new Uint8Array(size),
      decoded: null,
      source: null,
      stream: null,
      worklet: null,
      streamFrame: 0,
      workletPositionAt: 0,
      workletRevision: 0,
      gain: null,
      panner: null,
      positionBytes: 0,
      startedAt: 0,
      startedFrame: 0,
      playing: false,
      loop: false,
      volume: 0,
      pan: 0,
      frequency: normalized.nSamplesPerSec,
    });
  }

  duplicateBuffer(sourceId: PcmBufferId, destinationId: PcmBufferId): boolean {
    const source = this.buffers.get(sourceId);
    if (!source) return false;
    this.createBuffer(destinationId, source.pcm.byteLength, source.format);
    const destination = this.buffers.get(destinationId)!;
    destination.pcm.set(source.pcm);
    destination.volume = source.volume;
    destination.pan = source.pan;
    destination.frequency = source.frequency;
    return true;
  }

  setFormat(id: PcmBufferId, format: PcmWaveFormat): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    const position = this.currentPosition(state);
    this.detachPlayback(state);
    state.format = normalizePcmWaveFormat(format);
    state.frequency = state.format.nSamplesPerSec;
    state.positionBytes = alignPosition(position, state);
    state.decoded = null;
    if (wasPlaying) this.start(state);
    return true;
  }

  /** Write the guest PCM snapshot obtained by Unlock into the mirrored buffer. */
  writeBuffer(id: PcmBufferId, offset: number, bytes: Uint8Array): number {
    this.activity.writes++;
    this.activity.writeBytes += bytes.byteLength;
    const state = this.buffers.get(id);
    if (!state || bytes.byteLength === 0) return 0;
    const start = clamp(Math.trunc(offset), 0, state.pcm.byteLength);
    const length = Math.min(bytes.byteLength, state.pcm.byteLength - start);
    if (length <= 0) return 0;

    // RA2/Bink continually overwrites the DirectSound ring buffer during DSBPLAY_LOOPING playback.
    // AudioBufferSourceNode plays only its creation-time snapshot; rebuilding the source on every Unlock
    // repeatedly rewound playback and accumulated WebAudio nodes, potentially overwhelming the renderer. On the first dynamic overwrite,
    // switch to one live ring player; subsequent writes update only the PCM mirror without resetting the playback cursor.
    const switchToLiveStream = state.playing && state.loop && state.source !== null;
    state.pcm.set(bytes.subarray(0, length), start);
    state.decoded = null;
    if (switchToLiveStream) this.startLiveStream(state);
    // Worklet path: synchronize the written range with the audio-thread renderer immediately.
    if (state.worklet && state.playing) {
      this.postWorkletUpdate(state, state.worklet, start, bytes.subarray(0, length));
    }
    return length;
  }

  play(id: PcmBufferId, options: PcmPlayOptions = {}): boolean {
    this.activity.plays++;
    const state = this.buffers.get(id);
    if (!state) return false;
    state.loop = options.loop ?? false;
    if (state.playing && (state.source || state.stream || state.worklet) && options.fromByte === undefined) {
      // IDirectSoundBuffer::Play does not restart an already playing buffer from the beginning.
      if (state.source) state.source.loop = state.loop;
      if (state.worklet) {
        // A non-looping stream stops internally at its end; another Play must resume audible playback.
        this.postWorkletMessage(state, { kind: 'play' });
        this.postWorkletMessage(state, { kind: 'set-loop', loop: state.loop });
      }
      return true;
    }
    if (options.fromByte !== undefined) state.positionBytes = alignPosition(options.fromByte, state);
    if (state.positionBytes >= state.pcm.byteLength) state.positionBytes = 0;
    state.playing = true;
    this.detachPlayback(state, false);
    this.start(state);
    return true;
  }

  stop(id: PcmBufferId): boolean {
    this.activity.stops++;
    const state = this.buffers.get(id);
    if (!state) return false;
    state.positionBytes = this.currentPosition(state);
    state.playing = false;
    this.detachPlayback(state, false);
    return true;
  }

  setCurrentPosition(id: PcmBufferId, byteOffset: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    state.positionBytes = alignPosition(byteOffset, state);
    state.streamFrame = bytePositionToFrame(state.positionBytes, state);
    if (this.context) state.startedAt = this.context.currentTime;
    if (state.worklet) {
      this.postWorkletMessage(state, {
        kind: 'set-position',
        frame: state.streamFrame,
        revision: ++state.workletRevision,
      });
      if (this.context) state.workletPositionAt = this.context.currentTime;
    } else if (wasPlaying && !state.stream) {
      this.detachPlayback(state, false);
      this.start(state);
    }
    return true;
  }

  setVolume(id: PcmBufferId, volume: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.volume = clamp(Math.trunc(volume), -10_000, 0);
    if (state.gain && this.context) {
      state.gain.gain.setValueAtTime(directSoundVolumeToGain(state.volume), this.context.currentTime);
    }
    return true;
  }

  setPan(id: PcmBufferId, pan: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.pan = clamp(Math.trunc(pan), -10_000, 10_000);
    if (state.panner && this.context) {
      state.panner.pan.setValueAtTime(directSoundPanToStereo(state.pan), this.context.currentTime);
    }
    return true;
  }

  /** Master volume: linear gain for the entire sink (0=mute, 1=full). May be set before a user gesture; takes effect when nodes are created lazily. */
  setMasterVolume(linear: number): void {
    this.masterVolume = clamp(linear, 0, 1);
    if (this.masterGain && this.context) {
      this.masterGain.gain.setValueAtTime(this.masterVolume, this.context.currentTime);
    }
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setFrequency(id: PcmBufferId, frequency: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    const position = this.currentPosition(state);
    const liveStream = state.stream !== null || state.worklet !== null;
    if (!liveStream) this.detachPlayback(state, false);
    // DSBFREQUENCY_ORIGINAL = 0。
    state.frequency = frequency === 0 ? state.format.nSamplesPerSec : clamp(Math.trunc(frequency), 100, 200_000);
    state.positionBytes = position;
    if (wasPlaying && !liveStream) this.start(state);
    if (state.worklet) {
      state.streamFrame = bytePositionToFrame(position, state);
      if (this.context) state.workletPositionAt = this.context.currentTime;
      this.postWorkletMessage(state, {
        kind: 'set-frequency',
        frequency: state.frequency,
        revision: ++state.workletRevision,
      });
    }
    return true;
  }

  getState(id: PcmBufferId): PcmBufferSnapshot | null {
    const state = this.buffers.get(id);
    if (!state) return null;
    const writePositionBytes = this.currentPosition(state);
    // Web Audio currentTime is the next render boundary. The output timestamp
    // identifies samples reaching the device, behind the already committed audio.
    const timestamp = this.context?.getOutputTimestamp?.().contextTime;
    const latency = (this.context?.baseLatency ?? 0) + (this.context?.outputLatency ?? 0);
    const outputTime = Number.isFinite(timestamp)
      ? timestamp
      : this.context && latency > 0
        ? Math.max(0, this.context.currentTime - latency)
        : undefined;
    return {
      byteLength: state.pcm.byteLength,
      positionBytes: this.currentPosition(state, outputTime),
      writePositionBytes,
      playing: state.playing,
      loop: state.loop,
      volume: state.volume,
      pan: state.pan,
      frequency: state.frequency,
      format: { ...state.format },
    };
  }

  releaseBuffer(id: PcmBufferId): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.playing = false;
    this.detachPlayback(state, false);
    return this.buffers.delete(id);
  }

  stopAll(): void {
    for (const state of this.buffers.values()) {
      state.positionBytes = this.currentPosition(state);
      state.playing = false;
      this.detachPlayback(state, false);
    }
  }

  /** Must be called from a user gesture such as pointerdown/keydown. */
  async unlock(): Promise<boolean> {
    if (this.destroyed) return false;
    const context = this.ensureContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') return false;
      for (const state of this.buffers.values()) {
        if (state.playing && !state.source && !state.stream && !state.worklet) this.start(state);
      }
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /**
   * Install persistent browser autoplay-unlock hooks and return a manual cleanup function.
   * Do not remove them after the first success: iOS/Android suspend AudioContext in background tabs, and resume from visibilitychange may be denied without a user gesture. Persistent listeners resume it on the next click, including the first in-game click. While running, unlock() is a cheap no-op (cached context plus one state check), so retaining the listeners adds no material overhead.
   */
  installUserGestureUnlock(target?: EventTarget): () => void {
    const eventTarget = target ?? (typeof document === 'undefined' ? null : document);
    if (!eventTarget) return () => undefined;
    let active = true;
    const events = ['pointerdown', 'touchstart', 'keydown'] as const;
    const remove = (): void => {
      if (!active) return;
      active = false;
      for (const event of events) eventTarget.removeEventListener(event, listener, true);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
    const listener = (): void => {
      void this.unlock();
    };
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.unlock();
    };
    for (const event of events) eventTarget.addEventListener(event, listener, { capture: true, passive: true });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return remove;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.diagnosticsTimer !== null) globalThis.clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
    this.stopAll();
    this.buffers.clear();
    this.destroyed = true;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') {
      try {
        await context.close();
      } catch (error) {
        this.report(error);
      }
    }
  }

  private start(state: PcmBufferState): void {
    if (!state.playing || state.pcm.byteLength === 0) return;
    const context = this.ensureContext();
    if (!context) return;
    this.startAt(state, context.currentTime);
  }

  /**
   * Seamlessly replace a looping static snapshot with a long-lived live PCM reader.
   * Prefer AudioWorklet (pcmStreamWorklet.js) on the audio thread so busy main-thread frames do not interrupt sound; fall back to ScriptProcessor, whose legacy WebAudio callback runs on the main thread. Both match ring-buffer semantics better than creating an AudioBufferSourceNode for every DirectSound Unlock, and replace repeated whole-buffer Bink/music decoding with linear reads per output quantum.
   */
  private startLiveStream(state: PcmBufferState): void {
    const context = this.context;
    if (!context || state.stream || state.worklet || !state.source || !state.playing) return;
    if (typeof AudioWorkletNode !== 'undefined' && context.audioWorklet) {
      void this.startWorkletStream(state, context).catch((error) => {
        this.report(error);
        // On module-load failure or similar errors, fall back to main-thread ScriptProcessor; the source is still playing and the condition still holds.
        if (state.source && !state.stream && !state.worklet) this.startScriptProcessorStream(state, context);
      });
      return;
    }
    this.startScriptProcessorStream(state, context);
  }

  /**
   * AudioWorklet path: once the module is ready, create a node, synchronize the full PCM mirror, and resume from the old source's current position before removing it. The old source keeps playing its snapshot during loading, making the switch gapless.
   */
  private async startWorkletStream(state: PcmBufferState, context: AudioContext): Promise<void> {
    const oldSource = state.source;
    if (!oldSource) return;
    await loadPcmStreamWorklet(context);
    // The source may have been replaced, stopped, or restarted while waiting; take over only if it is unchanged.
    if (state.worklet || !state.playing || state.source !== oldSource) return;

    const current = this.currentPosition(state);
    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    const worklet = new AudioWorkletNode(context, PCM_STREAM_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, state.format.nChannels)],
    });
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    gain.gain.value = directSoundVolumeToGain(state.volume);
    panner.pan.value = directSoundPanToStereo(state.pan);
    worklet.connect(gain).connect(panner).connect(this.masterDestination(context));
    worklet.port.onmessage = (event) => this.onWorkletMessage(state, worklet, event.data);
    const frame = bytePositionToFrame(current, state);
    worklet.port.postMessage({
      kind: 'create',
      channels: state.format.nChannels,
      frames: totalFrames,
      revision: state.workletRevision,
      frequency: state.frequency,
      loop: state.loop,
      frame,
    });
    // Initial full synchronization: convert the existing mirror to interleaved Float32 and send it to the worklet once.
    this.postWorkletUpdate(state, worklet, 0, state.pcm);

    const oldGain = state.gain;
    const oldPanner = state.panner;
    state.source = null;
    state.worklet = worklet;
    state.gain = gain;
    state.panner = panner;
    state.streamFrame = frame;
    state.workletPositionAt = context.currentTime;
    state.positionBytes = current;

    oldSource.onended = null;
    try {
      oldSource.stop();
    } catch {
      /* Already ended naturally. */
    }
    oldSource.disconnect();
    oldGain?.disconnect();
    oldPanner?.disconnect();
  }

  /** Worklet messages: currently only the playback cursor, reported approximately every 100ms. */
  private onWorkletMessage(
    state: PcmBufferState,
    worklet: AudioWorkletNode,
    message: { kind: string; frame?: number; live?: number; at?: number; revision?: number; playing?: boolean },
  ): void {
    if (state.worklet !== worklet || !this.context || message.kind !== 'position') return;
    if (message.live !== undefined) this.liveWorkletProcessors = message.live;
    if (message.revision !== state.workletRevision || !Number.isFinite(message.at)) return;
    // Message delivery may stall behind rendering. Anchor to audio time, never arrival time.
    state.streamFrame = message.frame ?? state.streamFrame;
    state.workletPositionAt = message.at!;
    if (message.playing === false) {
      state.playing = false;
      state.positionBytes = 0;
      this.detachPlayback(state, false);
    }
  }

  private postWorkletMessage(state: PcmBufferState, message: Record<string, unknown> & { kind: string }): void {
    if (!state.worklet) return;
    state.worklet.port.postMessage(message);
  }

  /** Convert a 16/8-bit PCM range to interleaved Float32 and transfer it to the worklet. */
  private postWorkletUpdate(state: PcmBufferState, worklet: AudioWorkletNode, offset: number, bytes: Uint8Array): void {
    const channels = Math.max(1, state.format.nChannels);
    const blockAlign = Math.max(1, state.format.nBlockAlign);
    const frames = Math.floor(bytes.byteLength / blockAlign);
    if (frames <= 0) return;
    const data = new Float32Array(frames * channels);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPerSample = state.format.wBitsPerSample >>> 3;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        data[frame * channels + channel] = readPcmSample(
          view,
          frame * blockAlign + channel * bytesPerSample,
          state.format.wBitsPerSample,
        );
      }
    }
    worklet.port.postMessage({ kind: 'update', offsetFrames: Math.floor(offset / blockAlign), data }, [data.buffer]);
  }

  /** ScriptProcessor fallback: render each quantum on the main thread in onaudioprocess. */
  private startScriptProcessorStream(state: PcmBufferState, context: AudioContext): void {
    if (state.stream || !state.source || !state.playing) return;
    const createProcessor = context.createScriptProcessor?.bind(context);
    if (!createProcessor) return;

    const current = this.currentPosition(state);
    const oldSource = state.source;
    const oldGain = state.gain;
    const oldPanner = state.panner;
    try {
      const stream = createProcessor(STREAM_PROCESSOR_FRAMES, 0, Math.max(1, state.format.nChannels));
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      gain.gain.value = directSoundVolumeToGain(state.volume);
      panner.pan.value = directSoundPanToStereo(state.pan);
      stream.connect(gain).connect(panner).connect(this.masterDestination(context));
      state.streamFrame = bytePositionToFrame(current, state);
      stream.onaudioprocess = (event) => this.renderLiveStream(state, stream, event.outputBuffer, event.playbackTime);

      state.source = null;
      state.stream = stream;
      state.gain = gain;
      state.panner = panner;
      state.positionBytes = current;

      oldSource.onended = null;
      try {
        oldSource.stop();
      } catch {
        /* Already ended naturally. */
      }
      oldSource.disconnect();
      oldGain?.disconnect();
      oldPanner?.disconnect();
    } catch (error) {
      this.report(error);
    }
  }

  private renderLiveStream(
    state: PcmBufferState,
    stream: ScriptProcessorNode,
    output: AudioBuffer,
    playbackTime: number,
  ): void {
    const channels = Array.from({ length: output.numberOfChannels }, (_, channel) => output.getChannelData(channel));
    for (const channel of channels) channel.fill(0);
    if (state.stream !== stream || !state.playing) return;

    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    if (totalFrames <= 0) return;
    const outputRate = output.sampleRate || this.context?.sampleRate || state.format.nSamplesPerSec;
    const step = state.frequency / Math.max(1, outputRate);
    // Use a whole-buffer Int16Array view for common 16-bit PCM, avoiding per-sample DataView branches;
    // fall back to individual sample reads for other bit depths.
    const samples16 =
      state.format.wBitsPerSample === 16
        ? new Int16Array(state.pcm.buffer, state.pcm.byteOffset, state.pcm.byteLength >> 1)
        : null;
    const view = samples16 ? null : new DataView(state.pcm.buffer, state.pcm.byteOffset, state.pcm.byteLength);
    const bytesPerSample = state.format.wBitsPerSample >>> 3;
    let frame = state.streamFrame;
    for (let index = 0; index < output.length; index++) {
      const sourceFrame = Math.floor(frame) % totalFrames;
      for (let channel = 0; channel < channels.length; channel++) {
        const sourceChannel = Math.min(channel, state.format.nChannels - 1);
        if (samples16) {
          channels[channel]![index] = samples16[sourceFrame * state.format.nChannels + sourceChannel]! / 32_768;
        } else {
          const offset = sourceFrame * state.format.nBlockAlign + sourceChannel * bytesPerSample;
          channels[channel]![index] = readPcmSample(view!, offset, state.format.wBitsPerSample);
        }
      }
      frame += step;
      if (frame >= totalFrames) {
        if (state.loop) frame %= totalFrames;
        else {
          state.playing = false;
          frame = totalFrames;
          break;
        }
      }
    }
    state.streamFrame = frame;
    state.workletPositionAt = playbackTime + output.length / outputRate;
    state.positionBytes = Math.min(totalFrames, Math.floor(frame)) * state.format.nBlockAlign;
  }

  private startAt(state: PcmBufferState, when: number): void {
    if (!state.playing || state.pcm.byteLength === 0) return;
    const context = this.ensureContext();
    if (!context) return;
    try {
      const audio = state.decoded ?? this.decode(context, state);
      state.decoded = audio;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      source.buffer = audio;
      source.loop = state.loop;
      source.playbackRate.value = playbackRate(state);
      gain.gain.value = directSoundVolumeToGain(state.volume);
      panner.pan.value = directSoundPanToStereo(state.pan);
      source.connect(gain).connect(panner).connect(this.masterDestination(context));
      const frame = bytePositionToFrame(state.positionBytes, state);
      state.source = source;
      state.gain = gain;
      state.panner = panner;
      state.startedAt = when;
      state.startedFrame = frame;
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
        if (state.source !== source) return;
        state.source = null;
        state.gain = null;
        state.panner = null;
        if (!state.loop) {
          state.playing = false;
          state.positionBytes = 0;
        }
      };
      source.start(when, Math.min(frame / state.format.nSamplesPerSec, audio.duration));
    } catch (error) {
      this.report(error);
    }
  }

  private decode(context: AudioContext, state: PcmBufferState): AudioBuffer {
    const { format, pcm } = state;
    const frames = Math.floor(pcm.byteLength / format.nBlockAlign);
    const audio = context.createBuffer(format.nChannels, Math.max(1, frames), format.nSamplesPerSec);
    const bytesPerSample = format.wBitsPerSample >>> 3;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let channel = 0; channel < format.nChannels; channel++) {
      const output = audio.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        const offset = frame * format.nBlockAlign + channel * bytesPerSample;
        output[frame] = readPcmSample(view, offset, format.wBitsPerSample);
      }
    }
    return audio;
  }

  private currentPosition(state: PcmBufferState, outputTime?: number): number {
    const now = outputTime === undefined ? (this.context?.currentTime ?? 0) : Math.max(state.startedAt, outputTime);
    if (state.stream || state.worklet) {
      const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
      if (totalFrames <= 0) return 0;
      // Worklet cursor = last reported frame + frequency-based extrapolation; reports arrive about every 100ms.
      const advanced =
        this.context && state.playing && (state.worklet || outputTime !== undefined)
          ? Math.floor(
              (outputTime === undefined ? Math.max(0, now - state.workletPositionAt) : now - state.workletPositionAt) *
                state.frequency,
            )
          : 0;
      const frame = state.loop
        ? (((Math.floor(state.streamFrame) + advanced) % totalFrames) + totalFrames) % totalFrames
        : Math.max(0, Math.min(totalFrames, Math.floor(state.streamFrame) + advanced));
      return frame * state.format.nBlockAlign;
    }
    if (!state.source || !this.context || !state.playing) return state.positionBytes;
    const elapsed = Math.max(0, now - state.startedAt);
    const advanced = Math.floor(elapsed * state.format.nSamplesPerSec * playbackRate(state));
    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    if (totalFrames <= 0) return 0;
    const frame = state.loop
      ? (state.startedFrame + advanced) % totalFrames
      : Math.min(totalFrames, state.startedFrame + advanced);
    return frame * state.format.nBlockAlign;
  }

  private detachPlayback(state: PcmBufferState, updatePosition = true): void {
    const source = state.source;
    const stream = state.stream;
    const worklet = state.worklet;
    const gain = state.gain;
    const panner = state.panner;
    if (!source && !stream && !worklet) return;
    if (updatePosition) state.positionBytes = this.currentPosition(state);
    state.source = null;
    state.stream = null;
    state.worklet = null;
    state.gain = null;
    state.panner = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // AudioBufferSourceNode has already ended naturally.
      }
      source.disconnect();
    }
    if (stream) {
      stream.onaudioprocess = null;
      stream.disconnect();
    }
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.postMessage({ kind: 'destroy' });
      worklet.disconnect();
    }
    gain?.disconnect();
    panner?.disconnect();
  }

  private ensureContext(): AudioContext | null {
    if (this.context?.state === 'closed') this.context = null;
    if (this.context) return this.context;
    try {
      if (this.options.contextFactory) {
        this.context = this.options.contextFactory();
      } else {
        if (typeof AudioContext === 'undefined') return null;
        this.context = new AudioContext();
      }
      // A new context needs a new master gain node; the old node is destroyed with its context.
      this.masterGain = null;
      if (this.options.diagnosticsIntervalMs) {
        const context = this.context;
        context.addEventListener('statechange', () =>
          console.warn(
            `[音频诊断] AudioContext 状态变为 ${context.state}（音频时钟 ${context.currentTime.toFixed(1)}s）`,
          ),
        );
      }
      return this.context;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** Lazily created master gain node: combine all buffers, apply volume once, then connect to the destination. */
  private masterDestination(context: AudioContext): AudioNode {
    if (!this.masterGain) {
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.options.destination?.(context) ?? context.destination);
    }
    return this.masterGain;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('WebAudioPcmSink 已销毁');
  }

  private report(error: unknown): void {
    this.activity.errors++;
    this.activity.lastError = error instanceof Error ? error.message : String(error);
    this.options.onError?.(error);
  }

  /**
   * One line separating guest-side silence (no Play/Unlock writes arriving) from host-side silence (context not
   * running, audio clock frozen, or worklets no longer reporting their playback cursor).
   */
  private logDiagnostics(): void {
    const context = this.context;
    let playing = 0;
    let worklets = 0;
    let streams = 0;
    let sources = 0;
    let staleWorklets = 0;
    for (const state of this.buffers.values()) {
      if (state.playing) playing++;
      if (state.worklet) {
        worklets++;
        // The worklet posts its cursor about every 100ms while rendering; a playing one silent for >1s has stalled.
        if (context && state.playing && context.currentTime - state.workletPositionAt > 1) staleWorklets++;
      }
      if (state.stream) streams++;
      if (state.source) sources++;
    }
    const clock = context?.currentTime ?? null;
    const clockDelta =
      clock !== null && this.lastDiagnosticsContextTime !== null ? clock - this.lastDiagnosticsContextTime : null;
    this.lastDiagnosticsContextTime = clock;
    const activity = this.activity;
    console.info(
      `[音频诊断] Context=${context?.state ?? '未创建'} 音频时钟+${clockDelta?.toFixed(1) ?? '-'}s ` +
        `缓冲${this.buffers.size} 播放中${playing}（worklet ${worklets}/停滞${staleWorklets}，脚本流${streams}，一次性源${sources}）；` +
        `音频线程处理器${this.liveWorkletProcessors}；` +
        `本周期 Play${activity.plays} Stop${activity.stops} 写入${activity.writes}次/${(activity.writeBytes / 1024).toFixed(0)}KB ` +
        `错误${activity.errors}${activity.lastError ? `（${activity.lastError}）` : ''}`,
    );
    Object.assign(activity, { plays: 0, stops: 0, writes: 0, writeBytes: 0, errors: 0, lastError: '' });
  }
}

function readPcmSample(view: DataView, offset: number, bits: number): number {
  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32_768;
    case 24: {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if ((value & 0x80_0000) !== 0) value |= 0xff00_0000;
      return value / 8_388_608;
    }
    case 32:
      return view.getInt32(offset, true) / 2_147_483_648;
    default:
      return 0;
  }
}

function bytePositionToFrame(position: number, state: PcmBufferState): number {
  return Math.floor(alignPosition(position, state) / state.format.nBlockAlign);
}

function alignPosition(position: number, state: PcmBufferState): number {
  const clamped = clamp(Math.trunc(position), 0, state.pcm.byteLength);
  return clamped - (clamped % state.format.nBlockAlign);
}

function playbackRate(state: PcmBufferState): number {
  return clamp(state.frequency / state.format.nSamplesPerSec, 0.01, 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
