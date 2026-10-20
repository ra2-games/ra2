import { vi, describe, expect, it } from 'vitest';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { DirectoryGameFileProvider } from '../../src/platform/browser/files/directory';
import { OverlayGameFileProvider } from '../../src/resources/providers/overlay';
import { type GameFileProvider } from '../../src/resources/contracts';
import { type GameSource } from '../../src/games/source';
import type { VmAudioSink, VmCorePlatform } from '../../src/adapter/vmCore';
import {
  createVmWorkerController,
  installVmWorker,
  type VmWorkerCore,
  type VmWorkerControllerDependencies,
} from '../../src/adapter/vmWorkerController';
import type { MainToWorkerMessage, VmInitConfig, WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import type { GameVmCallbacks } from '../../src/app/session/runtimeEvents';
import type { VmFrame } from '../../src/vm86/win32';
import type { VmDiagnosticAction, VmDiagnostics } from '../../src/adapter/vmDiagnostics';

class FakeProvider implements GameFileProvider {
  readonly label = 'controller-test';
  async read(): Promise<Uint8Array | null> {
    return null;
  }
  async write(): Promise<void> {}
  async flush(): Promise<void> {}
  async list(): Promise<string[]> {
    return [];
  }
}

class ReinitFile {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    public bytes = new Uint8Array(),
  ) {}

  async getFile(): Promise<Blob> {
    return new Blob([this.bytes]);
  }

  async createWritable() {
    return {
      write: async (data: ArrayBuffer) => {
        this.bytes = new Uint8Array(data.slice(0));
      },
      close: async () => {},
    };
  }
}

class ReinitDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, ReinitFile | ReinitDirectory>();

  constructor(readonly name: string) {}

  async *entries() {
    yield* this.children;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof ReinitDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new ReinitDirectory(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof ReinitFile) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new ReinitFile(name);
    this.children.set(name, created);
    return created;
  }
}

class FakeAudio implements VmAudioSink {
  createBuffer(): void {}
  duplicateBuffer(): boolean {
    return true;
  }
  setFormat(): boolean {
    return true;
  }
  writeBuffer(_id: number, _offset: number, bytes: Uint8Array): number {
    return bytes.byteLength;
  }
  play(): boolean {
    return true;
  }
  stop(): boolean {
    return true;
  }
  setCurrentPosition(): boolean {
    return true;
  }
  setVolume(): boolean {
    return true;
  }
  setPan(): boolean {
    return true;
  }
  setFrequency(): boolean {
    return true;
  }
  getState(): { positionBytes: number; playing: boolean } | null {
    return null;
  }
  releaseBuffer(): boolean {
    return true;
  }
  setMasterVolume(): void {}
  stopAll(): void {}
  async destroy(): Promise<void> {}
}

class FakeCore implements VmWorkerCore {
  async getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics> {
    this.calls.push(`diagnostics:${action}`);
    if (this.fail === 'diagnostics') throw new Error('diagnostics failed');
    return { sampledAtMs: 12, phase: 'running', hypercalls: 123, clockRate: this.clock, execution: null, game: null };
  }
  readonly calls: string[] = [];
  fileProvider: GameFileProvider | null = null;
  callbacks: GameVmCallbacks | null = null;
  platform: VmCorePlatform | null = null;
  fail: string | null = null;
  clock = 0;
  volume = 0;

  async start(): Promise<void> {
    this.calls.push('start');
    if (this.fail === 'start') throw new Error('start failed');
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.fail === 'stop') throw new Error('stop failed');
  }

  async flushFiles(): Promise<void> {
    this.calls.push('flush');
    if (this.fail === 'flush') throw new Error('flush failed');
  }

  postMessage(): void {}
  setKeyState(): void {}
  setCursorPosition(): void {}
  setGameClockRate(rate: number): number {
    this.clock = rate;
    return rate;
  }
  setMasterVolume(volume: number): void {
    this.volume = volume;
  }
  getPointerState(): null {
    return null;
  }
  async getGamePerformance(): Promise<null> {
    return null;
  }
  setGameSpeedFlag(): null {
    return null;
  }
  startMemRecord(): boolean {
    if (this.fail === 'mem-start') throw new Error('memory start failed');
    return true;
  }
  stopMemRecord(): null {
    if (this.fail === 'mem-stop') throw new Error('memory stop failed');
    return null;
  }
  setFileProvider(files: GameFileProvider): void {
    this.fileProvider = files;
  }
}

function config(): VmInitConfig {
  return {
    provider: { kind: 'memory', label: 'fixture', files: [] },
    preferredGameId: 'ra2',
    fastFileRead: false,
    clockRate: 2,
    masterVolume: 0.5,
    traceCalls: false,
  };
}

function harness(
  options: {
    source?: GameSource;
    core?: FakeCore;
    discoverError?: Error;
    /** Use real discoverGameSources and buildProvider to test file-backend reconstruction from init messages. */
    raw?: boolean;
    captureSource?: (source: GameSource) => void;
    transferFrames?: boolean;
  } = {},
): {
  messages: WorkerToMainMessage[];
  core: FakeCore;
  controller: ReturnType<typeof createVmWorkerController>;
} {
  const game = SUPPORTED_GAMES.find((item) => item.id === 'ra2')!;
  const provider = new FakeProvider();
  const source = options.source ?? { game, files: provider, executableBytes: new Uint8Array([0x4d, 0x5a]) };
  const core = options.core ?? new FakeCore();
  const messages: WorkerToMainMessage[] = [];
  const dependencies: VmWorkerControllerDependencies = {
    postMessage: (message, transfer) =>
      messages.push(
        options.transferFrames && message.type === 'frame'
          ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
          : message,
      ),
    ...(options.raw ? {} : { createProvider: () => provider }),
    ...(options.raw
      ? {}
      : {
          discoverSources: async () => {
            if (options.discoverError) throw options.discoverError;
            return [source];
          },
        }),
    applyResolution: async (value) => value,
    createCore: (callbacks: GameVmCallbacks, _source: GameSource, platform: VmCorePlatform) => {
      core.callbacks = callbacks;
      core.platform = platform;
      options.captureSource?.(_source);
      return core;
    },
    fetchBytes: async () => new Uint8Array(),
    audio: new FakeAudio(),
  };
  return { messages, core, controller: createVmWorkerController(dependencies) };
}

function message<T extends WorkerToMainMessage['type']>(
  messages: WorkerToMainMessage[],
  type: T,
): Extract<WorkerToMainMessage, { type: T }> {
  const found = messages.find((item) => item.type === type);
  if (!found) throw new Error(`missing ${type}`);
  return found as Extract<WorkerToMainMessage, { type: T }>;
}

function frame(value: number): VmFrame {
  return {
    width: 1,
    height: 1,
    pixels: new Uint8Array([value]),
    palette: new Uint8Array(1024),
  };
}

describe('VmWorkerController request-scoped errors', () => {
  it('routes capture actions and correlates probe errors without stopping the VM', async () => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 1 });
    await controller.handleMessage({ type: 'diagnostics', action: 'start', requestId: 2 });
    expect(core.calls).toContain('diagnostics:start');
    expect(messages).toContainEqual({
      type: 'diagnostics-reply',
      requestId: 2,
      value: expect.objectContaining({ hypercalls: 123, execution: null }),
    });
    core.fail = 'diagnostics';
    await controller.handleMessage({ type: 'diagnostics', action: 'stop', requestId: 3 });
    expect(messages).toContainEqual({ type: 'error', requestId: 3, message: 'diagnostics failed' });
    expect(core.calls).not.toContain('stop');
    controller.dispose();
  });
  it('性能探针在 Worker 内读取并返回原始采样时间', async () => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 1 });
    const read = vi.spyOn(core, 'getGamePerformance').mockResolvedValue(null);
    await controller.handleMessage({ type: 'game-performance', requestId: 7 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual({ type: 'game-performance-reply', requestId: 7, value: null });
  });
  it('启动导航随 init 传入共用核心，缺省不启用', async () => {
    const first = harness();
    await first.controller.handleMessage({
      type: 'init',
      config: { ...config(), startupPage: 'skirmish' },
      requestId: 1,
    });
    expect(first.core.platform?.startupPage).toBe('skirmish');
    const second = harness();
    await second.controller.handleMessage({ type: 'init', config: config(), requestId: 2 });
    expect(second.core.platform?.startupPage).toBeUndefined();
  });
  it('uses one request id for init/start and preserves their order', async () => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 10 });
    await controller.handleMessage({ type: 'control', action: 'start', requestId: 11 });

    expect(message(messages, 'init-done').requestId).toBe(10);
    expect(message(messages, 'control-done').requestId).toBe(11);
    expect(messages.findIndex((item) => item.type === 'init-done')).toBeLessThan(
      messages.findIndex((item) => item.type === 'control-done'),
    );
    expect(core.calls).toEqual(['start']);
    expect(core.clock).toBe(2);
    expect(core.volume).toBe(0.5);
  });

  it.each([
    ['flush', 21],
    ['stop', 22],
  ] as const)('returns %s failures with the original request id', async (operation, requestId) => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 1 });
    core.fail = operation;
    const request: MainToWorkerMessage =
      operation === 'flush' ? { type: 'flush', requestId } : { type: 'control', action: 'stop', requestId };
    await controller.handleMessage(request);

    expect(message(messages, 'error')).toMatchObject({ requestId, message: `${operation} failed` });
    expect(messages.some((item) => item.type === 'flush-done' || item.type === 'control-done')).toBe(false);
  });

  it.each([
    ['mem-record-start', 'mem-start', 31],
    ['mem-record-stop', 'mem-stop', 32],
  ] as const)('returns %s failures with the original request id', async (operation, failure, requestId) => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 1 });
    core.fail = failure;
    await controller.handleMessage(
      operation === 'mem-record-start'
        ? { type: 'mem-record-start', requestId }
        : { type: 'mem-record-stop', requestId },
    );

    expect(message(messages, 'error')).toMatchObject({ requestId });
  });

  it('reports init and start failures as request-scoped error plus status error', async () => {
    const initHarness = harness({ discoverError: new Error('discover failed') });
    await initHarness.controller.handleMessage({ type: 'init', config: config(), requestId: 41 });
    expect(initHarness.messages).toContainEqual({ type: 'error', requestId: 41, message: 'discover failed' });
    expect(initHarness.messages).toContainEqual({ type: 'status', phase: 'error', detail: 'discover failed' });

    const startHarness = harness();
    startHarness.core.fail = 'start';
    await startHarness.controller.handleMessage({ type: 'init', config: config(), requestId: 42 });
    await startHarness.controller.handleMessage({ type: 'control', action: 'start', requestId: 43 });
    expect(startHarness.messages).toContainEqual({ type: 'error', requestId: 43, message: 'start failed' });
    expect(startHarness.messages).toContainEqual({ type: 'status', phase: 'error', detail: 'start failed' });
  });

  it('rebuilds a session package provider from init message files (memory kind)', async () => {
    const captured: { source: GameSource | null } = { source: null };
    const { controller, messages } = harness({
      raw: true,
      captureSource: (source) => {
        captured.source = source;
      },
    });
    const sessionConfig: VmInitConfig = {
      ...config(),
      provider: {
        kind: 'memory',
        label: 'ZIP 压缩包',
        files: [{ path: 'game.exe', bytes: new Uint8Array([0x4d, 0x5a, 1]) }],
      },
    };
    await controller.handleMessage({ type: 'init', config: sessionConfig, requestId: 60 });
    expect(message(messages, 'init-done').requestId).toBe(60);
    expect(captured.source?.files).toBeInstanceOf(SessionGameFileProvider);
    expect(await captured.source!.files.read('game.exe')).toEqual(new Uint8Array([0x4d, 0x5a, 1]));
    expect(await captured.source!.files.list('')).toContain('game.exe');
  });

  it('在 Worker 游戏发现之后挂载附加地图，HTTP 后端也不丢包', async () => {
    let received: GameSource | undefined;
    const { controller, messages } = harness({
      captureSource: (source) => {
        received = source;
      },
    });
    const files = [
      { path: 'ra2md.csf', bytes: new Uint8Array([1]) },
      { path: 'map.yrm', bytes: new Uint8Array([2]) },
      { path: 'map.mpr', bytes: new Uint8Array([3]) },
    ];
    await controller.handleMessage({ type: 'init', config: { ...config(), additionalFiles: files }, requestId: 61 });
    expect(message(messages, 'init-done').requestId).toBe(61);
    expect(await received!.files.list('')).toEqual(expect.arrayContaining(['map.yrm', 'map.mpr']));
    expect(await received!.files.list('')).not.toContain('ra2md.csf');
    expect(await received!.files.read('ra2md.csf')).toBeNull();
    for (const { path, bytes } of files.slice(1)) expect(await received!.files.read(path)).toEqual(bytes);
    controller.dispose();
  });

  it('初始化后可连续动态挂载，过滤 CSF，且不停止或重启 VM', async () => {
    const { controller, core, messages } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 70 });
    await controller.handleMessage({
      type: 'attach-maps',
      requestId: 71,
      files: [
        { path: 'first.mpr', bytes: new Uint8Array([1]) },
        { path: 'ra2.csf', bytes: new Uint8Array([9]) },
      ],
    });
    expect(message(messages, 'attach-maps-done').result).toEqual({ attached: ['first.mpr'], existing: [] });
    await controller.handleMessage({
      type: 'attach-maps',
      requestId: 72,
      files: [{ path: 'second.yrm', bytes: new Uint8Array([2]) }],
    });
    expect(await core.fileProvider!.list('')).toEqual(expect.arrayContaining(['first.mpr', 'second.yrm']));
    expect(await core.fileProvider!.read('ra2.csf')).toBeNull();
    expect(core.calls).not.toContain('start');
    expect(core.calls).not.toContain('stop');
    controller.dispose();
  });

  it('rebuilds a directory provider with package overlays from init message', async () => {
    const root = new ReinitDirectory('INSTALL');
    root.children.set('game.exe', new ReinitFile('game.exe', new Uint8Array([0x4d, 0x5a, 2])));
    const captured: { source: GameSource | null } = { source: null };
    const { controller, messages } = harness({
      raw: true,
      captureSource: (source) => {
        captured.source = source;
      },
    });
    const overlayConfig: VmInitConfig = {
      ...config(),
      provider: {
        kind: 'directory',
        handle: root as unknown as FileSystemDirectoryHandle,
        overlays: [{ path: 'language.mix', bytes: new Uint8Array([7, 7, 7]) }],
      },
    };
    await controller.handleMessage({ type: 'init', config: overlayConfig, requestId: 61 });
    expect(message(messages, 'init-done').requestId).toBe(61);
    expect(captured.source?.files).toBeInstanceOf(OverlayGameFileProvider);
    expect(await captured.source!.files.read('language.mix')).toEqual(new Uint8Array([7, 7, 7]));
    expect(await captured.source!.files.read('game.exe')).toEqual(new Uint8Array([0x4d, 0x5a, 2]));
  });

  it.each(['directory', 'memory'] as const)('%s 在发现前覆盖选中 EXE，装载与 FS 一致且不写回旧文件', async (kind) => {
    const oldBytes = new Uint8Array([0x4d, 0x5a, 2]);
    const selectedBytes = new Uint8Array([0x4d, 0x5a, 9]);
    const root = new ReinitDirectory('INSTALL');
    root.children.set('game.exe', new ReinitFile('game.exe', oldBytes));
    let received: GameSource | undefined;
    const { controller, messages } = harness({
      raw: true,
      captureSource: (source) => {
        received = source;
      },
    });
    await controller.handleMessage({
      type: 'init',
      requestId: 62,
      config: {
        ...config(),
        provider:
          kind === 'directory'
            ? { kind: 'directory', handle: root as unknown as FileSystemDirectoryHandle }
            : { kind: 'memory', label: '旧版本体', files: [{ path: 'game.exe', bytes: oldBytes }] },
        selectedExecutable: { path: 'game.exe', bytes: selectedBytes },
      },
    });
    expect(message(messages, 'init-done').requestId).toBe(62);
    expect(received!.executableBytes).toEqual(selectedBytes);
    expect(await received!.files.read('game.exe')).toEqual(selectedBytes);
    expect(await new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle).read('game.exe')).toEqual(
      oldBytes,
    );
    controller.dispose();
  });

  it('RGB565 帧通过 transfer 交出独立缓冲区，而不是跨线程再复制', async () => {
    const { controller, messages, core } = harness({ transferFrames: true });
    await controller.handleMessage({ type: 'init', config: config(), requestId: 51 });
    expect(core.platform?.packedRgb565Frames).toBe(true);
    const packed = { ...frame(0), rgb565: new Uint16Array([0xf800]) };
    core.platform!.scheduleFrame(() => core.callbacks!.onFrame!(packed));
    await Promise.resolve();
    const received = message(messages, 'frame');
    expect(packed.rgb565.byteLength).toBe(0);
    expect([...received.frame.rgb565!]).toEqual([0xf800]);
    await controller.handleMessage({ type: 'control', action: 'stop', requestId: 52 });
  });

  it('holds frames until the right ACK, keeps only the latest pending frame, and drops it on stop', async () => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 51 });

    const emitFrame = (value: number) => {
      core.platform?.scheduleFrame(() => core.callbacks?.onFrame?.(frame(value)));
    };
    const frames = () =>
      messages.filter((item): item is Extract<WorkerToMainMessage, { type: 'frame' }> => item.type === 'frame');

    emitFrame(1);
    await Promise.resolve();
    expect(frames()).toHaveLength(1);

    emitFrame(2);
    emitFrame(3);
    await Promise.resolve();
    expect(frames()).toHaveLength(1);

    await controller.handleMessage({ type: 'frame-ack', frameId: 99 });
    await Promise.resolve();
    expect(frames()).toHaveLength(1);

    await controller.handleMessage({ type: 'frame-ack', frameId: 1 });
    await Promise.resolve();
    expect(frames()).toHaveLength(2);
    expect(frames()[1]?.frame.pixels[0]).toBe(3);

    await controller.handleMessage({ type: 'frame-ack', frameId: 1 });
    await Promise.resolve();
    expect(frames()).toHaveLength(2);

    emitFrame(4);
    await controller.handleMessage({ type: 'control', action: 'stop', requestId: 52 });
    await Promise.resolve();
    expect(frames()).toHaveLength(2);
    await controller.handleMessage({ type: 'frame-ack', frameId: 2 });
    await Promise.resolve();
    expect(frames()).toHaveLength(2);
  });

  it('does not execute an ACK-released frame when stop wins before its microtask', async () => {
    const { controller, messages, core } = harness();
    await controller.handleMessage({ type: 'init', config: config(), requestId: 61 });

    const emitFrame = (value: number) => {
      core.platform?.scheduleFrame(() => core.callbacks?.onFrame?.(frame(value)));
    };
    const frames = () =>
      messages.filter((item): item is Extract<WorkerToMainMessage, { type: 'frame' }> => item.type === 'frame');
    emitFrame(1);
    await Promise.resolve();
    emitFrame(2);

    const acknowledging = controller.handleMessage({ type: 'frame-ack', frameId: 1 });
    const stopping = controller.handleMessage({ type: 'control', action: 'stop', requestId: 62 });
    await Promise.all([acknowledging, stopping]);
    await Promise.resolve();

    expect(core.calls).toContain('stop');
    expect(frames()).toHaveLength(1);
  });

  it('exercises the real worker bootstrap and preserves request ids through its queue', async () => {
    const messages: WorkerToMainMessage[] = [];
    const scope = {
      onmessage: null,
      postMessage: (message: WorkerToMainMessage) => messages.push(message),
    } as unknown as Parameters<typeof installVmWorker>[0];
    const controller = installVmWorker(scope);

    expect(messages).toContainEqual({ type: 'probe', ready: true });
    scope.onmessage?.({ data: { type: 'flush', requestId: 77 } } as MessageEvent<MainToWorkerMessage>);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toContainEqual({ type: 'flush-done', requestId: 77 });
    controller.dispose();
  });
});
