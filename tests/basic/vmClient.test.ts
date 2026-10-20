import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerVmClient } from '../../src/adapter/vmClient';
import type { WebAudioPcmSink } from '../../src/adapter/audio';
import type { VmInitConfig, WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import type { GameVmCallbacks, VmStatus } from '../../src/app/session/runtimeEvents';
import type { VmFrame } from '../../src/vm86/win32';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posts: unknown[] = [];
  terminateCount = 0;

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  terminate(): void {
    this.terminateCount++;
  }

  emit(message: WorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerToMainMessage>);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({} as MessageEvent);
  }
}

function initConfig(): VmInitConfig {
  return {
    provider: { kind: 'memory', label: 'fixture', files: [] },
    preferredGameId: 'ra2',
    fastFileRead: false,
    clockRate: 1,
    masterVolume: 0.25,
    traceCalls: false,
  };
}

function fakeAudio(): WebAudioPcmSink {
  return {
    installUserGestureUnlock: () => () => {},
    destroy: vi.fn(async () => {}),
    createBuffer: () => {},
    duplicateBuffer: () => true,
    setFormat: () => true,
    writeBuffer: (_id: number, _offset: number, bytes: Uint8Array) => bytes.byteLength,
    play: () => true,
    stop: () => true,
    setCurrentPosition: () => true,
    setVolume: () => true,
    setPan: () => true,
    setFrequency: () => true,
    getState: () => null,
    releaseBuffer: () => true,
    setMasterVolume: () => {},
    stopAll: () => {},
  } as unknown as WebAudioPcmSink;
}

function requestId(worker: FakeWorker, type: string): number {
  const message = [...worker.posts].reverse().find((item) => (item as { type?: string }).type === type) as
    | { requestId: number }
    | undefined;
  if (!message) throw new Error(`missing ${type}`);
  return message.requestId;
}

function setup(
  options: {
    onTerminated?: () => void;
    startupTimeoutMs?: number;
    recycleFrames?: boolean;
  } = {},
  callbacks: GameVmCallbacks = {},
  emitProbe = true,
) {
  const { ...clientOptions } = options;
  const worker = new FakeWorker();
  const audio = fakeAudio();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {});
  const client = new WorkerVmClient(callbacks, initConfig(), {
    workerFactory: () => worker as unknown as Worker,
    audio,
    ...clientOptions,
  });
  if (emitProbe) worker.emit({ type: 'probe', ready: true });
  return { worker, audio, client };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WorkerVmClient RPC lifecycle', () => {
  it('returns audio observations to the Worker and ignores late audio commands during destruction', async () => {
    vi.useFakeTimers();
    const { worker, audio, client } = setup();
    const snapshot = { positionBytes: 40, writePositionBytes: 80, playing: true };
    vi.spyOn(audio, 'getState').mockReturnValue(snapshot as ReturnType<WebAudioPcmSink['getState']>);
    const play = vi.spyOn(audio, 'play');
    const stopAll = vi.spyOn(audio, 'stopAll');
    worker.emit({ type: 'audio', revision: 7, op: { op: 'play', id: 3 } });
    expect(worker.posts).toContainEqual({ type: 'audio-state', states: [{ id: 3, revision: 7, ...snapshot }] });
    const destroying = client.destroy();
    worker.emit({ type: 'audio', revision: 8, op: { op: 'play', id: 3 } });
    expect(play).toHaveBeenCalledTimes(1);
    expect(stopAll).toHaveBeenCalledTimes(1);
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroying;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('显式开启回收时只归还已替换帧，当前帧继续可用于光标重绘', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const frames: VmFrame[] = [1, 2].map((value) => ({
      width: 1,
      height: 1,
      pixels: new Uint8Array(),
      palette: new Uint8Array(),
      rgb565: new Uint16Array([value]),
    }));
    const { worker, client } = setup({ recycleFrames: true }, { onFrame: vi.fn() });
    worker.postMessage = (message: unknown, transfer: Transferable[] = []) => {
      worker.posts.push(structuredClone(message, { transfer }));
    };
    worker.emit({ type: 'frame', frameId: 1, frame: frames[0]! });
    expect(worker.posts.some((item: any) => item.type === 'recycle-frame')).toBe(false);
    worker.emit({ type: 'frame', frameId: 2, frame: frames[1]! });
    const recycled = worker.posts.filter((item: any) => item.type === 'recycle-frame') as Array<{
      buffer: ArrayBuffer;
    }>;
    expect(recycled).toHaveLength(1);
    expect(new Uint16Array(recycled[0]!.buffer)).toEqual(new Uint16Array([1]));
    expect(frames[0]!.rgb565!.byteLength).toBe(0);
    expect(frames[1]!.rgb565![0]).toBe(2);
    const destroying = client.destroy();
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroying;
  });
  it('Worker 网络状态透传到页面，销毁后不再投递', async () => {
    const onNetworkStatus = vi.fn();
    const { worker, client } = setup({}, { onNetworkStatus });
    const status = { phase: 'connected' as const, room: 'r', peers: 7, detail: '', relayRttMs: 42 };
    worker.emit({ type: 'network-status', status });
    expect(onNetworkStatus).toHaveBeenCalledWith(status);
    const destroying = client.destroy();
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroying;
    worker.emit({ type: 'network-status', status });
    expect(onNetworkStatus).toHaveBeenCalledTimes(1);
  });
  it('rejects probe and cleans up without reporting a runtime error', async () => {
    const statuses: VmStatus[] = [];
    const { worker, client } = setup({}, { onStatus: (status) => statuses.push(status) }, false);

    const probe = expect(client.waitProbe()).rejects.toThrow('worker failed before probe');
    worker.emitError('worker failed before probe');

    await probe;
    expect(statuses).toEqual([]);
    await client.destroy();
    expect(worker.terminateCount).toBe(1);
  });

  it('times out probe without reporting a runtime error', async () => {
    vi.useFakeTimers();
    const statuses: VmStatus[] = [];
    const { worker, client } = setup({}, { onStatus: (status) => statuses.push(status) }, false);

    const probe = expect(client.waitProbe()).rejects.toThrow('worker 能力探测超时');
    vi.advanceTimersByTime(3_001);

    await probe;
    expect(statuses).toEqual([]);
    await client.destroy();
    expect(worker.terminateCount).toBe(1);
  });

  it('真实游戏性能 RPC 按请求返回，销毁后拒绝采样', async () => {
    const { worker, client } = setup();
    const pending = client.getGamePerformance();
    const id = requestId(worker, 'game-performance');
    const value = {
      frame: 60,
      gameSpeed: 0,
      sessionSpeed: 0,
      requestedFps: 60,
      sampledAtMs: 1000,
      intervalMs: 1000,
      logicFps: 30,
      status: 'sample' as const,
    };
    worker.emit({ type: 'game-performance-reply', requestId: id, value });
    await expect(pending).resolves.toEqual(value);
    const destroying = client.destroy();
    worker.emitMessageError();
    await destroying;
    await expect(client.getGamePerformance()).rejects.toThrow('worker 消息反序列化失败');
  });

  it('reports actual Worker mode and routes diagnostic captures through the existing request lifecycle', async () => {
    const { worker, client } = setup();
    expect(client.runtimeInfo).toMatchObject({ mode: 'worker', reason: 'default', fallbackReason: null });
    expect(client.runtimeInfo.workerProbeMs).toBeGreaterThanOrEqual(0);
    const pending = client.getDiagnostics('start');
    const value = {
      sampledAtMs: 55,
      phase: 'running' as const,
      hypercalls: 80,
      clockRate: 1,
      execution: null,
      game: null,
    };
    worker.emit({ type: 'diagnostics-reply', requestId: requestId(worker, 'diagnostics'), value });
    await expect(pending).resolves.toEqual(value);
    const sample = client.getDiagnostics('sample');
    const rejected = expect(sample).rejects.toThrow('worker 消息反序列化失败');
    worker.emitMessageError();
    await rejected;
    await client.destroy();
  });

  it('rejects and removes a request-scoped worker error without killing the worker', async () => {
    const { worker, client } = setup();
    const pending = client.getPointerState();
    const id = requestId(worker, 'state');
    worker.emit({ type: 'error', requestId: id, message: 'state failed' });

    await expect(pending).rejects.toThrow('state failed');
    expect(worker.terminateCount).toBe(0);
  });

  it('动态地图 RPC 过滤 CSF，复制字节并等待挂载确认', async () => {
    const { worker, client } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = client.attachMapFiles(
      new Map([
        ['a.mpr', bytes],
        ['RA2.CSF', new Uint8Array([4])],
      ]),
    );
    const id = requestId(worker, 'attach-maps');
    const sent = worker.posts.find((post: any) => post.type === 'attach-maps') as {
      files: { path: string; bytes: Uint8Array }[];
    };
    expect(sent.files.map(({ path }) => path)).toEqual(['a.mpr']);
    expect(sent.files[0]!.bytes.buffer).not.toBe(bytes.buffer);
    worker.emit({ type: 'attach-maps-done', requestId: id, result: { attached: ['a.mpr'], existing: [] } });
    await expect(pending).resolves.toEqual({ attached: ['a.mpr'], existing: [] });
  });

  it('uses the separate startup timeout for delayed init and start replies', async () => {
    vi.useFakeTimers();
    const { worker, client } = setup({ startupTimeoutMs: 30_000 });
    const starting = client.start();
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    const initId = requestId(worker, 'init');
    vi.advanceTimersByTime(10_001);
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.emit({ type: 'init-done', requestId: initId });
    await Promise.resolve();
    const startId = requestId(worker, 'control');
    vi.advanceTimersByTime(10_001);
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.emit({ type: 'control-done', action: 'start', requestId: startId });
    await expect(starting).resolves.toBeUndefined();

    const destroying = client.destroy();
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroying;
  });

  it('times out an unanswered ordinary RPC and ignores its late reply', async () => {
    vi.useFakeTimers();
    const { worker, client } = setup();
    const pending = client.getPointerState();
    const id = requestId(worker, 'state');
    const rejection = expect(pending).rejects.toThrow('worker 请求超时');

    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    expect(requestCount(client)).toBe(0);

    worker.emit({ type: 'state-reply', requestId: id, kind: 'pointer', value: null });
    expect(requestCount(client)).toBe(0);

    const destroying = client.destroy();
    await vi.advanceTimersByTimeAsync(10_001);
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(destroying).resolves.toBeUndefined();
    expect(worker.terminateCount).toBe(1);
  });

  it('settles a pending RPC when destroy receives no replies', async () => {
    vi.useFakeTimers();
    const { worker, client } = setup();
    const pending = client.getPointerState();
    const destroying = client.destroy();
    const rejection = expect(pending).rejects.toThrow('worker 请求超时');

    await vi.advanceTimersByTimeAsync(10_001);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    await expect(destroying).resolves.toBeUndefined();
    expect(requestCount(client)).toBe(0);
    expect(worker.terminateCount).toBe(1);
  });

  it('sends frame ACK only at the rAF boundary and cancels a queued ACK on destroy', async () => {
    let nextFrameCallback = 1;
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameCallback++;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelled.push(id);
      frameCallbacks.delete(id);
    });
    const frame: VmFrame = {
      width: 1,
      height: 1,
      pixels: new Uint8Array([1]),
      palette: new Uint8Array(1024),
    };
    const { worker, client } = setup({}, { onFrame: vi.fn() });

    worker.emit({ type: 'frame', frameId: 7, frame });
    expect(worker.posts.some((item) => (item as { type?: string }).type === 'frame-ack')).toBe(false);
    const firstRaf = [...frameCallbacks.keys()][0]!;
    frameCallbacks.get(firstRaf)?.(0);
    frameCallbacks.delete(firstRaf);
    expect(worker.posts).toContainEqual({ type: 'frame-ack', frameId: 7 });

    worker.emit({ type: 'frame', frameId: 8, frame });
    const secondRaf = [...frameCallbacks.keys()][0]!;
    const destroying = client.destroy();
    expect(cancelled).toContain(secondRaf);
    frameCallbacks.get(secondRaf)?.(0);
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroying;
    expect(worker.posts.filter((item) => (item as { type?: string }).type === 'frame-ack')).toEqual([
      { type: 'frame-ack', frameId: 7 },
    ]);
  });

  it('fatal worker errors reject pending calls and destroy does not send stop/flush again', async () => {
    const statuses: VmStatus[] = [];
    const releaseRelay = vi.fn();
    const { worker, client } = setup({ onTerminated: releaseRelay }, { onStatus: (status) => statuses.push(status) });
    const pending = client.getPointerState();
    worker.emitError('worker crashed');
    expect(releaseRelay).toHaveBeenCalledOnce();

    await expect(pending).rejects.toThrow('worker crashed');
    expect(statuses).toContainEqual({ phase: 'error', detail: 'worker crashed' });
    await client.destroy();
    expect(releaseRelay).toHaveBeenCalledOnce();
    expect(worker.posts.filter((item) => (item as { type?: string }).type === 'control')).toHaveLength(0);
    expect(worker.posts.filter((item) => (item as { type?: string }).type === 'flush')).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
    expect((audioDestroy(client) as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('messageerror during destroy follows fatal cleanup and skips the remaining flush RPC', async () => {
    const { worker, client, audio } = setup();
    const destroying = client.destroy();
    worker.emitMessageError();
    await destroying;

    expect(worker.posts.filter((item) => (item as { type?: string }).type === 'flush')).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
    expect((audio.destroy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('concurrent destroy calls share one cleanup and complete stop/flush once', async () => {
    const { worker, client, audio } = setup();
    const start = client.start();
    await Promise.resolve();
    worker.emit({ type: 'init-done', requestId: requestId(worker, 'init') });
    await Promise.resolve();
    worker.emit({ type: 'control-done', action: 'start', requestId: requestId(worker, 'control') });
    await start;

    const first = client.destroy();
    const second = client.destroy();
    expect(first).toBe(second);
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await Promise.all([first, second]);

    expect(
      worker.posts.filter(
        (item) =>
          (item as { type?: string; action?: string }).type === 'control' &&
          (item as { action?: string }).action === 'stop',
      ),
    ).toHaveLength(1);
    expect(worker.posts.filter((item) => (item as { type?: string }).type === 'flush')).toHaveLength(1);
    expect(worker.terminateCount).toBe(1);
    expect((audio.destroy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('rejects new promise calls and ignores void calls after destroy begins', async () => {
    const { worker, client } = setup();
    const destroy = client.destroy();
    client.setKeyState(65, true);
    await expect(client.getPointerState()).rejects.toThrow('VM 已销毁');
    worker.emit({ type: 'control-done', action: 'stop', requestId: requestId(worker, 'control') });
    await Promise.resolve();
    worker.emit({ type: 'flush-done', requestId: requestId(worker, 'flush') });
    await destroy;
    expect(worker.posts.some((item) => (item as { type?: string }).type === 'key')).toBe(false);
  });
});

function audioDestroy(client: WorkerVmClient): unknown {
  return (client as unknown as { audio: WebAudioPcmSink }).audio.destroy;
}

function requestCount(client: WorkerVmClient): number {
  return (client as unknown as { requests: Map<number, unknown> }).requests.size;
}
