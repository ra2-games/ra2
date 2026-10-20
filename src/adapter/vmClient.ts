import { AudioStateFeedback } from './audioFeedback';
import type { GamePerformanceSample } from '../games/performance';
import type { VmDiagnosticAction, VmDiagnostics, VmRuntimeInfo } from './vmDiagnostics';
import { normalizeGameClockRate } from '../vm86/clock';
import { AUDIO_DIAGNOSTICS_INTERVAL_MS, WebAudioPcmSink } from './audio';
import type { GuestMemRecordResult } from './memRecord';
import {
  createRequestId,
  type AudioOp,
  type MainToWorkerMessage,
  type VmInitConfig,
  type WorkerToMainMessage,
} from './vmProtocol';
import type { VmAttachResult, VmPointerState, VmShell } from './vmShell';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import type { GameResolution } from '../games/resolution';

const PROBE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;
const STARTUP_TIMEOUT_MS = 120000;

export interface WorkerVmClientOptions {
  /** Release host-owned session resources when the Worker terminates normally or exits unexpectedly. */
  onTerminated?: () => void;
  /** Explicit experimental navigation; preserve original startup by default. */
  startupPage?: string;
  /** In-memory resolution overlay injected into RA2.INI/RA2MD.INI at startup. */
  resolution?: GameResolution | null;
  /** Native [MultiPlayer] Handle for this VM; never shared with other tabs. */
  playerName?: string;
  /** Worker injection for tests; production creates a module Worker by default. */
  workerFactory?: () => Worker;
  /** Audio-sink injection for tests; production creates WebAudioPcmSink by default. */
  audio?: WebAudioPcmSink;
  startupTimeoutMs?: number;
  /** Buffers transferred with init (copies of session-package files); used exactly once for init. */
  initTransfer?: Transferable[];
  /** The caller guarantees old pixels are no longer used once onFrame replaces them; disabled by default for consumers retaining snapshots. */
  recycleFrames?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Worker-mode client: the whole VM runs in a Dedicated Worker; the main thread only handles audio output, input forwarding, and callback dispatch.
 * The public interface matches Win32GameVm (VmShell), keeping page.ts independent of the execution thread.
 */
export class WorkerVmClient implements VmShell {
  readonly runtimeInfo: VmRuntimeInfo = {
    mode: 'worker',
    reason: 'default',
    workerProbeMs: null,
    fallbackReason: null,
  };
  private readonly probeStartedAt = performance.now();
  private readonly worker: Worker;
  private readonly onTerminated: (() => void) | undefined;
  private readonly audio: WebAudioPcmSink;
  private readonly audioFeedback: AudioStateFeedback;
  private readonly requests = new Map<number, PendingRequest>();
  private readonly callbacks: GameVmCallbacks;
  private readonly initConfig: VmInitConfig;
  private readonly startupTimeoutMs: number;
  private readonly initTransfer: Transferable[] | undefined;
  private readonly probeReady: Promise<void>;
  private resolveProbe: (() => void) | null = null;
  private rejectProbe: ((reason: Error) => void) | null = null;
  private probeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private lifecycle: 'active' | 'fatal' | 'destroying' | 'destroyed' = 'active';
  private fatalReason: Error | null = null;
  private destroyPromise: Promise<void> | null = null;
  private probeOk = false;
  private removeAudioUnlock: (() => void) | null = null;
  private removePagehideFlush: (() => void) | null = null;
  private frameAckRaf: number | null = null;
  private pendingFrameAck = 0;
  private previousFrameBuffer: ArrayBuffer | null = null;
  private readonly recycleFrames: boolean;

  constructor(callbacks: GameVmCallbacks, initConfig: VmInitConfig, options: WorkerVmClientOptions = {}) {
    this.onTerminated = options.onTerminated;
    this.recycleFrames = options.recycleFrames ?? false;
    this.callbacks = callbacks;
    this.initConfig = initConfig;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.initTransfer = options.initTransfer;
    this.audio =
      options.audio ??
      new WebAudioPcmSink({
        onError: (error) => console.warn('[VM audio]', error),
        diagnosticsIntervalMs: AUDIO_DIAGNOSTICS_INTERVAL_MS,
      });
    this.audioFeedback = new AudioStateFeedback(this.audio, (states) => {
      if (this.lifecycle === 'active') this.send({ type: 'audio-state', states });
    });
    this.worker =
      options.workerFactory?.() ?? new Worker(new URL('./vmWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      console.error('[VM worker]', event);
      const message = event.message || 'worker 运行错误';
      this.handleFatal(new Error(message));
    };
    this.worker.onmessageerror = () => this.handleFatal(new Error('worker 消息反序列化失败'));
    this.probeReady = new Promise<void>((resolve, reject) => {
      this.resolveProbe = resolve;
      this.rejectProbe = reject;
      this.probeTimer = globalThis.setTimeout(() => {
        this.handleFatal(new Error(`worker 能力探测超时（${PROBE_TIMEOUT_MS / 1000}s）`));
      }, PROBE_TIMEOUT_MS);
    });
  }

  /** Worker-load probe: timeout/onerror rejects, allowing createVmShell to fall back. */
  waitProbe(): Promise<void> {
    return this.probeReady;
  }

  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics> {
    return this.request((requestId) => ({ type: 'diagnostics', action, requestId }));
  }

  async start(): Promise<void> {
    this.ensureActive();
    this.removeAudioUnlock = this.audio.installUserGestureUnlock(document);
    // Unload cannot await: pagehide makes a best-effort flush of queued save writes, executed in the Worker via a flush message.
    const flushOnPagehide = () => {
      void this.flushFiles().catch(() => {});
    };
    window.addEventListener('pagehide', flushOnPagehide);
    this.removePagehideFlush = () => window.removeEventListener('pagehide', flushOnPagehide);
    try {
      await this.probeReady;
      await this.request<void>(
        (requestId) => ({ type: 'init', config: this.initConfig, requestId }),
        this.initTransfer,
        false,
        this.startupTimeoutMs,
      );
      await this.request<void>(
        (requestId) => ({ type: 'control', action: 'start', requestId }),
        undefined,
        false,
        this.startupTimeoutMs,
      );
    } catch (error) {
      this.removePagehideFlush?.();
      this.removePagehideFlush = null;
      this.removeAudioUnlock?.();
      this.removeAudioUnlock = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ensureActive();
    await this.request((requestId) => ({ type: 'control', action: 'stop', requestId }));
  }

  postMessage(message: number, wParam = 0, lParam = 0): void {
    this.send({ type: 'wm', m: message, w: wParam, l: lParam });
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.send({ type: 'key', vk: virtualKey, down });
  }

  setCursorPosition(x: number, y: number): void {
    this.send({ type: 'cursor', x, y });
  }

  setGameClockRate(rate: number): number {
    const normalized = normalizeGameClockRate(rate);
    this.send({ type: 'clock', rate: normalized });
    return normalized;
  }

  /** Master volume: linear gain 0..1 after combining all guest audio. */
  setMasterVolume(linear: number): void {
    this.send({ type: 'volume', linear });
  }

  async getGamePerformance(): Promise<GamePerformanceSample | null> {
    return this.request((requestId) => ({ type: 'game-performance', requestId }));
  }

  gameControl(method: string, params?: unknown): Promise<unknown> {
    return this.request((requestId) => ({ type: 'game-control', method, params, requestId }));
  }

  async getPointerState(): Promise<VmPointerState | null> {
    return this.request((requestId) => ({ type: 'state', kind: 'pointer', requestId }));
  }

  async setGameSpeedFlag(value: number): Promise<number | null> {
    return this.request((requestId) => ({ type: 'guest-speed-flag', value, requestId }));
  }

  async startMemRecord(): Promise<boolean> {
    return this.request((requestId) => ({ type: 'mem-record-start', requestId }));
  }

  async stopMemRecord(): Promise<GuestMemRecordResult | null> {
    return this.request((requestId) => ({ type: 'mem-record-stop', requestId }));
  }

  setCallTracing(enabled: boolean): void {
    this.send({ type: 'call-tracing', enabled });
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    const flushBeforeTerminate = this.lifecycle === 'active' && this.workerReady();
    this.lifecycle = 'destroying';
    this.destroyPromise = this.finalizeDestroy(flushBeforeTerminate);
    return this.destroyPromise;
  }

  private workerReady(): boolean {
    return this.probeOk && this.lifecycle === 'active';
  }

  flushFiles(): Promise<void> {
    return this.request((requestId) => ({ type: 'flush', requestId }));
  }

  attachMapFiles(files: ReadonlyMap<string, Uint8Array>): Promise<VmAttachResult> {
    // Copy the exact view before transfer to avoid detaching the frontend cache; CSF need not cross threads.
    const entries = [...files]
      .filter(([path]) => !path.toLowerCase().endsWith('.csf'))
      .map(([path, bytes]) => ({ path, bytes: new Uint8Array(bytes) }));
    return this.request(
      (requestId) => ({ type: 'attach-maps', files: entries, requestId }),
      entries.map(({ bytes }) => bytes.buffer),
    );
  }

  private send(message: MainToWorkerMessage, transfer?: Transferable[]): void {
    if (this.lifecycle !== 'active') return;
    try {
      this.worker.postMessage(message, transfer ?? []);
    } catch (error) {
      this.handleFatal(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Correlate requests and responses; reject on timeout or destruction to prevent dangling promises. */
  private request<T>(
    build: (requestId: number) => MainToWorkerMessage,
    transfer?: Transferable[],
    allowDestroying = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.lifecycle !== 'active' && !(allowDestroying && this.lifecycle === 'destroying')) {
      return Promise.reject(this.lifecycleError());
    }
    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error('worker 请求超时'));
      }, timeoutMs);
      this.requests.set(requestId, {
        resolve: (value) => {
          globalThis.clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (reason) => {
          globalThis.clearTimeout(timeout);
          reject(reason);
        },
      });
      const message = build(requestId);
      if (this.lifecycle === 'active') this.send(message, transfer);
      else {
        try {
          this.worker.postMessage(message, transfer ?? []);
        } catch (error) {
          this.requests.delete(requestId);
          globalThis.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private handleMessage(message: WorkerToMainMessage): void {
    if (this.lifecycle === 'destroyed' || this.lifecycle === 'fatal') return;
    switch (message.type) {
      case 'probe': {
        const supported = message.ready;
        if (supported) {
          this.runtimeInfo.workerProbeMs = performance.now() - this.probeStartedAt;
          this.probeOk = true;
          if (this.probeTimer !== null) globalThis.clearTimeout(this.probeTimer);
          this.probeTimer = null;
          const resolve = this.resolveProbe;
          this.resolveProbe = null;
          this.rejectProbe = null;
          resolve?.();
        } else {
          const reject = this.rejectProbe;
          this.resolveProbe = null;
          this.rejectProbe = null;
          reject?.(new Error('Worker 初始化失败'));
        }
        break;
      }
      case 'status':
        this.callbacks.onStatus?.({ phase: message.phase, detail: message.detail });
        break;
      case 'shell-page':
        this.callbacks.onShellPage?.(message.title);
        break;
      case 'network-status':
        this.callbacks.onNetworkStatus?.(message.status);
        break;
      case 'call-batch':
        this.callbacks.onCallBatch?.(message.batch);
        break;
      case 'blocked':
        this.callbacks.onBlocked?.(message.call);
        break;
      case 'frame':
        try {
          this.callbacks.onFrame?.(message.frame);
          if (this.recycleFrames) {
            const previous = this.previousFrameBuffer;
            const buffer = message.frame.rgb565?.buffer ?? message.frame.rgba?.buffer;
            this.previousFrameBuffer = buffer instanceof ArrayBuffer ? buffer : null;
            if (previous && previous !== buffer && previous.byteLength) {
              this.send({ type: 'recycle-frame', buffer: previous }, [previous]);
            }
          }
        } finally {
          // Page callback errors must not permanently block the Worker frame pipeline.
          this.ackFrameAtPresentationBoundary(message.frameId);
        }
        break;
      case 'game-performance-reply':
      case 'game-control-reply':
      case 'diagnostics-reply':
      case 'state-reply':
        this.resolveRequest(message.requestId, message.value);
        break;
      case 'guest-speed-flag-reply':
        this.resolveRequest(message.requestId, message.value);
        break;
      case 'mem-record-start-reply':
        this.resolveRequest(message.requestId, message.ok);
        break;
      case 'mem-record-stop-reply':
        this.resolveRequest(message.requestId, message.result);
        break;
      case 'audio':
        if (this.lifecycle !== 'active') break;
        this.applyAudioOp(message.op);
        this.audioFeedback.applied(message.op, message.revision);
        break;
      case 'audio-control':
        if (message.action === 'master-volume') this.audio.setMasterVolume(message.linear);
        else if (message.action === 'stop-all') this.audio.stopAll();
        else if (message.action === 'destroy') {
          this.audioFeedback.clear();
          void this.audio.destroy();
        }
        break;
      case 'init-done':
        this.resolveRequest(message.requestId, undefined);
        break;
      case 'flush-done':
        this.resolveRequest(message.requestId, undefined);
        break;
      case 'attach-maps-done':
        this.resolveRequest(message.requestId, message.result);
        break;
      case 'control-done':
        this.resolveRequest(message.requestId, undefined);
        break;
      case 'error':
        if (message.requestId !== undefined) {
          this.rejectRequest(message.requestId, new Error(message.message));
        } else {
          this.handleFatal(new Error(message.message));
        }
        break;
    }
  }

  private resolveRequest(requestId: number, value: unknown): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    request.resolve(value);
  }

  private rejectRequest(requestId: number, reason: Error): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    request.reject(reason);
  }

  private ensureActive(): void {
    if (this.lifecycle !== 'active') throw this.lifecycleError();
  }

  private lifecycleError(): Error {
    return this.fatalReason ?? new Error('VM 已销毁');
  }

  private handleFatal(reason: Error): void {
    if (this.lifecycle === 'fatal' || this.lifecycle === 'destroyed') return;
    const destroying = this.lifecycle === 'destroying';
    const wasProbed = this.probeOk;
    this.fatalReason = reason;
    this.lifecycle = 'fatal';
    if (this.probeTimer !== null) globalThis.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.rejectProbe?.(reason);
    this.resolveProbe = null;
    this.rejectProbe = null;
    for (const request of this.requests.values()) request.reject(reason);
    this.requests.clear();
    if (wasProbed) this.callbacks.onStatus?.({ phase: 'error', detail: reason.message });
    if (destroying) return;
    this.destroyPromise = this.finalizeDestroy(false);
  }

  private async finalizeDestroy(flushBeforeTerminate: boolean): Promise<void> {
    this.audioFeedback.clear();
    this.audio.stopAll();
    if (this.probeTimer !== null) globalThis.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.removeAudioUnlock?.();
    this.removeAudioUnlock = null;
    this.removePagehideFlush?.();
    this.removePagehideFlush = null;
    if (this.frameAckRaf !== null) cancelAnimationFrame(this.frameAckRaf);
    this.frameAckRaf = null;
    this.pendingFrameAck = 0;
    this.previousFrameBuffer = null;
    if (flushBeforeTerminate) {
      try {
        await this.request((requestId) => ({ type: 'control', action: 'stop', requestId }), undefined, true);
      } catch {
        /* Best-effort destruction cleanup. */
      }
      try {
        await this.request((requestId) => ({ type: 'flush', requestId }), undefined, true);
      } catch {
        /* Best-effort unload cleanup. */
      }
    }
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.onTerminated?.();
    await this.audio.destroy();
    const reason = this.lifecycleError();
    for (const request of this.requests.values()) request.reject(reason);
    this.requests.clear();
    this.rejectProbe?.(reason);
    this.resolveProbe = null;
    this.rejectProbe = null;
    this.lifecycle = 'destroyed';
  }

  /**
   * onFrame schedules the page's drawing in the same rAF cycle; schedule ACK afterward so the current frame reaches the actual display boundary before ACK releases the next frame. Paused rAF in background tabs naturally backpressures the Worker.
   */
  private ackFrameAtPresentationBoundary(frameId: number): void {
    this.pendingFrameAck = frameId;
    if (this.frameAckRaf !== null) return;
    this.frameAckRaf = requestAnimationFrame(() => {
      this.frameAckRaf = null;
      const acknowledged = this.pendingFrameAck;
      this.pendingFrameAck = 0;
      if (acknowledged) this.send({ type: 'frame-ack', frameId: acknowledged });
    });
  }

  private applyAudioOp(op: AudioOp): void {
    switch (op.op) {
      case 'createBuffer':
        this.audio.createBuffer(op.id, op.byteLength, op.format);
        break;
      case 'duplicateBuffer':
        this.audio.duplicateBuffer(op.sourceId, op.destinationId);
        break;
      case 'setFormat':
        this.audio.setFormat(op.id, op.format);
        break;
      case 'writeBuffer':
        this.audio.writeBuffer(op.id, op.offset, op.bytes);
        break;
      case 'play':
        this.audio.play(op.id, op.options);
        break;
      case 'stop':
        this.audio.stop(op.id);
        break;
      case 'setCurrentPosition':
        this.audio.setCurrentPosition(op.id, op.byteOffset);
        break;
      case 'setVolume':
        this.audio.setVolume(op.id, op.volume);
        break;
      case 'setPan':
        this.audio.setPan(op.id, op.pan);
        break;
      case 'setFrequency':
        this.audio.setFrequency(op.id, op.frequency);
        break;
      case 'releaseBuffer':
        this.audio.releaseBuffer(op.id);
        break;
    }
  }
}
