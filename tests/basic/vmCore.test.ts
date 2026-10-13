import { readFileSync } from 'node:fs';
import { RA2_YR_RESOURCE_POLICY } from '../../src/games/shared/resourcePolicy';
import { describe, expect, it, vi } from 'vitest';
import { VmCore, type VmAudioSink, type VmCorePlatform } from '../../src/adapter/vmCore';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { SUPPORTED_GAMES, type SupportedGame } from '../../src/games/catalog';
import { EMPTY_GAME_SHIM_PROFILE } from '../../src/vm86/shim/gameProfile';
import type { V86 } from 'v86';
import { Win32Shim } from '../../src/games/win32Shim';
import {
  HYPERCALL_EAX,
  HYPERCALL_EXCEPTION,
  HYPERCALL_HALTED,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
} from '../../src/vm86/pe';
import { gameResolutionIni } from '../../src/games/resolution';
import { callShim } from '../helpers/guestMemory';
import { FIXTURE_FILE_BYTES, FIXTURE_FILE_PATH, FIXTURE_ABI, buildFixturePe } from '../fixture/fixtureProgram';

class FakeAudio implements VmAudioSink {
  readonly destroy = vi.fn(async () => {});
  readonly stopAll = vi.fn();
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
}

class FakeEmulator {
  readonly destroy = vi.fn(async () => {});
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  readonly run = vi.fn(async () => {
    this.running = true;
  });
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

function source(): GameSource {
  const base = SUPPORTED_GAMES[0]!;
  const game: SupportedGame = {
    ...base,
    title: 'fixture',
    executable: 'fixture.exe',
    abi: FIXTURE_ABI,
    argBytes: (dll, name) => FIXTURE_ABI[`${dll.toUpperCase()}!${name}`] ?? 0,
    shimProfile: EMPTY_GAME_SHIM_PROFILE,
    runtimeHooks: undefined,
    commandLineArguments: undefined,
    defaultGameSpeed: undefined,
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
  const fixture = buildFixturePe();
  const files = new MemoryGameFileProvider(new Map([[FIXTURE_FILE_PATH, FIXTURE_FILE_BYTES]]));
  return { game, files, executableBytes: fixture.built.exe };
}

function platform(emulator: FakeEmulator, audio: FakeAudio, createShim: (emulator: V86) => Win32Shim): VmCorePlatform {
  const boot = new Uint8Array(readFileSync(new URL('../../src/vm86/boot.bin', import.meta.url)));
  return {
    resourcePolicy: RA2_YR_RESOURCE_POLICY,
    fetchBytes: async () => boot,
    scheduleFrame: (emit) => emit(),
    audio,
    fastFileRead: false,
    createEmulator: () => emulator as unknown as V86,
    createShim: (value) => createShim(value),
  };
}

function fakeShim(dispatch: () => unknown = () => null): Win32Shim {
  return {
    setGameClockRate: vi.fn(),
    dispose: vi.fn(),
    dispatch,
    inspectShellPageTitle: () => '',
    inspectHeapState: () => ({
      liveBytes: 0,
      freeBytes: 0,
      nextAddress: 0,
      virtualRegions: 0,
      virtualBytes: 0,
      virtualFreeBytes: 0,
    }),
    inspectCallbackState: () => null,
    failedOpens: [],
    unimplementedDetail: null,
  } as unknown as Win32Shim;
}

function writeU32(emulator: FakeEmulator, address: number, value: number): void {
  emulator.write_memory([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff], address);
}

function readU32(emulator: FakeEmulator, address: number): number {
  const bytes = emulator.read_memory(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

describe('VmCore guest file contracts', () => {
  it('fails startup when a required linked DLL is missing instead of running with import stubs', async () => {
    const emulator = new FakeEmulator();
    const fixture = source();
    fixture.game = { ...fixture.game, preloadFiles: [{ path: 'required.dll', linkBeforeEntry: true }] };
    const statuses: Array<{ phase: string; detail: string }> = [];
    const host = platform(emulator, new FakeAudio(), () => fakeShim());
    host.createShim = (memory, options) => new Win32Shim(memory, options);
    const core = new VmCore({ onStatus: (status) => statuses.push(status) }, fixture, host);
    try {
      await expect(core.start()).rejects.toThrow('Required guest DLL could not be loaded: required.dll');
      expect(statuses.at(-1)).toMatchObject({
        phase: 'error',
        detail: expect.stringContaining('Required guest DLL could not be loaded: required.dll'),
      });
      expect(emulator.run).not.toHaveBeenCalled();
    } finally {
      await core.destroy();
    }
  });

  it.each(['ra2', 'yr'] as const)('%s retains guest INI writes when reopening the startup overlay', async (id) => {
    const emulator = new FakeEmulator();
    const fixture = source();
    fixture.game = { ...fixture.game, id, defaultGameSpeed: 0 };
    const path = gameResolutionIni(id);
    const original = new TextEncoder().encode('[Options]\nGameSpeed=3\n');
    await fixture.files.write(path, original);
    let shim!: Win32Shim;
    const host = platform(emulator, new FakeAudio(), () => shim);
    host.createShim = (memory, options) => (shim = new Win32Shim(memory, options));
    const core = new VmCore({}, fixture, host);
    try {
      await core.start();
      const sync = (core as unknown as { syncGuestFile(pointer: number): Promise<void> | null }).syncGuestFile.bind(
        core,
      );
      const pathPtr = 0x0010_0000,
        buffer = 0x0011_0000;
      emulator.write_memory(new TextEncoder().encode(`${path}\0`), pathPtr);
      await sync(pathPtr);
      expect(new TextDecoder().decode(shim.getMountedFileBytes(path))).toContain('GameSpeed=0');
      const handle = callShim(shim, 'KERNEL32.DLL!_lcreat', [pathPtr, 0]).eax;
      const changed = new TextEncoder().encode('[Options]\nGameSpeed=5\n');
      emulator.write_memory(changed, buffer);
      expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, buffer, changed.length]).eax).toBe(changed.length);
      callShim(shim, 'KERNEL32.DLL!_lclose', [handle]);
      await core.flushFiles();
      await sync(pathPtr);
      const reopened = callShim(shim, 'KERNEL32.DLL!_lopen', [pathPtr, 0]).eax;
      expect(callShim(shim, 'KERNEL32.DLL!_lread', [reopened, buffer, changed.length]).eax).toBe(changed.length);
      expect(emulator.read_memory(buffer, changed.length)).toEqual(changed);
      expect(await fixture.files.read(path)).toEqual(original);
    } finally {
      await core.destroy();
    }
  });

  it.each([
    ['ReadFile', 'missing'],
    ['ReadFile', 'empty'],
    ['ReadFile', 'short'],
    ['ReadFile', 'unavailable'],
    ['_lread', 'missing'],
    ['_lread', 'empty'],
    ['_lread', 'short'],
    ['_lread', 'unavailable'],
  ] as const)('%s rejects %s range data and can retry at the same position', async (name, outcome) => {
    const emulator = new FakeEmulator();
    const fixture = source();
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    fixture.files.readRange =
      outcome === 'unavailable'
        ? undefined
        : vi.fn(async () => (outcome === 'missing' ? null : bytes.slice(0, outcome === 'empty' ? 0 : 4)));
    let shim!: Win32Shim;
    const host = platform(emulator, new FakeAudio(), () => shim);
    host.createShim = (memory, options) => (shim = new Win32Shim(memory, options));
    const statuses: string[] = [];
    const core = new VmCore({ onStatus: (status) => statuses.push(status.phase) }, fixture, host);
    try {
      await core.start();
      shim.mountFile('paged.bin', bytes.slice(0, 1), true, bytes.length);
      shim.markFileRangeBacked('paged.bin');
      const pathPtr = 0x0010_0000,
        buffer = 0x0011_0000,
        countPtr = buffer + 16,
        stack = 0x2000;
      emulator.write_memory(new TextEncoder().encode('paged.bin\0'), pathPtr);
      const handle = callShim(shim, 'KERNEL32.DLL!_lopen', [pathPtr, 0]).eax;
      callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 8, 0]);
      emulator.write_memory(new Uint8Array(4).fill(0xcc), buffer);
      writeU32(emulator, countPtr, 99);
      vi.spyOn(shim, 'resolveDynamicImport').mockReturnValue({
        id: 999,
        key: `KERNEL32.DLL!${name}`,
        dll: 'KERNEL32.DLL',
        name,
        argBytes: name === 'ReadFile' ? 20 : 12,
        slot: 0,
        stub: 0,
      });
      writeU32(emulator, HYPERCALL_STACK, stack);
      [handle, buffer, 4, countPtr, 0].forEach((value, index) => writeU32(emulator, stack + 4 + index * 4, value));
      const read = async () => {
        writeU32(emulator, HYPERCALL_REQUEST, 999);
        await (core as unknown as { poll(): Promise<void> }).poll();
        expect(readU32(emulator, HYPERCALL_REQUEST)).toBe(0);
        return readU32(emulator, HYPERCALL_EAX);
      };
      expect(await read()).toBe(name === 'ReadFile' ? 0 : 0xffff_ffff);
      expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(30);
      expect(readU32(emulator, countPtr)).toBe(name === 'ReadFile' ? 0 : 99);
      expect(emulator.read_memory(buffer, 4)).toEqual(new Uint8Array(4).fill(0xcc));
      expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 1]).eax).toBe(8);
      fixture.files.readRange = vi.fn(async () => bytes.slice());
      expect(await read()).toBe(name === 'ReadFile' ? 1 : 4);
      expect(emulator.read_memory(buffer, 4)).toEqual(bytes.slice(8, 12));
      expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 1]).eax).toBe(12);
      expect(statuses).not.toContain('error');
    } finally {
      await core.destroy();
    }
  });
});

describe('VmCore lifecycle orchestration', () => {
  it('resolves hooks once per VM before patches and passes only the resolved hooks to the shim', async () => {
    const fixture = source();
    const emulator = new FakeEmulator();
    const order: string[] = [];
    const prepareImage = vi.fn(() => {
      order.push('patch');
    });
    const writeGameSpeedFlag = vi.fn(() => 4);
    const resolved = { prepareImage, writeGameSpeedFlag };
    const resolve = vi.fn((_memory: unknown, _exe: Uint8Array) => {
      order.push('resolve');
      return resolved;
    });
    fixture.game = { ...fixture.game, runtimeHooks: { resolve } };
    const host = platform(emulator, new FakeAudio(), () => fakeShim());
    let received: unknown;
    host.createShim = (_memory, _options, hooks) => {
      order.push('shim');
      received = hooks;
      return fakeShim();
    };
    const core = new VmCore({}, fixture, host);
    try {
      await core.start();
      expect(order).toEqual(['resolve', 'patch', 'shim']);
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0]?.length).toBe(2);
      expect(received).toBe(resolved);
      expect(core.setGameSpeedFlag(4)).toBe(4);
      expect(writeGameSpeedFlag).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
    expect(core.setGameSpeedFlag(4)).toBeNull();
  });

  it('detects counters lazily once, passes executable bytes, and discards a pending sample on destruction', async () => {
    const fixture = source();
    const create = vi.fn(() => () => ({ frame: 321, gameSpeed: 2, sessionSpeed: 2, requestedFps: 30 }));
    fixture.game = { ...fixture.game, runtimeHooks: { createFrameReader: create } };
    const emulator = new FakeEmulator();
    const core = new VmCore(
      {},
      fixture,
      platform(emulator, new FakeAudio(), () => fakeShim()),
    );
    try {
      expect(await core.getGamePerformance()).toBeNull();
      await core.start();
      expect(create).not.toHaveBeenCalled();
      const samples = await Promise.all([core.getGamePerformance(), core.getGamePerformance()]);
      expect(samples.map((sample) => sample?.frame)).toEqual([321, 321]);
      expect(create).toHaveBeenCalledExactlyOnceWith(emulator, fixture.executableBytes);
      const pending = core.getGamePerformance();
      await core.destroy();
      expect(await pending).toBeNull();
      expect(await core.getGamePerformance()).toBeNull();
    } finally {
      await core.destroy();
    }
  });

  it('caches unavailable counter detection without rescanning on every diagnostics request', async () => {
    const fixture = source();
    const create = vi.fn(() => null);
    fixture.game = { ...fixture.game, runtimeHooks: { createFrameReader: create } };
    const core = new VmCore(
      {},
      fixture,
      platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
    );
    try {
      await core.start();
      expect(await core.getGamePerformance()).toBeNull();
      expect(await core.getGamePerformance()).toBeNull();
      expect(create).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
  });

  it('客体处理较慢时按墙钟让出，不必等满 128 次调用才响应输入', async () => {
    const core = new VmCore(
      {},
      source(),
      platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
    );
    const scheduling = core as unknown as {
      calls: number;
      nextHostYieldAt: number;
      hypercallListener(): void;
      yieldToHost(): void;
      poll(): Promise<void>;
    };
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const yieldHost = vi.spyOn(scheduling, 'yieldToHost').mockImplementation(() => {});
    const poll = vi.spyOn(scheduling, 'poll').mockResolvedValue();
    try {
      scheduling.calls = 1;
      scheduling.nextHostYieldAt = 104;
      scheduling.hypercallListener();
      await Promise.resolve();
      expect(poll).toHaveBeenCalledOnce();
      expect(yieldHost).not.toHaveBeenCalled();
      now.mockReturnValue(104);
      scheduling.hypercallListener();
      expect(yieldHost).toHaveBeenCalledOnce();
      scheduling.nextHostYieldAt = 108;
      scheduling.calls = 128;
      scheduling.hypercallListener();
      expect(yieldHost).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      await core.destroy();
    }
  });
  it('FindFirstFileA 派发前等待 provider 元数据，不预挂载空的 MOD 档案', async () => {
    const emulator = new FakeEmulator();
    const fixture = source();
    await fixture.files.write('ecache01.mix', new Uint8Array(7));
    const setResults = vi.fn();
    const dispatch = vi.fn(() => {
      expect(setResults).toHaveBeenCalledWith('ECACHE*.MIX', [{ path: 'ecache01.mix', size: 7 }]);
      return null; // This test only verifies that asynchronous bridging precedes synchronous dispatch; it does not resume guest execution.
    });
    const shim = Object.assign(fakeShim(dispatch), {
      setFileSearchResults: setResults,
      resolveDynamicImport: () => ({
        id: 999,
        key: 'KERNEL32.DLL!FindFirstFileA',
        dll: 'KERNEL32.DLL',
        name: 'FindFirstFileA',
        argBytes: 8,
        slot: 0,
        stub: 0,
      }),
    });
    const core = new VmCore(
      {},
      fixture,
      platform(emulator, new FakeAudio(), () => shim),
    );
    try {
      await core.start();
      emulator.write_memory(new TextEncoder().encode('ECACHE*.MIX\0'), 0x3000);
      writeU32(emulator, HYPERCALL_STACK, 0x2000);
      writeU32(emulator, 0x2004, 0x3000);
      writeU32(emulator, 0x2008, 0x4000);
      writeU32(emulator, HYPERCALL_REQUEST, 999);
      await (core as unknown as { poll(): Promise<void> }).poll();
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
  });

  it('loads Unicode structured-storage paths before the first synchronous open', async () => {
    const emulator = new FakeEmulator();
    const fixture = source();
    const bytes = new Uint8Array([83, 71, 66, 89]);
    const path = '存档.sav';
    const mount = vi.fn();
    const dispatch = vi.fn(() => {
      expect(mount).toHaveBeenCalledWith(path, bytes, true, bytes.length);
      return null;
    });
    const shim = Object.assign(fakeShim(dispatch), {
      mountFile: mount,
      resolveDynamicImport: () => ({
        id: 999,
        key: 'OLE32.DLL!StgOpenStorage',
        dll: 'OLE32.DLL',
        name: 'StgOpenStorage',
        argBytes: 24,
        slot: 0,
        stub: 0,
      }),
    });
    const core = new VmCore(
      {},
      fixture,
      platform(emulator, new FakeAudio(), () => shim),
    );
    try {
      await core.start();
      const read = vi.spyOn(fixture.files, 'read').mockImplementation(async (name) => {
        expect(name).toBe(path);
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        return bytes;
      });
      emulator.write_memory(
        [...path, '\0'].flatMap((char) => [char.charCodeAt(0) & 255, char.charCodeAt(0) >>> 8]),
        0x3000,
      );
      writeU32(emulator, HYPERCALL_STACK, 0x2000);
      writeU32(emulator, 0x2004, 0x3000);
      writeU32(emulator, HYPERCALL_REQUEST, 999);
      await (core as unknown as { poll(): Promise<void> }).poll();
      expect(read).toHaveBeenCalledWith(path);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
  });

  it.each(SUPPORTED_GAMES)('$id 的启动参数经公共 VmCore 传入 shim', async (game) => {
    const emulator = new FakeEmulator();
    const fixture = source();
    fixture.game = { ...fixture.game, executable: game.executable, commandLineArguments: game.commandLineArguments };
    const shim = fakeShim();
    const hooks = platform(emulator, new FakeAudio(), () => shim);
    hooks.createShim = vi.fn(() => shim);
    const core = new VmCore({}, fixture, hooks);
    try {
      await core.start();
      expect(hooks.createShim).toHaveBeenCalledWith(
        emulator,
        expect.objectContaining({
          moduleName: game.executable,
          commandLineArguments: '-SPEEDCONTROL',
        }),
        undefined,
      );
    } finally {
      await core.destroy();
    }
  });

  it('首帧前上报资源名并保持运行阶段，首帧后恢复运行描述并停止启动进度', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: Array<{ phase: string; detail: string }> = [];
    const shim = fakeShim();
    Object.assign(shim, { hasMountedFile: () => false, mountFile: vi.fn() });
    const fixture = source();
    fixture.files = new MemoryGameFileProvider(
      new Map([
        ['ra2.mix', new Uint8Array([1])],
        ['language.mix', new Uint8Array([2])],
      ]),
    );
    const hooks = platform(emulator, audio, () => shim);
    let onFrame: (() => void) | undefined;
    hooks.createShim = (_memory, options) => {
      onFrame = () => options?.onFrame?.({} as never);
      return shim;
    };
    const core = new VmCore({ onStatus: (status) => statuses.push(status) }, fixture, hooks);
    try {
      await core.start();
      const sync = (
        core as unknown as {
          syncGuestFile: (pointer: number) => Promise<void> | null;
        }
      ).syncGuestFile.bind(core);
      emulator.write_memory(new TextEncoder().encode('ra2.mix\0'), 0x1000);
      await sync(0x1000);
      expect(statuses.at(-1)).toEqual({ phase: 'running', detail: '正在读取 ra2.mix…' });
      onFrame!();
      // The first visible frame replaces the stale per-file startup detail with the running description once.
      expect(statuses.at(-1)?.phase).toBe('running');
      expect(statuses.at(-1)?.detail).toMatch(/正在 v86 中执行/);
      onFrame!();
      const count = statuses.length;
      emulator.write_memory(new TextEncoder().encode('language.mix\0'), 0x1000);
      await sync(0x1000);
      expect(statuses).toHaveLength(count);
      expect(shim.mountFile).toHaveBeenCalledTimes(2);
    } finally {
      await core.destroy();
    }
  });

  it('emits loading+ → ready → running → stopped and releases resources', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase) },
      source(),
      platform(emulator, audio, () => fakeShim()),
    );

    await core.start();
    expect(statuses).toEqual(['loading', 'loading', 'ready', 'running']);
    await core.stop();
    expect(statuses.at(-1)).toBe('stopped');
    await core.destroy();
    expect(emulator.destroy).toHaveBeenCalledTimes(1);
    expect(audio.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports startup error and cleans an emulator when shim creation fails', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase) },
      source(),
      platform(emulator, audio, () => {
        throw new Error('shim construction failed');
      }),
    );

    await expect(core.start()).rejects.toThrow('shim construction failed');
    expect(statuses.at(-1)).toBe('error');
    expect(emulator.destroy).toHaveBeenCalledTimes(1);
    expect(audio.destroy).toHaveBeenCalledTimes(1);
  });

  it('retries a static resource after replacing the file provider', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const mounted = new Map<string, Uint8Array>();
    const shim = fakeShim();
    const shimFiles = shim as unknown as {
      hasMountedFile: (path: string) => boolean;
      mountFile: (path: string, bytes: Uint8Array) => void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes.slice());
    };
    const core = new VmCore(
      {},
      source(),
      platform(emulator, audio, () => shim),
    );
    await core.start();

    const pathPtr = 0x1000;
    const pathBytes = new Uint8Array([...new TextEncoder().encode('ra2.mix'), 0]);
    emulator.write_memory(pathBytes, pathPtr);
    const syncGuestFile = (
      core as unknown as {
        syncGuestFile: (pointer: number) => Promise<void> | null;
      }
    ).syncGuestFile.bind(core);
    await syncGuestFile(pathPtr);
    expect(mounted.has('ra2.mix')).toBe(false);

    const bytes = new Uint8Array([1, 2, 3]);
    core.setFileProvider(new MemoryGameFileProvider(new Map([['ra2.mix', bytes]])));
    await syncGuestFile(pathPtr);

    expect(mounted.get('ra2.mix')).toEqual(bytes);
    await core.destroy();
  });

  it.each([
    ['test.yro', 1, false],
    ['test.yrm', 1, false],
    ['test.mpr', 1, false],
    ['test.ini', 2, false],
    ['test.sav', 2, false],
    ['test.asset', 1, true],
    ['test.mix', 2, true],
  ] as const)('重复打开 %s：预期读取 %i 次，自定义策略=%s', async (path, reads, customPolicy) => {
    const emulator = new FakeEmulator();
    const shim = fakeShim();
    const mounted = new Map<string, Uint8Array>();
    const shimFiles = shim as unknown as {
      hasMountedFile(path: string): boolean;
      mountFile(path: string, bytes: Uint8Array): void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes);
    };
    const fixture = source();
    fixture.files = new MemoryGameFileProvider(new Map([[path, new Uint8Array([1, 2])]]));
    const read = vi.spyOn(fixture.files, 'read');
    const host = platform(emulator, new FakeAudio(), () => shim);
    if (customPolicy)
      host.resourcePolicy = {
        ...RA2_YR_RESOURCE_POLICY,
        isSessionStatic: (path) => path.endsWith('.asset'),
      };
    const core = new VmCore({}, fixture, host);
    try {
      await core.start();
      read.mockClear();
      emulator.write_memory(new TextEncoder().encode(`${path}\0`), 0x1000);
      const sync = (core as unknown as { syncGuestFile(pointer: number): Promise<void> | null }).syncGuestFile.bind(
        core,
      );
      await sync(0x1000);
      await sync(0x1000);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(mounted.get(path)).toEqual(new Uint8Array([1, 2]));
    } finally {
      await core.destroy();
    }
  });

  it('动态挂载期间旧异步读取的 miss 不会遮蔽新地图', async () => {
    const emulator = new FakeEmulator();
    const shim = fakeShim();
    const mounted = new Map<string, Uint8Array>();
    const shimFiles = shim as unknown as {
      hasMountedFile: (path: string) => boolean;
      mountFile: (path: string, bytes: Uint8Array) => void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes.slice());
    };
    const core = new VmCore(
      {},
      source(),
      platform(emulator, new FakeAudio(), () => shim),
    );
    await core.start();
    const old = new MemoryGameFileProvider(new Map());
    vi.spyOn(old, 'hasKnownFile').mockReturnValue(null);
    let finishRead!: (value: Uint8Array | null) => void;
    vi.spyOn(old, 'read').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    core.setFileProvider(old);
    emulator.write_memory(new Uint8Array([...new TextEncoder().encode('new.mpr'), 0]), 0x1000);
    const sync = (core as unknown as { syncGuestFile(pointer: number): Promise<void> | null }).syncGuestFile.bind(core);
    const pending = sync(0x1000);
    core.setFileProvider(new MemoryGameFileProvider(new Map([['new.mpr', new Uint8Array([7])]])));
    finishRead(null);
    await pending;
    await sync(0x1000);
    expect(mounted.get('new.mpr')).toEqual(new Uint8Array([7]));
    await core.destroy();
  });

  it.each([
    ['blocked', 'blocked', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_REQUEST, 1)],
    ['normal guest exit', 'exited', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_HALTED, 1)],
    ['runtime exception', 'error', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_EXCEPTION, 1)],
  ] as const)('reports the %s terminal path', async (_label, expected, trigger) => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const blocked = vi.fn();
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase), onBlocked: blocked },
      source(),
      platform(emulator, audio, () => fakeShim()),
    );

    await core.start();
    trigger(emulator);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe(expected), { timeout: 500 });
    if (expected === 'blocked') expect(blocked).toHaveBeenCalledTimes(1);
    await core.destroy();
  });
});
