/**
 * AudioWorklet renderer for DirectSound ring PCM streams.
 *
 * The main thread only converts guest-written PCM ranges to Float32 and synchronizes them via update. Per-quantum sampling runs on the audio thread, preventing buffer starvation when rendering or GC saturates the main thread, which caused stutter with main-thread ScriptProcessor onaudioprocess. Each DirectSound buffer has one Processor instance and its own direct message port.
 *
 * Message protocol (port, main thread -> worklet):
 * - create {channels, frames, frequency, loop, frame}: create the stream; update follows with all PCM data.
 * - update {offsetFrames, data: Float32Array}: overwrite interleaved data at a frame offset.
 * - play / stop / set-loop {loop} / set-position {frame} / set-frequency {frequency}
 * - destroy
 * Replies (worklet -> main thread): position {frame, at, revision, playing} reports the playback cursor about every 100ms; the main thread extrapolates using currentTime.
 *
 * Note: new URL(..., import.meta.url) emits this file unchanged as a build asset. Vite does not transpile TS here, so keep plain JS syntax without type annotations, declare, or generics.
 */

// AudioWorklet globals (sampleRate/currentTime/registerProcessor) are absent from lib.dom;
// use JSDoc for types here while keeping the file itself plain JS.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentTime */

/** Live processor instances on the audio thread; reported with the cursor to detect leaked nodes. */
let liveProcessors = 0;

class Ra2PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    liveProcessors++;
    /** @type {{ channels: number, frames: number, pcm: Float32Array, frame: number,
     *   playing: boolean, loop: boolean, step: number, revision: number, lastPositionAt: number } | null} */
    this.state = null;
    /**
     * Set by destroy. process() must then return false: while it returns true the node keeps "active processing"
     * status, so the browser cannot collect a disconnected node and its per-quantum work accumulates on the audio
     * thread for the whole session, eventually starving rendering and silencing the game.
     */
    this.destroyed = false;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  /**
   * @param {{ kind: string, channels?: number, frames?: number, frequency?: number,
   *   loop?: boolean, frame?: number, revision?: number, offsetFrames?: number, data?: Float32Array }} message
   */
  onMessage(message) {
    switch (message.kind) {
      case 'create': {
        const channels = Math.max(1, message.channels);
        const frames = Math.max(0, message.frames);
        this.state = {
          channels,
          frames,
          pcm: new Float32Array(Math.max(1, frames) * channels),
          frame: message.frame,
          revision: message.revision ?? 0,
          playing: true,
          loop: message.loop,
          step: Math.max(0, message.frequency) / sampleRate,
          lastPositionAt: currentTime,
        };
        break;
      }
      case 'update': {
        if (this.state) this.state.pcm.set(message.data, message.offsetFrames * this.state.channels);
        break;
      }
      case 'play': {
        if (this.state) this.state.playing = true;
        break;
      }
      case 'stop': {
        if (this.state) {
          this.state.playing = false;
          this.port.postMessage({
            kind: 'position',
            frame: this.state.frame,
            at: currentTime,
            revision: this.state.revision,
            playing: false,
          });
        }
        break;
      }
      case 'set-loop': {
        if (this.state) this.state.loop = message.loop;
        break;
      }
      case 'set-position': {
        if (this.state) {
          this.state.frame = message.frame;
          this.state.revision = message.revision;
        }
        break;
      }
      case 'set-frequency': {
        if (this.state) {
          this.state.step = Math.max(0, message.frequency) / sampleRate;
          this.state.revision = message.revision;
        }
        break;
      }
      case 'destroy': {
        this.state = null;
        if (!this.destroyed) liveProcessors--; // A repeated destroy must not double-count.
        this.destroyed = true;
        break;
      }
    }
  }

  process(_inputs, outputs) {
    if (this.destroyed) return false;
    const state = this.state;
    const output = outputs[0];
    if (!state || !output || output.length === 0) return true;
    const length = output[0] ? output[0].length : 0;
    for (const channel of output) channel.fill(0);
    if (!state.playing || state.frames <= 0) return true;

    let frame = state.frame;
    for (let i = 0; i < length; i++) {
      if (frame >= state.frames) {
        if (state.loop) {
          frame %= state.frames;
        } else {
          state.playing = false;
          frame = state.frames;
          break;
        }
      }
      const base = Math.floor(frame) * state.channels;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][i] = state.pcm[base + Math.min(channel, state.channels - 1)];
      }
      frame += state.step;
    }
    if (!state.loop && frame >= state.frames) {
      state.playing = false;
      frame = state.frames;
    }
    state.frame = frame;

    // Report the cursor about every 100ms as the main thread's extrapolation baseline.
    if (!state.playing || currentTime - state.lastPositionAt >= 0.1) {
      state.lastPositionAt = currentTime;
      // frame is at the end of this render quantum; currentTime marks its beginning.
      this.port.postMessage({
        kind: 'position',
        frame: state.frame,
        at: currentTime + length / sampleRate,
        revision: state.revision,
        playing: state.playing,
        live: liveProcessors,
      });
    }
    return true;
  }
}

registerProcessor('ra2-pcm-stream', Ra2PcmStreamProcessor);
