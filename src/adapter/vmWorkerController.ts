import type { GamePerformanceSample } from '../games/performance';
import { PortRelaySocket } from 'relay-package/client';
import { createBrowserEmulator } from '../platform/browser/emulator';
import { BrowserEmulatorProbe } from '../platform/browser/emulatorProbe';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';
import { DirectoryGameFileProvider } from '../platform/browser/files/directory';
import { gameVmConfiguration } from '../games/vmConfiguration';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { discoverGameSources } from '../resources/discovery/discoverGameSources';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { PortGameFileProvider } from './fileProviderPort';
import { withMultiplayerNameOverride } from '../games/multiplayerName';
import { mountCustomMapFiles, prepareDynamicMaps } from './customMapPackage';
import { VmCore, type VmAudioSink, type VmCorePlatform } from './vmCore';
import type { MainToWorkerMessage, VmInitConfig, WorkerToMainMessage } from './vmProtocol';
import type { GuestMemRecordResult } from './memRecord';
import type { VmPointerState } from './vmShell';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import { ProxyAudioSink } from './audioProxy';
import type { VmFrame } from '../vm86/win32';
import { withGameResolutionOverride } from '../games/resolution';
import { SerialTaskQueue } from '../utils/serialTaskQueue';
import { FrameBufferPool } from './frameBufferPool';

export interface VmWorkerCore {
  gameControl?(method: string, params?: unknown): Promise<unknown>;
  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics>;
  start(): Promise<void>;
  stop(): Promise<void>;
  flushFiles(): Promise<void>;
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
  setCursorPosition(x: number, y: number): void;
  setGameClockRate(rate: number): number;
  setMasterVolume(linear: number): void;
  getPointerState(): VmPointerState | null;
  getGamePerformance(): Promise<GamePerformanceSample | null>;
  setGameSpeedFlag(value: number): number | null;
  startMemRecord(): boolean;
  stopMemRecord(): GuestMemRecordResult | null;
  setFileProvider(files: GameFileProvider): void;
}

export interface VmWorkerControllerDependencies {
  postMessage: (message: WorkerToMainMessage, transfer?: Transferable[]) => void;
  createProvider?: (config: VmInitConfig) => GameFileProvider;
  discoverSources?: (provider: GameFileProvider) => Promise<GameSource[]>;
  applyResolution?: typeof withGameResolutionOverride;
  createCore?: (callbacks: GameVmCallbacks, source: GameSource, platform: VmCorePlatform) => VmWorkerCore;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  audio?: VmAudioSink;
}

interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdOf(message: MainToWorkerMessage): number | undefined {
  switch (message.type) {
    case 'game-control':
    case 'diagnostics':
    case 'game-performance':
    case 'init':
    case 'state':
    case 'guest-speed-flag':
    case 'mem-record-start':
    case 'mem-record-stop':
    case 'flush':
    case 'attach-maps':
      return message.requestId;
    case 'control':
      return message.requestId;
    default:
      return undefined;
  }
}

export class VmWorkerController {
  private core: VmWorkerCore | null = null;
  private sourceTemplate: GameFileProvider | null = null;
  private started = false;
  private initReady: Promise<void> = Promise.resolve();
  private pendingClock: number | null = null;
  private pendingVolume: number | null = null;
  private callBatchOrdinal = 0;
  private callBatchDelta = 0;
  private callBatchLogicFrames = 0;
  private callBatchHistogram = new Map<string, number>();
  private callBatchSamples: Array<{ call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0]; ordinal: number }> =
    [];
  private callBatchTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private callTracing = false;
  private relayPort: MessagePort | undefined;
  private portFiles: PortGameFileProvider | null = null;
  private nextFrameId = 1;
  private inFlightFrameId = 0;
  private pendingFrameEmit: (() => void) | null = null;
  private readonly frameBuffers = new FrameBufferPool();
  private frameScheduleGeneration = 0;
  private proxyAudio: ProxyAudioSink | undefined;
  private readonly dependencies: Required<
    Pick<VmWorkerControllerDependencies, 'discoverSources' | 'applyResolution' | 'createCore' | 'fetchBytes'>
  > &
    Pick<VmWorkerControllerDependencies, 'createProvider' | 'audio'>;

  constructor(
    private readonly post: VmWorkerControllerDependencies['postMessage'],
    dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
  ) {
    this.dependencies = {
      discoverSources: dependencies.discoverSources ?? discoverGameSources,
      applyResolution: dependencies.applyResolution ?? withGameResolutionOverride,
      createCore: dependencies.createCore ?? ((callbacks, source, platform) => new VmCore(callbacks, source, platform)),
      fetchBytes: dependencies.fetchBytes ?? fetchBytes,
      createProvider: dependencies.createProvider,
      audio: dependencies.audio,
    };
  }

  async handleMessage(message: MainToWorkerMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'game-control':
          if (!this.core?.gameControl) throw new Error('Game control unavailable');
          this.post({
            type: 'game-control-reply',
            requestId: message.requestId,
            value: await this.core.gameControl(message.method, message.params),
          });
          break;
        case 'audio-state':
          this.proxyAudio?.acceptState(message.states);
          break;
        case 'init':
          this.initReady = this.handleInit(message.config);
          await this.initReady;
          this.post({ type: 'init-done', requestId: message.requestId });
          break;
        case 'control':
          if (message.action === 'start') {
            await this.initReady;
            await this.handleStart();
            this.post({ type: 'control-done', action: 'start', requestId: message.requestId });
          } else {
            this.frameScheduleGeneration++;
            this.inFlightFrameId = 0;
            this.pendingFrameEmit = null;
            if (this.core) await this.core.stop();
            this.started = false;
            this.post({ type: 'control-done', action: 'stop', requestId: message.requestId });
          }
          break;
        case 'wm':
          this.core?.postMessage(message.m, message.w, message.l);
          break;
        case 'key':
          this.core?.setKeyState(message.vk, message.down);
          break;
        case 'cursor':
          this.core?.setCursorPosition(message.x, message.y);
          break;
        case 'clock':
          this.pendingClock = message.rate;
          this.core?.setGameClockRate(message.rate);
          break;
        case 'volume':
          this.pendingVolume = message.linear;
          this.core?.setMasterVolume(message.linear);
          break;
        case 'call-tracing':
          this.callTracing = message.enabled;
          break;
        case 'game-performance':
          this.post({
            type: 'game-performance-reply',
            requestId: message.requestId,
            value: (await this.core?.getGamePerformance()) ?? null,
          });
          break;
        case 'diagnostics':
          if (!this.core) throw new Error('VM 尚未 init');
          this.post({
            type: 'diagnostics-reply',
            requestId: message.requestId,
            value: await this.core.getDiagnostics(message.action),
          });
          break;
        case 'state':
          this.post({
            type: 'state-reply',
            requestId: message.requestId,
            kind: message.kind,
            value: this.core?.getPointerState() ?? null,
          });
          break;
        case 'guest-speed-flag':
          this.post({
            type: 'guest-speed-flag-reply',
            requestId: message.requestId,
            value: this.core?.setGameSpeedFlag(message.value) ?? null,
          });
          break;
        case 'mem-record-start':
          this.post({
            type: 'mem-record-start-reply',
            requestId: message.requestId,
            ok: this.core?.startMemRecord() ?? false,
          });
          break;
        case 'mem-record-stop':
          this.post({
            type: 'mem-record-stop-reply',
            requestId: message.requestId,
            result: this.core?.stopMemRecord() ?? null,
          });
          break;
        case 'flush':
          await this.core?.flushFiles();
          this.post({ type: 'flush-done', requestId: message.requestId });
          break;
        case 'attach-maps': {
          if (!this.core || !this.sourceTemplate) throw new Error('VM 尚未初始化');
          const { provider, result } = await prepareDynamicMaps(
            this.sourceTemplate,
            new Map(message.files.map(({ path, bytes }) => [path, bytes])),
          );
          this.core.setFileProvider(provider);
          this.sourceTemplate = provider;
          this.post({ type: 'attach-maps-done', requestId: message.requestId, result });
          break;
        }
        case 'frame-ack':
          this.acknowledgeFrame(message.frameId);
          break;
        case 'recycle-frame':
          this.frameBuffers.release(message.buffer);
          break;
      }
    } catch (error) {
      const requestId = requestIdOf(message);
      this.post(
        requestId === undefined
          ? { type: 'error', message: errorMessage(error) }
          : { type: 'error', requestId, message: errorMessage(error) },
      );
      if (message.type === 'init' || (message.type === 'control' && message.action === 'start')) {
        this.post({ type: 'status', phase: 'error', detail: errorMessage(error) });
      }
    }
  }

  dispose(): void {
    this.relayPort?.close();
    this.relayPort = undefined;
    this.frameBuffers.clear();
    this.portFiles?.dispose();
    this.portFiles = null;
    if (this.callBatchTimer !== null) globalThis.clearInterval(this.callBatchTimer);
    this.callBatchTimer = null;
    this.frameScheduleGeneration++;
    this.pendingFrameEmit = null;
    this.inFlightFrameId = 0;
  }

  /** Rebuild the file backend from init: directory handles with optional online overlays, session-package memory files, or on-demand file ports. */
  private buildProvider(config: VmInitConfig): GameFileProvider {
    if (config.provider.kind === 'port') {
      return (this.portFiles = new PortGameFileProvider(
        config.provider.label,
        config.provider.port,
        config.provider.names,
      ));
    }
    if (config.provider.kind === 'memory') {
      // Session-package (online ZIP) files transfer into the Worker with init; directly rebuild the memory
      // provider with deepDiscovery and persist saves to the same-origin IndexedDB shared with the page.
      return new SessionGameFileProvider(
        config.provider.label,
        new Map(config.provider.files.map((entry) => [entry.path, entry.bytes])),
      );
    }
    if (config.provider.kind === 'directory') {
      const base = new DirectoryGameFileProvider(config.provider.handle);
      const overlays = config.provider.overlays ?? [];
      if (!overlays.length) return base;
      // Online-package overlays only fill gaps: authorized local directories take precedence, including Chinese resources; writes still use the directory backend.
      return new OverlayGameFileProvider(
        base,
        new Map(overlays.map((entry) => [entry.path, entry.bytes])),
        '（在线覆盖）',
        false,
        false,
        true,
      );
    }
    throw new Error('Unsupported file provider; import a local installation.');
  }

  private async handleInit(config: VmInitConfig): Promise<void> {
    if (this.core) throw new Error('重复 init');
    this.relayPort = config.relayPort;
    this.pendingClock ??= config.clockRate;
    this.pendingVolume ??= config.masterVolume;
    this.callTracing = config.traceCalls;
    let provider = this.dependencies.createProvider
      ? this.dependencies.createProvider(config)
      : this.buildProvider(config);
    if (config.selectedExecutable) {
      // Overlay before discovery, not merely by replacing executableBytes: discovery, PE loading,
      // and later guest reads of its own EXE must agree. Never fall back to old files through parent-first lookup.
      provider = new OverlayGameFileProvider(
        provider,
        new Map([[config.selectedExecutable.path, config.selectedExecutable.bytes]]),
        '（启动 EXE）',
        true,
        false,
        false,
      );
    }
    const sources = await this.dependencies.discoverSources(provider);
    const discoveredSource =
      sources.find((item) => item.game.id === config.preferredGameId) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!discoveredSource) {
      throw new Error(`未在游戏目录中找到 ${config.preferredGameId}（发现 ${sources.length} 款已支持游戏）`);
    }
    let mounted = config.additionalFiles?.length
      ? mountCustomMapFiles(discoveredSource, new Map(config.additionalFiles.map(({ path, bytes }) => [path, bytes])))
      : discoveredSource;
    if (config.sessionFiles?.length)
      mounted = {
        ...mounted,
        files: new OverlayGameFileProvider(
          mounted.files,
          new Map(config.sessionFiles.map(({ path, bytes }) => [path, bytes])),
          ' + session',
          true,
        ),
      };
    const source = await withMultiplayerNameOverride(
      await this.dependencies.applyResolution(mounted, config.resolution),
      config.playerName,
    );
    this.sourceTemplate = source.files;
    const callbacks: GameVmCallbacks = {
      onNetworkStatus: (status) => this.post({ type: 'network-status', status }),
      onStatus: (status) => this.post({ type: 'status', phase: status.phase, detail: status.detail }),
      onCall: (call, ordinal) => this.recordCall(call, ordinal),
      onBlocked: (call) => this.post({ type: 'blocked', call }),
      onFrame: (frame) => this.sendFrame(frame),
      onLogicFrame: () => {
        this.callBatchLogicFrames++;
      },
      onShellPage: (title) => this.post({ type: 'shell-page', title }),
    };
    const probe = new BrowserEmulatorProbe();
    const platform: VmCorePlatform = {
      createEmulator: (options) => createBrowserEmulator(options, probe),
      executionProbe: probe,
      ...gameVmConfiguration(
        source.game,
        callbacks.onNetworkStatus,
        config.ra2Network,
        config.relayPort ? (url) => new PortRelaySocket(config.relayPort!, url) : undefined,
      ),
      startupPage: config.startupPage,
      fetchBytes: this.dependencies.fetchBytes,
      scheduleFrame: (emit) => this.scheduleFrameWithBackpressure(emit),
      deferFrameSnapshot: true,
      packedRgb565Frames: true,
      takeFrameBuffer: (size) => this.frameBuffers.take(size),
      audio: this.dependencies.audio ?? (this.proxyAudio = new ProxyAudioSink(this.post)),
      fastFileRead: config.fastFileRead,
    };
    this.core = this.dependencies.createCore(callbacks, source, platform);
    this.callBatchTimer ??= globalThis.setInterval(() => this.flushCallBatch(), 500);
  }

  private async handleStart(): Promise<void> {
    if (!this.core) throw new Error('VM 尚未 init');
    if (this.started) return;
    this.started = true;
    await this.core.start();
    this.core.setGameClockRate(this.pendingClock ?? 1);
    this.core.setMasterVolume(this.pendingVolume ?? 0.25);
  }

  private recordCall(call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0], ordinal: number): void {
    this.callBatchOrdinal = ordinal;
    this.callBatchDelta++;
    if (!this.callTracing) return;
    const key = call.imported.key;
    this.callBatchHistogram.set(key, (this.callBatchHistogram.get(key) ?? 0) + 1);
    if (ordinal <= 200 || ordinal % 256 === 0) this.callBatchSamples.push({ call, ordinal });
  }

  private flushCallBatch(): void {
    if (!this.callBatchDelta && !this.callBatchLogicFrames) return;
    this.post({
      type: 'call-batch',
      batch: {
        ordinal: this.callBatchOrdinal,
        delta: this.callBatchDelta,
        logicFrames: this.callBatchLogicFrames,
        histogram: [...this.callBatchHistogram],
        samples: this.callBatchSamples,
      },
    });
    this.callBatchDelta = 0;
    this.callBatchLogicFrames = 0;
    this.callBatchHistogram = new Map();
    this.callBatchSamples = [];
  }

  private sendFrame(frame: VmFrame): void {
    const frameId = this.nextFrameId++;
    this.inFlightFrameId = frameId;
    const transfers: Transferable[] = [frame.pixels.buffer, frame.palette.buffer];
    if (frame.rgba) transfers.push(frame.rgba.buffer);
    if (frame.rgb565) transfers.push(frame.rgb565.buffer);
    if (frame.cursor) transfers.push(frame.cursor.rgba.buffer);
    this.post({ type: 'frame', frameId, frame }, transfers);
  }

  private scheduleFrameWithBackpressure(emit: () => void): void {
    if (this.inFlightFrameId) {
      this.pendingFrameEmit = emit;
      return;
    }
    const generation = this.frameScheduleGeneration;
    queueMicrotask(() => {
      if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
      emit();
    });
  }

  private acknowledgeFrame(frameId: number): void {
    if (frameId !== this.inFlightFrameId) return;
    this.inFlightFrameId = 0;
    const next = this.pendingFrameEmit;
    this.pendingFrameEmit = null;
    if (next) {
      const generation = ++this.frameScheduleGeneration;
      queueMicrotask(() => {
        if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
        next();
      });
    }
  }
}

export function createVmWorkerController(dependencies: VmWorkerControllerDependencies): VmWorkerController {
  const { postMessage, ...rest } = dependencies;
  return new VmWorkerController(postMessage, rest);
}

export function installVmWorker(
  scope: WorkerScope,
  dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
): VmWorkerController {
  const controller = createVmWorkerController({ postMessage: scope.postMessage.bind(scope), ...dependencies });
  const queue = new SerialTaskQueue((error) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
  scope.postMessage({ type: 'probe', ready: true });
  scope.onmessage = (event) => {
    void queue.enqueue(() => controller.handleMessage(event.data));
  };
  return controller;
}
