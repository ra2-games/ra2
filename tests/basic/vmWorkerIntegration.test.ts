import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { VmCore, type VmAudioSink } from '../../src/adapter/vmCore';
import { WorkerVmClient } from '../../src/adapter/vmClient';
import { createVmShell, hashRa2Executable, resolveRa2NetworkConfig, Win32GameVm } from '../../src/adapter/runtime';
import {
  installVmWorker,
  type VmWorkerController,
  type VmWorkerControllerDependencies,
} from '../../src/adapter/vmWorkerController';
import type { MainToWorkerMessage, VmInitConfig, WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import type { GameFileProvider } from '../../src/resources/contracts';
import type { GameSource } from '../../src/games/source';
import { SUPPORTED_GAMES, type SupportedGame } from '../../src/games/catalog';
import type { Win32ShimOptions } from '../../src/vm86/win32';
import type { Win32Shim } from '../../src/games/win32Shim';
import * as gameShim from '../../src/games/win32Shim';
import type { V86 } from 'v86';
import type { WebAudioPcmSink } from '../../src/adapter/audio';
import { FIXTURE_ABI, buildFixturePe } from '../fixture/fixtureProgram';

vi.mock('v86', () => {
  class FallbackEmulator {
    private readonly memory = new Uint8Array(32 * 1024 * 1024);
    private running = false;
    private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    add_listener(name: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      if (name === 'emulator-ready') queueMicrotask(() => listener());
    }

    remove_listener(name: string, listener: (...args: unknown[]) => void): void {
      this.listeners.get(name)?.delete(listener);
    }

    write_memory(data: number[] | Uint8Array, address: number): void {
      this.memory.set(data, address);
    }
    read_memory(address: number, length: number): Uint8Array {
      return this.memory.subarray(address, address + length);
    }
    is_running(): boolean {
      return this.running;
    }
    serial0_send(): void {}
    async run(): Promise<void> {
      this.running = true;
    }
    async stop(): Promise<void> {
      this.running = false;
    }
    async destroy(): Promise<void> {
      this.running = false;
    }
  }
  return { V86: FallbackEmulator };
});

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }
  reject(error: unknown): void {
    this.rejectPromise(error);
  }
}

class IntegrationProvider implements GameFileProvider {
  readonly label = 'worker-integration';
  readonly files = new Map<string, Uint8Array>();
  readonly events: string[] = [];
  readonly writeStarted = new Deferred<void>();
  writeGate: Promise<void> | null = null;
  writeError: Error | null = null;
  flushError: Error | null = null;

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.events.push(`write:start:${path}`);
    this.writeStarted.resolve();
    if (this.writeGate) await this.writeGate;
    if (this.writeError) throw this.writeError;
    this.files.set(path, bytes.slice());
    this.events.push(`write:done:${path}`);
  }

  async flush(): Promise<void> {
    this.events.push('flush');
    if (this.flushError) throw this.flushError;
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

class IntegrationAudio implements VmAudioSink {
  readonly destroy = vi.fn(async () => {});
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
  installUserGestureUnlock(): () => void {
    return () => {};
  }
}

class IntegrationEmulator {
  readonly destroy = vi.fn(async () => {
    this.running = false;
  });
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  readonly run = vi.fn(async () => {
    if (this.runError) throw this.runError;
    this.running = true;
  });
  runError: Error | null = null;
  private readonly memory = new Uint8Array(32 * 1024 * 1024);
  private running = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  add_listener(name: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    if (name === 'emulator-ready') queueMicrotask(() => listener());
  }

  remove_listener(name: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  write_memory(data: number[] | Uint8Array, address: number): void {
    this.memory.set(data, address);
  }
  read_memory(address: number, length: number): Uint8Array {
    return this.memory.subarray(address, address + length);
  }
  is_running(): boolean {
    return this.running;
  }
  serial0_send(): void {}
}

class IntegrationShim {
  private readonly onFileWrite: Win32ShimOptions['onFileWrite'];
  readonly network = {
    enabled: false,
    room: undefined as string | undefined,
    exeHash: undefined as string | undefined,
  };

  constructor(options: Win32ShimOptions) {
    this.onFileWrite = options.onFileWrite;
    this.network.enabled = options.ra2NetworkEnabled === true;
    this.network.room = options.ra2NetworkRoom;
    this.network.exeHash = options.ra2ExeHash;
  }

  setGameClockRate(): void {}
  dispose(): void {}
  emitFileWrite(path: string, bytes: Uint8Array): void {
    this.onFileWrite?.(path, bytes);
  }
}

function fixtureSource(provider: IntegrationProvider): GameSource {
  const base = SUPPORTED_GAMES.find((item) => item.id === 'ra2')!;
  const game: SupportedGame = {
    ...base,
    title: 'worker integration fixture',
    executable: 'fixture.exe',
    abi: FIXTURE_ABI,
    argBytes: (dll, name) => FIXTURE_ABI[`${dll.toUpperCase()}!${name}`] ?? 0,
    shimProfile: { ...base.shimProfile },
    runtimeHooks: undefined,
    preloadFiles: [],
    guestMemoryBytes: 32 * 1024 * 1024,
    stackTop: 0x0070_0000,
    heapBase: 0x00e0_0000,
    arenaTop: 0x00e0_0000,
    fastFileMirrorBase: undefined,
    fastFileMirrorTop: undefined,
    fastFileMirrorFiles: undefined,
    driveTypes: undefined,
  };
  return { game, files: provider, executableBytes: buildFixturePe().built.exe };
}

function config(network?: VmInitConfig['ra2Network']): VmInitConfig {
  return {
    provider: { kind: 'memory', label: 'fixture', files: [] },
    preferredGameId: 'ra2',
    ...(network ? { ra2Network: network } : {}),
    fastFileRead: false,
    clockRate: 1,
    masterVolume: 0.25,
    traceCalls: false,
  };
}

class LinkedWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sentToWorker: MainToWorkerMessage[] = [];
  readonly sentToClient: WorkerToMainMessage[] = [];
  terminateCount = 0;
  terminated = false;
  scope: Parameters<typeof installVmWorker>[0] | null = null;

  postMessage(message: MainToWorkerMessage): void {
    this.sentToWorker.push(message);
    setTimeout(() => this.scope?.onmessage?.({ data: message } as MessageEvent<MainToWorkerMessage>), 0);
  }

  postFromWorker(message: WorkerToMainMessage): void {
    this.sentToClient.push(message);
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<WorkerToMainMessage>);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
    this.terminateCount++;
  }
}

interface IntegrationHarness {
  client: WorkerVmClient;
  controller: VmWorkerController;
  worker: LinkedWorker;
  provider: IntegrationProvider;
  core: VmCore | null;
  shim: IntegrationShim | null;
}

const harnesses: IntegrationHarness[] = [];

function createHarness(
  options: {
    startError?: Error;
    network?: VmInitConfig['ra2Network'];
    playerName?: string;
    onSource?: (source: GameSource) => void;
  } = {},
): IntegrationHarness {
  const provider = new IntegrationProvider();
  const source = fixtureSource(provider);
  const emulator = new IntegrationEmulator();
  emulator.runError = options.startError ?? null;
  const workerAudio = new IntegrationAudio();
  const clientAudio = new IntegrationAudio();
  let core: VmCore | null = null;
  let shim: IntegrationShim | null = null;
  // Replace the heavy shim only at the final construction boundary, preserving real arguments from the Worker to the game-configuration factory.
  vi.spyOn(gameShim, 'Win32Shim').mockImplementation(function (_memory, shimOptions) {
    shim = new IntegrationShim(shimOptions ?? {});
    return shim as unknown as Win32Shim;
  });
  const worker = new LinkedWorker();
  const dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {
    createProvider: () => provider,
    discoverSources: async () => [source],
    applyResolution: async (value) => value,
    fetchBytes: async () => new Uint8Array(readFileSync(new URL('../../src/vm86/boot.bin', import.meta.url))),
    audio: workerAudio,
    createCore: (callbacks, discovered, platform) => {
      options.onSource?.(discovered);
      core = new VmCore(callbacks, discovered, {
        ...platform,
        createEmulator: () => emulator as unknown as V86,
      });
      return core;
    },
  };
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {});
  const client = new WorkerVmClient(
    {},
    { ...config(options.network), playerName: options.playerName },
    {
      workerFactory: () => worker as unknown as Worker,
      audio: clientAudio as unknown as WebAudioPcmSink,
    },
  );
  const scope: Parameters<typeof installVmWorker>[0] = {
    onmessage: null,
    postMessage: (message, _transfer) => worker.postFromWorker(message),
  };
  worker.scope = scope;
  const controller = installVmWorker(scope, dependencies);
  const harness = {
    client,
    controller,
    worker,
    provider,
    get core() {
      return core;
    },
    get shim() {
      return shim;
    },
  } as IntegrationHarness;
  harnesses.push(harness);
  return harness;
}

function observeCoreFlush(core: VmCore): Deferred<void> {
  const entered = new Deferred<void>();
  const realFlush = core.flushFiles.bind(core);
  vi.spyOn(core, 'flushFiles').mockImplementation(async () => {
    entered.resolve();
    return realFlush();
  });
  return entered;
}

async function cleanupHarness(harness: IntegrationHarness): Promise<void> {
  harness.controller.dispose();
  if (harness.core) {
    try {
      await harness.core.destroy();
    } catch {
      /* Testing the failure path may itself make flush fail */
    }
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await cleanupHarness(harness);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkerVmClient ↔ VmWorkerController integration', () => {
  it('passes the strict RA2 network configuration through Worker init and the real configuration factory', async () => {
    const network = { room: 'integration-room', exeHash: 'c'.repeat(64) };
    const harness = createHarness({ network });
    await harness.client.start();

    expect(harness.shim?.network).toEqual({
      enabled: true,
      room: network.room,
      exeHash: network.exeHash,
    });
    await harness.client.destroy();
  });

  it('计算稳定 EXE 哈希，默认 /ra2，显式路径决定房间', async () => {
    expect(await hashRa2Executable(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const source = fixtureSource(new IntegrationProvider());
    for (const game of ['ra2', 'yr']) {
      const selected = { ...source, game: SUPPORTED_GAMES.find((item) => item.id === game)! };
      vi.stubGlobal('window', { location: { search: '?network=1' } });
      await expect(resolveRa2NetworkConfig(selected)).resolves.toEqual({
        room: 'ra2',
        exeHash: await hashRa2Executable(selected.executableBytes),
      });
      vi.stubGlobal('window', { location: { search: '?relay=127.0.0.1:15176/custom-room' } });
      await expect(resolveRa2NetworkConfig(selected)).resolves.toEqual({
        room: 'custom-room',
        relayUrl: 'ws://127.0.0.1:15176/custom-room',
        exeHash: await hashRa2Executable(selected.executableBytes),
      });
    }
    vi.stubGlobal('window', { location: { search: '?relay=127.0.0.1:15176/invalid/room' } });
    await expect(resolveRa2NetworkConfig(source)).rejects.toThrow();
  });

  it('默认单机且显式关闭优先于旧联机链接', async () => {
    const source = fixtureSource(new IntegrationProvider());
    for (const search of ['', '?network=0&relay=ws://127.0.0.1/game&ra2-room=r']) {
      vi.stubGlobal('window', { location: { search } });
      await expect(resolveRa2NetworkConfig(source)).resolves.toBeUndefined();
    }
  });

  it.each([undefined, 'HostOne'])('forwards the room, EXE hash and player name (%s) to Worker', async (playerName) => {
    const provider = new IntegrationProvider();
    const source = fixtureSource(provider);
    const worker = new LinkedWorker();
    const room = 'url-room';
    const relayUrl = 'ws://127.0.0.1:15176/url-room';
    vi.stubGlobal('window', {
      location: { search: `?relay=${encodeURIComponent(relayUrl)}`, href: 'http://localhost/' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {});
    vi.stubGlobal('Worker', class {});
    worker.postMessage = (message: MainToWorkerMessage): void => {
      worker.sentToWorker.push(message);
      const reply =
        message.type === 'init'
          ? { type: 'init-done' as const, requestId: message.requestId }
          : message.type === 'control'
            ? { type: 'control-done' as const, action: message.action, requestId: message.requestId }
            : message.type === 'flush'
              ? { type: 'flush-done' as const, requestId: message.requestId }
              : null;
      if (reply) setTimeout(() => worker.onmessage?.({ data: reply } as MessageEvent<WorkerToMainMessage>), 0);
    };
    const shell = await createVmShell({}, source, {
      playerName,
      workerFactory: () => {
        queueMicrotask(() =>
          worker.onmessage?.({ data: { type: 'probe', ready: true } } as MessageEvent<WorkerToMainMessage>),
        );
        return worker as unknown as Worker;
      },
      audio: new IntegrationAudio() as unknown as WebAudioPcmSink,
    });

    await shell.start();
    const init = worker.sentToWorker.find(
      (message): message is Extract<MainToWorkerMessage, { type: 'init' }> => message.type === 'init',
    );
    expect(init?.config.ra2Network).toEqual({
      room,
      relayUrl,
      exeHash: await hashRa2Executable(source.executableBytes),
    });
    if (playerName) expect(init?.config.playerName).toBe(playerName);
    else expect(init?.config.playerName).toMatch(/^ra2\.games-[0-9a-z]{5}$/);
    await shell.destroy();
  });

  it('Worker 将启动用户名挂载到实际交给 VmCore 的 INI，不写回源文件', async () => {
    let mounted: GameSource | undefined;
    const harness = createHarness({
      playerName: 'Ab',
      onSource: (source) => {
        mounted = source;
      },
    });
    await harness.client.start();
    const bytes = await mounted!.files.read('RA2.INI');
    expect(new TextDecoder().decode(bytes!)).toContain('[MultiPlayer]\nHandle=41,62,');
    expect(await harness.provider.read('RA2.INI')).toBeNull();
    await harness.client.destroy();
  });

  it('runs init/start/stop/flush through the real VmCore and waits for a pending write before terminate', async () => {
    const harness = createHarness();
    await harness.client.start();
    expect(harness.core).not.toBeNull();
    expect(harness.shim).not.toBeNull();
    const flushEntered = observeCoreFlush(harness.core!);

    const gate = new Deferred<void>();
    harness.provider.writeGate = gate.promise;
    const bytes = new Uint8Array([7, 8, 9]);
    harness.shim!.emitFileWrite('save/integration.sav', bytes);
    await harness.provider.writeStarted.promise;

    const destroying = harness.client.destroy();
    await flushEntered.promise;
    expect(harness.worker.terminateCount).toBe(0);
    expect(harness.provider.events).not.toContain('flush');
    expect(harness.provider.events).not.toContain('write:done:save/integration.sav');

    gate.resolve();
    await destroying;

    expect(harness.provider.files.get('save/integration.sav')).toEqual(bytes);
    expect(harness.provider.events.indexOf('write:done:save/integration.sav')).toBeLessThan(
      harness.provider.events.indexOf('flush'),
    );
    expect(harness.worker.sentToClient.some((message) => message.type === 'flush-done')).toBe(true);
    expect(harness.worker.terminateCount).toBe(1);
  });

  it('returns a real start failure to the client as a request-scoped rejection', async () => {
    const harness = createHarness({ startError: new Error('fixture start failed') });

    await expect(harness.client.start()).rejects.toThrow('fixture start failed');
    expect(harness.worker.sentToClient).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'fixture start failed',
      }),
    );
    expect(harness.worker.sentToClient.some((message) => message.type === 'status' && message.phase === 'error')).toBe(
      true,
    );
    await harness.client.destroy();
  });

  it('passes flush failure through the real controller and client, then still terminates on destroy', async () => {
    const harness = createHarness();
    await harness.client.start();
    const error = new Error('fixture flush failed');
    harness.provider.flushError = error;

    await expect(harness.client.flushFiles()).rejects.toThrow('fixture flush failed');
    await expect(harness.client.destroy()).resolves.toBeUndefined();
    expect(harness.worker.terminateCount).toBe(1);
  });

  it.each([
    ['before flush', false],
    ['while flush waits', true],
  ] as const)(
    'reports a write failure %s once and permits a later successful flush',
    async (_label, failDuringFlush) => {
      const harness = createHarness();
      await harness.client.start();
      const flushEntered = observeCoreFlush(harness.core!);
      const writeError = new Error('fixture write failed');
      harness.provider.writeError = writeError;
      const gate = new Deferred<void>();
      if (failDuringFlush) harness.provider.writeGate = gate.promise;

      harness.shim!.emitFileWrite('save/failing.sav', new Uint8Array([1]));
      if (failDuringFlush) {
        await harness.provider.writeStarted.promise;
        const flushing = harness.client.flushFiles();
        await flushEntered.promise;
        let settled = false;
        void flushing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        expect(settled).toBe(false);
        gate.resolve();
        await expect(flushing).rejects.toThrow('fixture write failed');
      } else {
        await Promise.resolve();
        await expect(harness.client.flushFiles()).rejects.toThrow('fixture write failed');
      }

      harness.provider.writeError = null;
      harness.provider.writeGate = null;
      const saved = new Uint8Array([4, 5]);
      harness.shim!.emitFileWrite('save/recovered.sav', saved);
      await harness.client.flushFiles();
      expect(harness.provider.files.get('save/recovered.sav')).toEqual(saved);
      await harness.client.destroy();
    },
  );

  it('falls back after probe failure, starts the main-thread shell, and emits no error status', async () => {
    const provider = new IntegrationProvider();
    const source = fixtureSource(provider);
    const statuses: string[] = [];
    const worker = new LinkedWorker();
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://localhost/' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'hidden',
    });
    vi.stubGlobal('Worker', class {});
    const boot = new Uint8Array(readFileSync(new URL('../../src/vm86/boot.bin', import.meta.url)));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => boot.slice().buffer as ArrayBuffer,
      })),
    );
    const shell = await createVmShell({ onStatus: (status) => statuses.push(status.phase) }, source, {
      workerFactory: () => {
        setTimeout(() => worker.onerror?.({ message: 'probe failed' } as ErrorEvent), 0);
        return worker as unknown as Worker;
      },
      audio: new IntegrationAudio() as unknown as WebAudioPcmSink,
    });

    expect(shell).toBeInstanceOf(Win32GameVm);
    expect(shell.runtimeInfo).toMatchObject({
      mode: 'main-thread',
      reason: 'probe-failed',
      fallbackReason: 'probe failed',
    });
    expect(shell.runtimeInfo.workerProbeMs).toBeGreaterThanOrEqual(0);
    await shell.start();
    expect(statuses).toContain('running');
    expect(statuses).not.toContain('error');
    expect(worker.terminateCount).toBe(1);
    await shell.destroy();
  });
});
