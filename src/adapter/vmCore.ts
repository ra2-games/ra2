import { readDebugContext, writeDebugContext } from '../vm86/debugContext';
import type { ProcessDebugger } from '../vm86/processDebugger';
import {
  GuestProcessKernel,
  GuestKernelError,
  type GuestProcessContext,
  type GuestProcessRequest,
} from '../vm86/processKernel';
import { GamePerformanceMeter, type GameFrameReader, type GamePerformanceSample } from './gamePerformance';
import { V86 } from 'v86';
import { RangePrefetch } from './rangePrefetch';
import { readGuestFileSearch } from './fileSearch';
import v86WasmUrl from 'v86/build/v86.wasm?url';
import bootUrl from '../vm86/boot.bin?url';
import {
  HYPERCALL_EAX,
  HYPERCALL_EDX,
  HYPERCALL_ENTRY,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_HALTED,
  HYPERCALL_EXCEPTION,
  HYPERCALL_EXCEPTION_EAX,
  HYPERCALL_EXCEPTION_EBP,
  HYPERCALL_EXCEPTION_EBX,
  HYPERCALL_EXCEPTION_CS,
  HYPERCALL_EXCEPTION_ECX,
  HYPERCALL_EXCEPTION_EDI,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_EXCEPTION_EDX,
  HYPERCALL_EXCEPTION_ERROR,
  HYPERCALL_EXCEPTION_ESP,
  HYPERCALL_EXCEPTION_EFLAGS,
  HYPERCALL_EXCEPTION_ESI,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
  HYPERCALL_STACK_TOP,
  loadPe,
  type PeImage,
  type PeImport,
} from '../vm86/pe';
import {
  annotateWin32Modules,
  decodeGuestNarrow,
  readStackArgs,
  makeWin32ImportStub,
  makeWin32ImportStubWithFastRead,
  type Win32Call,
  type Win32AudioSink,
} from '../vm86/win32';
import { normalizeGuestPath } from '../vm86/paths';
import type { Win32ShimBase } from '../vm86/win32';
import type { GuestMemRecordResult } from './memRecord';
import { accumulateChangedWords, diffMemory } from '../utils/memoryDiff';
import { normalizeGameClockRate } from '../vm86/clock';
import type { GameFileProvider, ResourcePolicy } from '../resources/contracts';
import type { GameSource } from '../games/source';
import type { VmPointerState } from './vmShell';
import type { GameVmCallbacks, VmStatus } from '../app/session/runtimeEvents';
import type { VmExecutionProbe } from '../vm86/diagnostics';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';

const DEFAULT_GUEST_MEMORY_SIZE = 128 * 1024 * 1024;
/** Recording sample interval: v86 has no per-write hook, so modification counts approximate sampling windows, incrementing once per window. */
const MEM_RECORD_SAMPLE_MS = 500;
/** Tracked-address limit: bound the table for frequently changing heap/stack regions; after the limit, increment only existing entries. */
const MEM_RECORD_MAX_ADDRESSES = 100_000;
/** Maximum address-statistic entries returned to the main thread; the UI shows only the first 200. */
const MEM_RECORD_MAX_REPORT = 10_000;
/** Leave 2MB between the heap arena end and total guest memory, matching the historical 0x7e00000/128MB layout. */
const GUEST_MEMORY_MARGIN = 2 * 1024 * 1024;
// The RA2 image ends at 0xb46000; staging must cover the highest image address rather than relying only on file size.
const STAGING_SIZE = 16 * 1024 * 1024;
const STUB_BASE = 0x0008_0000;
// Multithreaded import stubs include register/SEH/TLS context switches; RA2's 369 imports exceed
// the original 64KiB range. Reserve 0x80000..0xc0000 for static stubs, still far below the PE image at 0x400000.
const STUB_LIMIT = 0x000c_0000;
/** After a small run of hypercalls, yield to a host macrotask so microtask chains cannot starve input/network events. */
const HYPERCALLS_PER_HOST_YIELD = 128;
/** Yielding by call count is not yielding by time: complex guest frames can stretch 128 calls into tens of milliseconds. */
const HOST_SLICE_MS = 4;
/** Development builds log heap/stub/sound-buffer state at this interval to diagnose long-session degradation. */
const DIAGNOSTICS_INTERVAL_MS = 30_000;

/** Win32 audio output plus host master-volume, stop-all, and destruction capabilities. */
export interface VmAudioSink extends Win32AudioSink {
  setMasterVolume(linear: number): void;
  stopAll(): void;
  destroy(): Promise<void>;
}

type ResolvedRuntimeHooks = NonNullable<GameSource['game']['runtimeHooks']>;

/** Platform injection boundary: supply main-thread or Worker host facilities here; VmCore contains no DOM/window references. */
export interface VmCorePlatform {
  /** Internal session process context; never serialized across Workers. */
  processContext?: GuestProcessContext;
  createGuestProcess?: (request: GuestProcessRequest) => Promise<readonly number[]>;
  executionProbe?: VmExecutionProbe;
  /** Inject game-resource policies at composition time; the core does not infer policies from extensions, game names, or URLs. */
  resourcePolicy: ResourcePolicy<GameSource>;
  startupPage?: string;
  /** Fetch boot.bin firmware bytes with matching main-thread and Worker semantics. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** Frame emission scheduling: coalesce with rAF on the main thread; emit directly in Workers since postMessage is asynchronous. */
  scheduleFrame(emit: () => void): void;
  /** Defer snapshots when the Worker mailbox is full; default false preserves main-thread presentation-boundary semantics. */
  deferFrameSnapshot?: boolean;
  packedRgb565Frames?: boolean;
  takeFrameBuffer?: (size: number) => ArrayBuffer;
  audio: VmAudioSink;
  /** Fast guest _lread stubs; ?fast-files=0 restores the per-call hypercall slow path. */
  fastFileRead: boolean;
  /** The host injects emulator construction and scheduling; the outer layer always assembles the shim. */
  createEmulator?: (options: ConstructorParameters<typeof V86>[0]) => V86;
  createShim: (
    emulator: V86,
    options: ConstructorParameters<typeof Win32ShimBase>[1],
    hooks?: ResolvedRuntimeHooks,
  ) => Win32ShimBase;
}

/**
 * Platform-independent VM driver: v86, PE loading, Win32 shim, hypercall polling, and frame forwarding.
 * Shared by main-thread Win32GameVm and Worker vmWorker.ts.
 */
export class VmCore {
  private launcherCore: VmCore | null = null;
  private processContext: GuestProcessContext | undefined;
  private destroyed = false;
  private starting = false;
  private cancelBootstrap: ((error: Error) => void) | null = null;
  private readonly rangePrefetch = new RangePrefetch();
  private emulator: V86 | null = null;
  private image: PeImage | null = null;
  private shim: Win32ShimBase | null = null;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** Development-only periodic console diagnostics for long sessions (heap, stubs, sound buffers, logic FPS). */
  private diagnosticsTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private handling = false;
  private suspendedAtCreation = false;
  private debugPaused = false;
  private debugSession: ProcessDebugger | undefined;
  private calls = 0;
  private readonly recentCalls: string[] = [];
  private lastCallStack: { key: string; stack: number; returnAddress: number } | null = null;
  private readonly pendingFileWrites = new Set<Promise<void>>();
  private pendingFileWriteError: Error | null = null;
  private gameClockRate = 1;
  private runtimeHooks: ResolvedRuntimeHooks | undefined;
  private control: ReturnType<NonNullable<ResolvedRuntimeHooks['createControl']>> = null;
  private frameReader: Promise<GameFrameReader | null> | null = null;
  private readonly gamePerformance = new GamePerformanceMeter();
  private guestMemoryBytes = DEFAULT_GUEST_MEMORY_SIZE;
  private memRecordBase: Uint8Array | null = null;
  private memRecordPrev: Uint8Array | null = null;
  private memRecordCounts = new Map<number, number>();
  private memRecordSamples = 0;
  private memRecordTruncated = false;
  private memRecordTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** MessageChannel provides a host task boundary without a minimum delay; use setTimeout(0) only when unavailable. */
  private readonly hostYieldChannel: MessageChannel | null =
    typeof globalThis.MessageChannel === 'function' ? new globalThis.MessageChannel() : null;
  private hostYieldPending = false;
  private nextHostYieldAt = performance.now() + HOST_SLICE_MS;
  // Do not reenter read_memory while v86 is on the WASM I/O callback stack; defer to a microtask immediately after the current CPU slice.
  // v86 serial callbacks cannot directly reenter read_memory, so normally defer to a microtask; however,
  // an endless serial -> microtask -> serial chain must not monopolize the Worker and indefinitely queue mouse, WebSocket, stop,
  // and other external messages, which would make units appear frozen.
  private readonly hypercallListener = () => {
    if (this.calls > 0 && (this.calls % HYPERCALLS_PER_HOST_YIELD === 0 || performance.now() >= this.nextHostYieldAt)) {
      this.yieldToHost();
    } else {
      queueMicrotask(() => void this.poll());
    }
  };
  private lastShellPageTitle = '';

  constructor(
    private readonly callbacks: GameVmCallbacks,
    private source: GameSource,
    private readonly platform: VmCorePlatform,
  ) {
    this.runtimeHooks = source.game.runtimeHooks;
    this.processContext = platform.processContext;
    this.hostYieldChannel?.port1.addEventListener('message', () => {
      this.hostYieldPending = false;
      this.nextHostYieldAt = performance.now() + HOST_SLICE_MS;
      void this.poll();
    });
    this.hostYieldChannel?.port1.start();
  }

  /** Replace the file provider when a Worker mounts add-on maps; preserve other source fields. */
  setFileProvider(files: GameFileProvider): void {
    this.missingStaticGuestFiles.clear();
    this.source = { ...this.source, files };
  }

  async start(): Promise<void> {
    if (this.starting || this.emulator || this.launcherCore || this.destroyed)
      throw new Error('VM session cannot be started twice');
    this.starting = true;
    try {
      this.source = await this.platform.resourcePolicy.prepareSource(this.source);
      if (this.destroyed) throw new Error('VM session was destroyed during preparation');
      if (this.source.nativeLauncher && !this.processContext) await this.startNativeLauncher();
      else await this.startImage();
    } catch (error) {
      this.status('error', error instanceof Error ? error.message : String(error));
      await this.destroy();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async startNativeLauncher(): Promise<void> {
    const plan = this.source.nativeLauncher!;
    const kernel = new GuestProcessKernel();
    const launcherPid = kernel.createProcess();
    let launched = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const started = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Startup failures can occur before the parent start promise settles.
    void started.catch(() => {});
    this.cancelBootstrap = reject;
    const timeout = globalThis.setTimeout(
      () => reject(new Error('Native launcher did not start the game within 60 seconds')),
      60_000,
    );
    const launcherAudio = Object.create(this.platform.audio) as VmAudioSink;
    launcherAudio.destroy = async () => {};
    this.launcherCore = new VmCore(
      {
        onStatus: (status) => {
          if (['error', 'blocked', 'exited'].includes(status.phase) && !launched)
            reject(new Error(`Native launcher: ${status.detail}`));
          if (['error', 'blocked'].includes(status.phase) && launched) {
            this.status(status.phase, `Native launcher: ${status.detail}`);
            void this.destroy();
          }
        },
      },
      { ...this.source, nativeLauncher: undefined, game: plan.game, executableBytes: plan.executableBytes },
      {
        ...this.platform,
        audio: launcherAudio,
        startupPage: undefined,
        resourcePolicy: { ...this.platform.resourcePolicy, prepareSource: async (source) => source },
        processContext: { kernel, pid: launcherPid },
        createGuestProcess: async (request) => {
          const match = /^\s*(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/.exec(request.commandLine);
          const executable = request.application || match?.[1] || match?.[2] || '';
          const relative = executable.replace(/^C:\\GAME\\/i, '').toLowerCase();
          if (launched || relative !== this.source.game.executable.toLowerCase())
            throw new GuestKernelError(50, 'Unsupported child executable');
          if (request.directory && !/^C:[\\/]GAME[\\/]?$/i.test(request.directory))
            throw new GuestKernelError(3, 'Unsupported child working directory');
          const pid = kernel.createProcess(launcherPid, request.inherit);
          this.processContext = { kernel, pid };
          this.source = { ...this.source, game: { ...this.source.game, commandLineArguments: match?.[3] ?? '' } };
          try {
            this.suspendedAtCreation = request.flags === 6;
            await this.startImage();
            if (this.destroyed) throw new Error('VM session destroyed during child creation');
            launched = true;
            const handles = kernel.processHandles(launcherPid, pid);
            if (request.flags === 6) {
              const emulator = this.emulator!,
                shim = this.shim!,
                image = this.image!;
              this.debugSession = kernel.attachDebugger(launcherPid, pid, {
                memory: emulator,
                memoryBytes: this.guestMemoryBytes,
                imageBase: image.imageBase,
                entry: image.entry,
                allocate: (address, size) => shim.allocateProcessMemory(address, size),
                free: (address) => shim.freeProcessMemory(address),
                context: () => readDebugContext(emulator),
                setContext: (bytes) => writeDebugContext(emulator, bytes, this.guestMemoryBytes),
                unhandledException: (code, address) => {
                  this.clearPoll();
                  this.status(
                    'error',
                    `Unhandled guest exception 0x${code.toString(16)} at 0x${address.toString(16)}; ` +
                      `native SEH dispatch is unsupported; ESP=0x${this.readU32(HYPERCALL_EXCEPTION_ESP).toString(16)}; ` +
                      `recent calls: ${this.recentCalls.join(' → ')}`,
                  );
                  kernel.exit(pid, code);
                },
                resume: () => {
                  if (this.destroyed) return;
                  this.debugPaused = false;
                  this.suspendedAtCreation = false;
                  this.writeU32(HYPERCALL_EXCEPTION, 0);
                  emulator.serial0_send('\0');
                  void emulator.run().catch((error: unknown) => this.status('error', String(error)));
                },
              });
            }
            resolve();
            return [handles.process, handles.thread, pid, kernel.threadId(pid, 0)];
          } catch (error) {
            kernel.exit(pid, 1);
            reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        },
      },
    );
    try {
      await this.launcherCore.start();
      await started;
    } finally {
      clearTimeout(timeout);
      this.cancelBootstrap = null;
    }
  }

  private async startImage(): Promise<void> {
    if (this.emulator) throw new Error('VM 已创建');
    this.hasPresentedFrame = false;
    this.runningDetail = '';
    try {
      const { game, files: gameFiles, executableBytes: exe } = this.source;
      const guestMemoryBytes = game.guestMemoryBytes ?? DEFAULT_GUEST_MEMORY_SIZE;
      this.guestMemoryBytes = guestMemoryBytes;
      this.status('loading', `读取原版 ${game.executable} 和 VM 固件…`);
      const preloadSpecs = game.preloadFiles ?? [];
      const [bios, ...preloadBytes] = await Promise.all([
        this.platform.fetchBytes(bootUrl),
        ...preloadSpecs.map((file) => {
          this.status('loading', `正在读取 ${file.path}…`);
          return gameFiles.read(file.path);
        }),
      ]);
      if (this.destroyed) throw new Error('VM session destroyed while loading resources');
      const preloadedFiles = new Map<string, Uint8Array>();
      preloadSpecs.forEach((file, index) => {
        const bytes = preloadBytes[index];
        if (bytes) preloadedFiles.set(file.path, bytes);
      });
      for (const file of preloadSpecs) {
        if (file.linkBeforeEntry && !preloadedFiles.get(file.path)?.length) {
          throw new Error(
            `Required installation file is missing or empty: ${file.path}. Import your complete installation.`,
          );
        }
      }
      const staging = new Uint8Array(STAGING_SIZE);
      let stubNext = STUB_BASE;
      const importStub = this.platform.fastFileRead ? makeWin32ImportStubWithFastRead : makeWin32ImportStub;
      const image = loadPe(
        staging,
        exe,
        (bytes) => {
          const address = stubNext;
          stubNext = (stubNext + bytes + 15) & ~15;
          if (stubNext > STUB_LIMIT) throw new Error('import stub 区不足');
          return address;
        },
        game.argBytes,
        importStub,
      );
      annotateWin32Modules(image.importList);
      this.image = image;
      this.status('loading', `PE 已解析：入口 0x${image.entry.toString(16)}，${image.importList.length} 个 Win32 导入`);

      const emulator = (this.platform.createEmulator ?? ((options) => new V86(options)))({
        wasm_path: v86WasmUrl,
        memory_size: guestMemoryBytes,
        bios: { buffer: exactBuffer(bios) },
        autostart: false,
        // The UART IRQ handshake suspends the guest until the host releases it; JIT has passed prolonged battlefield-call stress tests.
        disable_jit: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      });
      this.emulator = emulator;
      await onceReady(emulator);
      if (this.destroyed) throw new Error('VM session destroyed while creating emulator');
      emulator.add_listener('serial0-output-byte', this.hypercallListener);

      // Write only the two used regions instead of copying an entire empty 64MB image into WASM.
      emulator.write_memory(staging.subarray(HYPERCALL_STACK, stubNext), HYPERCALL_STACK);
      emulator.write_memory(staging.subarray(image.imageBase, image.imageBase + image.sizeOfImage), image.imageBase);
      this.runtimeHooks = game.runtimeHooks?.resolve?.(emulator, exe) ?? game.runtimeHooks;
      this.runtimeHooks?.prepareImage?.(emulator);
      if (this.runtimeHooks?.createControl) {
        this.control = this.runtimeHooks.createControl(emulator, (size) => {
          const address = stubNext;
          if (!Number.isInteger(size) || size <= 0 || address + size > STUB_LIMIT)
            throw new Error('Control stub space exhausted');
          stubNext = (address + size + 15) & ~15;
          return address;
        });
      }
      if (this.platform.startupPage) {
        const prepare = this.runtimeHooks?.prepareStartupPage;
        if (!prepare) throw new Error(`${game.id} 尚不支持启动页面直达`);
        prepare(emulator, this.platform.startupPage, (size) => {
          const address = stubNext;
          if (!Number.isInteger(size) || size <= 0 || address + size > STUB_LIMIT) throw new Error('启动导航桩区不足');
          stubNext = (address + size + 15) & ~15;
          return address;
        });
      }
      this.writeU32(HYPERCALL_ENTRY, image.entry);
      this.writeU32(HYPERCALL_CALLBACK_DEPTH, 0);
      this.writeU32(HYPERCALL_STACK_TOP, game.stackTop ?? 0x0070_0000);
      this.shim = this.platform.createShim(
        emulator,
        {
          processContext: this.processContext,
          guestMemoryBytes,
          firstDynamicId: image.importList.length + 1,
          staticImports: image.importList,
          enableFastFileMirror: this.platform.fastFileRead,
          virtualTop: game.arenaTop ?? guestMemoryBytes - GUEST_MEMORY_MARGIN,
          virtualBase: game.heapBase,
          heapTop: game.arenaTop ?? guestMemoryBytes - GUEST_MEMORY_MARGIN,
          heapBase: game.heapBase ?? game.stackTop,
          importArgBytes: game.argBytes,
          dynamicImportStub: importStub,
          // Use configured bounds for an explicit image region; otherwise fall back to half the guest memory.
          fastFileMirrorLimit:
            game.fastFileMirrorBase !== undefined && game.fastFileMirrorTop !== undefined
              ? Math.max(0, Math.min(game.fastFileMirrorTop, guestMemoryBytes) - game.fastFileMirrorBase)
              : game.guestMemoryBytes
                ? Math.floor(game.guestMemoryBytes / 2)
                : undefined,
          fastFileMirrorBase: game.fastFileMirrorBase,
          // Configuration comes from the game profile but must never exceed this v86 instance's actual RAM;
          // otherwise large MIX mirrors trigger WASM unreachable in write_memory.
          fastFileMirrorTop:
            game.fastFileMirrorTop === undefined ? undefined : Math.min(game.fastFileMirrorTop, guestMemoryBytes),
          fastFileMirrorFiles: game.fastFileMirrorFiles,
          onFrame: (frame) => {
            const first = !this.hasPresentedFrame;
            this.hasPresentedFrame = true;
            // Startup file reads temporarily replace the running detail; once the game is visible, the last
            // "reading" message would otherwise remain as the status for the whole session.
            if (first && this.currentPhase === 'running' && this.runningDetail) {
              this.status('running', this.runningDetail);
            }
            this.callbacks.onFrame?.(frame);
          },
          onLogicFrame: () => this.callbacks.onLogicFrame?.(1),
          scheduleFrame: this.platform.scheduleFrame,
          deferFrameSnapshot: this.platform.deferFrameSnapshot,
          packedRgb565Frames: this.platform.packedRgb565Frames,
          takeFrameBuffer: this.platform.takeFrameBuffer,
          gameProfile: game.shimProfile,
          files: preloadedFiles,
          audio: this.platform.audio,
          moduleName: game.executable,
          // Shared by Workers and main-thread fallback; expose only the original campaign speed control without changing speed or the clock.
          commandLineArguments: game.commandLineArguments,
          onFileWrite: (path, bytes) => this.queueFileWrite(path, bytes),
          driveTypes: game.driveTypes,
        },
        this.runtimeHooks,
      );
      let linkedEntry = image.entry;
      if (this.suspendedAtCreation) {
        // Windows reports the initial loader breakpoint after imported DLL initialization.
        // A native debugger may redirect execution from this point straight to the PE entry.
        if (stubNext + 16 > STUB_LIMIT) throw new Error('Debugger startup stub area exhausted');
        linkedEntry = stubNext;
        stubNext += 16;
        const gate = new Uint8Array([0xcc, 0xb8, 0, 0, 0, 0, 0xff, 0xe0]);
        new DataView(gate.buffer).setUint32(2, image.entry, true);
        emulator.write_memory(gate, linkedEntry);
      }
      for (const file of preloadSpecs) {
        if (!preloadedFiles.has(file.path) && !file.linkBeforeEntry) continue;
        if (file.linkBeforeEntry) {
          linkedEntry = this.shim.linkGuestDllBeforeEntry(file.path, linkedEntry, image.importList);
        } else if (file.initializeBeforeEntry) {
          linkedEntry = this.shim.initializeGuestDllBeforeEntry(file.path, linkedEntry);
        }
      }
      for (const plan of (await game.runtimeHooks?.createGuestHooks?.(exe, preloadedFiles, emulator)) ?? []) {
        this.shim.installGuestHooks(plan.dll, plan.hooks);
      }
      if (linkedEntry !== image.entry) this.writeU32(HYPERCALL_ENTRY, linkedEntry);
      this.shim.setGameClockRate(this.gameClockRate);
      this.status('ready', `游戏内存已就绪：${game.title}，目录：${gameFiles.label}`);

      // Port events are primary; 50ms polling is only a fallback for CPU exceptions and exceptional conditions.
      this.pollTimer = globalThis.setInterval(() => void this.poll(), 50);
      if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
        this.diagnosticsTimer = globalThis.setInterval(() => void this.logDiagnostics(), DIAGNOSTICS_INTERVAL_MS);
      }
      if (!this.suspendedAtCreation) await emulator.run();
      this.runningDetail = `${game.executable} 正在 v86 中执行（入口 0x${image.entry.toString(16)}）`;
      this.status('running', this.runningDetail);
    } catch (error) {
      this.status('error', error instanceof Error ? error.message : String(error));
      await this.destroy();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.gamePerformance.reset();
    this.clearPoll();
    if (this.emulator?.is_running()) await this.emulator.stop();
    this.platform.audio.stopAll();
    this.status('stopped', 'VM 已停止');
  }

  postMessage(message: number, wParam = 0, lParam = 0): void {
    if (!this.emulator || !this.shim) return;
    this.shim.postMessage(message, wParam, lParam);
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.shim?.setKeyState(virtualKey, down);
  }

  setCursorPosition(x: number, y: number): void {
    this.shim?.setCursorPosition(x, y);
  }

  setGameClockRate(rate: number): number {
    this.gameClockRate = normalizeGameClockRate(rate);
    this.shim?.setGameClockRate(this.gameClockRate);
    return this.gameClockRate;
  }

  /** Master volume: linear gain 0..1 after combining all guest audio. */
  setMasterVolume(linear: number): void {
    this.platform.audio.setMasterVolume(linear);
  }

  /** Game-independent final shim pointer state, used to verify actual clamping bounds in the Worker. */
  getPointerState(): VmPointerState | null {
    return this.shim?.inspectPointerState() ?? null;
  }

  async getGamePerformance(): Promise<GamePerformanceSample | null> {
    const emulator = this.emulator;
    const create = this.runtimeHooks?.createFrameReader;
    if (!emulator || !this.image || !create || this.currentPhase === 'loading') return null;
    // Detect once per VM on explicit sampling; both execution modes use the same injected game policy.
    this.frameReader ??= Promise.resolve().then(() =>
      this.emulator === emulator ? create(emulator, this.source.executableBytes) : null,
    );
    const reader = await this.frameReader;
    if (this.emulator !== emulator) return null;
    const counters = reader?.();
    if (!counters) {
      this.gamePerformance.reset();
      return null;
    }
    return this.gamePerformance.sample(
      counters,
      performance.now(),
      this.currentPhase === 'running' && this.shim?.inspectShellPageTitle() === '',
    );
  }

  async gameControl(method: string, params?: unknown): Promise<unknown> {
    if (method === 'ui.status') {
      const page = this.shim?.inspectShellPageTitle() ?? null;
      const battleResult = this.control?.battleResult?.() ?? null;
      let battlefield: { ready: boolean; reason?: string; sessionId?: string; frame?: number } = { ready: false };
      if (this.currentPhase === 'running' && this.control && page === '' && !battleResult) {
        try {
          const observation = (await this.control.request('observe', undefined)) as {
            sessionId: string;
            frame: number;
          };
          battlefield = { ready: true, sessionId: observation.sessionId, frame: observation.frame };
        } catch (error) {
          battlefield = { ready: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      return {
        phase: this.currentPhase,
        page,
        controls: page ? (this.shim?.inspectVisibleControlContent() ?? []) : [],
        controlSupported: !!this.control,
        battlefield,
        battleResult,
      };
    }
    if (method === 'capabilities' && !this.control) return { supported: false, actions: [] };
    if (this.currentPhase !== 'running' || !this.control) throw new Error('Game control unavailable');
    if (
      method !== 'capabilities' &&
      method !== 'commandStatus' &&
      (this.shim?.inspectShellPageTitle() || this.control.battleResult?.())
    )
      throw new Error('Battlefield is not active');
    return this.control.request(method, params);
  }

  async getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics> {
    if (action === 'start') {
      this.gamePerformance.reset();
      this.platform.executionProbe?.start();
    } else if (action === 'stop') {
      this.platform.executionProbe?.stop();
    }
    try {
      const game = await this.getGamePerformance();
      return {
        sampledAtMs: performance.now(),
        phase: this.currentPhase,
        hypercalls: this.calls,
        clockRate: this.gameClockRate,
        execution: this.platform.executionProbe?.sample() ?? null,
        game,
      };
    } catch (error) {
      if (action === 'start') this.platform.executionProbe?.stop();
      throw error;
    }
  }

  /** Write the speed state explicitly supplied by the current game; return null if unavailable. */
  setGameSpeedFlag(value: number): number | null {
    const hooks = this.runtimeHooks;
    if (!this.emulator || !hooks?.writeGameSpeedFlag) return null;
    return hooks.writeGameSpeedFlag(this.emulator, value);
  }

  /** Memory-change recording: snapshot current guest RAM as the baseline and start periodic sampling counts. */
  startMemRecord(): boolean {
    if (!this.emulator) return false;
    // Starting again restarts recording: stop the old sampler first.
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    // read_memory returns a view of guest memory, not a copy; copy the baseline immediately,
    // or it will change with the running game and the final diff will always be empty.
    const snapshot = this.emulator.read_memory(0, this.guestMemoryBytes).slice();
    this.memRecordBase = snapshot;
    this.memRecordPrev = snapshot;
    this.memRecordCounts.clear();
    this.memRecordSamples = 0;
    this.memRecordTruncated = false;
    this.memRecordTimer = globalThis.setInterval(() => this.sampleMemRecord(), MEM_RECORD_SAMPLE_MS);
    return true;
  }

  /** Finish recording with a final sample and baseline diff, then release all recording state; return null if not recording. */
  stopMemRecord(): GuestMemRecordResult | null {
    if (!this.emulator || !this.memRecordBase || !this.memRecordPrev) return null;
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    const current = this.emulator.read_memory(0, this.guestMemoryBytes).slice();
    this.sampleMemRecordAgainst(current);
    this.memRecordSamples++;
    const diff = diffMemory(this.memRecordBase, current);
    const counts = [...this.memRecordCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, MEM_RECORD_MAX_REPORT)
      .map(([address, count]) => ({ address, count }));
    const result: GuestMemRecordResult = {
      totalBytes: diff.totalBytes,
      rangeCount: diff.ranges.length,
      samples: this.memRecordSamples,
      truncated: this.memRecordTruncated,
      counts,
    };
    this.memRecordBase = null;
    this.memRecordPrev = null;
    this.memRecordCounts.clear();
    return result;
  }

  /** Periodic sampling: diff against the previous snapshot and increment changed-word counts once; counts are approximate because v86 has no per-write hook. */
  private sampleMemRecord(): void {
    if (!this.emulator || !this.memRecordPrev) return;
    this.sampleMemRecordAgainst(this.emulator.read_memory(0, this.guestMemoryBytes).slice());
    this.memRecordSamples++;
  }

  private sampleMemRecordAgainst(current: Uint8Array): void {
    if (!this.memRecordPrev) return;
    if (accumulateChangedWords(this.memRecordPrev, current, this.memRecordCounts, MEM_RECORD_MAX_ADDRESSES)) {
      this.memRecordTruncated = true;
    }
    this.memRecordPrev = current;
  }

  /** Best-effort flush when unload cannot await; shared by pagehide and Worker flush messages. */
  async flushFiles(): Promise<void> {
    await Promise.allSettled([...this.pendingFileWrites]);
    const writeError = this.pendingFileWriteError;
    this.pendingFileWriteError = null;
    let flushError: unknown = null;
    try {
      await this.source.files.flush();
    } catch (error) {
      flushError = error;
    }
    if (writeError) throw writeError;
    if (flushError) throw flushError instanceof Error ? flushError : new Error(String(flushError));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelBootstrap?.(new Error('VM session destroyed'));
    const launcher = this.launcherCore;
    this.launcherCore = null;
    if (this.processContext) this.processContext.kernel.exit(this.processContext.pid, 1);
    this.platform.executionProbe?.stop();
    this.rangePrefetch.clear();
    this.clearPoll();
    this.hostYieldPending = false;
    this.hostYieldChannel?.port1.close();
    this.hostYieldChannel?.port2.close();
    const emulator = this.emulator;
    const shim = this.shim;
    this.emulator = null;
    this.frameReader = null;
    this.runtimeHooks = undefined;
    this.control?.dispose();
    this.control = null;
    this.gamePerformance.reset();
    this.shim = null;
    this.image = null;
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    this.memRecordBase = null;
    this.memRecordPrev = null;
    this.memRecordCounts.clear();
    shim?.dispose();
    if (launcher) await launcher.destroy();
    if (emulator) {
      emulator.remove_listener('serial0-output-byte', this.hypercallListener);
      await emulator.destroy();
    }
    await Promise.allSettled([...this.pendingFileWrites]);
    await this.source.files.flush();
    await this.platform.audio.destroy();
  }

  private async poll(): Promise<void> {
    if (this.handling || this.debugPaused || !this.emulator || !this.image || !this.shim) return;
    const exception = this.readU32(HYPERCALL_EXCEPTION);
    if (exception !== 0 && this.debugSession) {
      this.debugPaused = true;
      if (this.emulator.is_running()) await this.emulator.stop();
      const vector = exception - 1;
      const eip = this.readU32(HYPERCALL_EXCEPTION_EIP);
      const code =
        vector === 3
          ? 0x80000003
          : vector === 1
            ? 0x80000004
            : vector === 6
              ? 0xc000001d
              : vector === 0
                ? 0xc0000094
                : 0xc0000005;

      this.debugSession.exception(
        this.processContext!.kernel.threadId(this.processContext!.pid, this.readU32(HYPERCALL_THREAD_CURRENT)),
        code,
        vector === 3 ? eip - 1 : eip,
      );
      return;
    }
    if (exception !== 0) {
      this.clearPoll();
      if (this.emulator.is_running()) await this.emulator.stop();
      const vector = exception - 1;
      const eip = this.readU32(HYPERCALL_EXCEPTION_EIP);
      const error = this.readU32(HYPERCALL_EXCEPTION_ERROR);
      const cs = this.readU32(HYPERCALL_EXCEPTION_CS);
      const esp = this.readU32(HYPERCALL_EXCEPTION_ESP);
      const eflags = this.readU32(HYPERCALL_EXCEPTION_EFLAGS);
      const registers = [
        ['EAX', HYPERCALL_EXCEPTION_EAX],
        ['ECX', HYPERCALL_EXCEPTION_ECX],
        ['EDX', HYPERCALL_EXCEPTION_EDX],
        ['EBX', HYPERCALL_EXCEPTION_EBX],
        ['EBP', HYPERCALL_EXCEPTION_EBP],
        ['ESI', HYPERCALL_EXCEPTION_ESI],
        ['EDI', HYPERCALL_EXCEPTION_EDI],
      ]
        .map(([name, address]) => `${name}=0x${this.readU32(address as number).toString(16)}`)
        .join(' ');
      const stack = [...this.emulator.read_memory(esp, 32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const runtimeHooks = this.runtimeHooks;
      const heap = this.shim.inspectHeapState();
      const callback = this.shim.inspectCallbackState();
      const knownHint =
        runtimeHooks?.crashHint?.(vector, eip) ||
        (vector === 0 ? '；除零异常：游戏内除法以 0 为除数，通常伴随数据文件缺失或读取失败' : '');
      this.status(
        'error',
        `CPU 异常 #${vector}：CS:EIP=0x${cs.toString(16)}:0x${eip.toString(16)} ` +
          `ESP=0x${esp.toString(16)} EFLAGS=0x${eflags.toString(16)} error=0x${error.toString(16)}；` +
          `${registers} stack=${stack}；` +
          `堆=live:${heap.liveBytes}/free:${heap.freeBytes}/next:0x${heap.nextAddress.toString(16)}/` +
          `虚拟区:${heap.virtualRegions}×${heap.virtualBytes}/已释放:${heap.virtualFreeBytes}；` +
          `回调=${
            callback
              ? `hwnd=0x${callback.hwnd.toString(16)},msg=0x${callback.message.toString(16)},` +
                `proc=0x${callback.callback.toString(16)},stack=0x${callback.callStack.toString(16)},` +
                `ret=0x${callback.originalReturn.toString(16)},tramp=0x${callback.trampoline.toString(16)},depth=${callback.depth}`
              : '无'
          }；` +
          `最近栈=${
            this.lastCallStack
              ? `${this.lastCallStack.key}@0x${this.lastCallStack.stack.toString(16)}` +
                `→0x${this.lastCallStack.returnAddress.toString(16)}`
              : '无'
          }；` +
          `最近调用：${this.recentCalls.join(' → ') || '无'}；` +
          `打开失败=${this.shim.failedOpens.length ? this.shim.failedOpens.slice(-8).join(' → ') : '无'}${knownHint}`,
      );
      return;
    }
    // Firmware halt marker: treat a direct return from the PE entry point as game exit, even without ExitProcess,
    // rather than leaving the page unresponsive at FPS 0.
    if (this.readU32(HYPERCALL_HALTED) === 1) {
      this.clearPoll();
      if (this.emulator.is_running()) await this.emulator.stop();
      if (this.processContext) this.processContext.kernel.exit(this.processContext.pid, this.readU32(HYPERCALL_EAX));
      this.status('exited', `${this.source.game.executable} 已返回（固件停机，未走 ExitProcess）`);
      return;
    }
    const id = this.readU32(HYPERCALL_REQUEST);
    if (id === 0) return;
    this.handling = true;
    try {
      const imported: PeImport | undefined = this.image.importList[id - 1] ?? this.shim.resolveDynamicImport(id);
      if (!imported || imported.id !== id) throw new Error(`非法 hypercall id: ${id}`);
      const stack = this.readU32(HYPERCALL_STACK);
      const call: Win32Call = {
        imported,
        stack,
        args: readStackArgs(this.emulator, stack, imported.argBytes),
      };
      this.lastCallStack = { key: imported.key, stack, returnAddress: this.readU32(stack) };
      this.calls++;
      this.recentCalls.push(imported.key);
      if (this.recentCalls.length > 16) this.recentCalls.shift();
      this.callbacks.onCall?.(call, this.calls);
      // Win32 APIs are synchronous; the host can complete asynchronous browser fetches while the hypercall stub waits.
      if (imported.key === 'KERNEL32.DLL!FindFirstFileA' && call.args[0] && call.args[1]) {
        const pattern = this.readCString(call.args[0]);
        this.shim.setFileSearchResults(pattern, await readGuestFileSearch(this.source.files, pattern));
      }
      if (
        (imported.key === 'KERNEL32.DLL!CreateFileA' ||
          imported.key === 'KERNEL32.DLL!_lopen' ||
          imported.key === 'WINMM.DLL!mmioOpenA' ||
          imported.key === 'KERNEL32.DLL!LoadLibraryA') &&
        call.args[0]
      ) {
        const sync =
          imported.name === 'LoadLibraryA' ? this.syncGuestLibrary(call.args[0]) : this.syncGuestFile(call.args[0]);
        if (sync) await sync;
      }
      // Unicode opens need the same asynchronous provider read before synchronous guest dispatch.
      if (
        ['OLE32.DLL!StgOpenStorage', 'KERNEL32.DLL!CreateFileW', 'KERNEL32.DLL!LoadLibraryExW'].includes(
          imported.key,
        ) &&
        call.args[0]
      ) {
        const sync =
          imported.name === 'LoadLibraryExW'
            ? this.syncGuestLibrary(call.args[0], true)
            : this.syncGuestFile(call.args[0], true);
        if (sync) await sync;
      }

      // Keep only MOVIES*.MIX index prefixes resident. When the original game seeks to a BIK segment,
      // fetch actual bytes in 2MiB pages at the synchronous ReadFile boundary instead of downloading/copying the whole 300+MiB movie package.
      if (
        (imported.key === 'KERNEL32.DLL!ReadFile' || imported.key === 'KERNEL32.DLL!_lread') &&
        call.args[0] &&
        call.args[2]
      ) {
        const range = this.shim.inspectFileReadRequest(call.args[0], call.args[2]);
        if (range && this.source.files.readRange) {
          const bytes = await this.rangePrefetch.read(
            this.source.files,
            range.path,
            range.offset,
            range.length,
            range.totalSize,
          );
          // A short page is inconsistent with the mounted logical size. Leave it unmounted so the shim returns
          // a read failure without fabricating bytes, advancing the file position, or caching an incomplete response.
          if (bytes?.length === range.length) this.shim.mountFileRange(range.path, range.offset, bytes);
        }
      }

      if (this.destroyed || !this.shim || !this.emulator) return;
      const result = this.shim.dispatch(call);
      if (result?.createProcess) {
        try {
          if (!this.platform.createGuestProcess)
            throw new GuestKernelError(50, 'Guest process creation is unavailable');
          const values = await this.platform.createGuestProcess(result.createProcess);
          if (!this.shim || this.destroyed) return;
          this.shim.completeProcessCreation(result.createProcess.information, values);
          result.eax = 1;
        } catch (error) {
          if (!this.shim || this.destroyed) return;
          if (!(error instanceof GuestKernelError)) throw error;
          this.shim.completeProcessCreation(result.createProcess.information, null, error.code);
          result.eax = 0;
        }
      }
      if (this.debugSession && imported.name === 'CreateThread' && result?.eax) {
        const created = this.shim.inspectGuestThreads().find((thread) => thread.handle === result.eax);
        if (!created) throw new Error('Created guest thread is missing from its process');
        const kernel = this.processContext!.kernel,
          pid = this.processContext!.pid;
        const tid = kernel.threadId(pid, created.id);
        if (call.args[5]) this.writeU32(call.args[5], tid);
        const handle = kernel.debugThreadHandle(this.debugSession.owner, pid, created.id);
        await this.debugSession.threadCreated(tid, handle, call.args[2]!);
        if (this.destroyed || !this.shim) return;
      }
      if (this.debugSession && result?.threadExit) {
        const { kernel, pid } = this.processContext!;
        await this.debugSession.threadExited(kernel.threadId(pid, this.readU32(HYPERCALL_THREAD_CURRENT)), result.eax);
        if (this.destroyed || !this.shim) return;
      }
      if (result?.debugWait) {
        const event = await this.processContext!.kernel.debuggerFor(this.processContext!.pid).wait(
          result.debugWait.timeout,
        );
        if (!this.shim || this.destroyed) return;
        if (event) {
          const bytes = new Uint8Array(96),
            view = new DataView(bytes.buffer);
          [event.code, event.pid, event.tid, ...event.data].forEach((value, index) =>
            view.setUint32(index * 4, value, true),
          );
          this.emulator.write_memory(bytes, result.debugWait.address);
          result.eax = 1;
        } else {
          this.shim.completeProcessCreation(0, null, 121);
          result.eax = 0;
        }
      }
      const shellPageTitle = this.shim.inspectShellPageTitle();
      if (shellPageTitle !== this.lastShellPageTitle) {
        this.lastShellPageTitle = shellPageTitle;
        this.callbacks.onShellPage?.(shellPageTitle);
      }
      if (!result) {
        this.clearPoll();
        if (this.emulator.is_running()) await this.emulator.stop();
        const detail = this.shim.unimplementedDetail;
        this.shim.unimplementedDetail = null;
        this.status('blocked', `Win32 接口待实现：${imported.key}${detail ? `（${detail}）` : ''}`);
        this.callbacks.onBlocked?.(call);
        return;
      }

      let threadDelay = this.shim.prepareGuestThreadReturn(call, result);
      while (threadDelay) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, threadDelay));
        if (this.destroyed || !this.shim) return;
        if (this.processContext) this.shim.synchronizeProcessMemory();
        const completion = this.shim.completeGuestThreadDelay();
        if (completion.result !== undefined) result.eax = completion.result;
        threadDelay = completion.delayMs;
      }

      if (this.processContext) this.shim.synchronizeProcessMemory();
      // Write return registers first, then clear request; zeroing it is the release signal for guest execution.
      this.writeU32(HYPERCALL_EAX, result.eax);
      this.writeU32(HYPERCALL_EDX, result.edx ?? 0);
      this.writeU32(HYPERCALL_REQUEST, 0);
      this.emulator.serial0_send('\0');

      if (result.exit) {
        if (this.processContext) this.processContext.kernel.exit(this.processContext.pid, result.eax);
        this.clearPoll();
        if (this.emulator.is_running()) await this.emulator.stop();
        this.status('exited', `${this.source.game.executable} 已退出，code=${result.eax | 0}`);
      }
    } catch (error) {
      this.clearPoll();
      if (this.emulator?.is_running()) await this.emulator.stop();
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = this.shim
        ? `；最近栈=${
            this.lastCallStack
              ? `${this.lastCallStack.key}@0x${this.lastCallStack.stack.toString(16)}→0x${this.lastCallStack.returnAddress.toString(16)}`
              : '无'
          }；最近调用：${this.recentCalls.join(' → ') || '无'}；` +
          `打开失败=${this.shim.failedOpens.length ? this.shim.failedOpens.slice(-8).join(' → ') : '无'}` +
          (error instanceof Error && error.stack
            ? `；宿主栈=${error.stack
                .split('\n')
                .slice(1, 21)
                .map((line) => line.trim())
                .join(' ← ')}`
            : '')
        : '';
      this.status('error', `${message}${diagnostic}`);
    } finally {
      this.handling = false;
    }
  }

  private yieldToHost(): void {
    if (this.hostYieldPending) return;
    this.hostYieldPending = true;
    if (this.hostYieldChannel) {
      this.hostYieldChannel.port2.postMessage(0);
    } else {
      globalThis.setTimeout(() => {
        this.hostYieldPending = false;
        this.nextHostYieldAt = performance.now() + HOST_SLICE_MS;
        void this.poll();
      }, 0);
    }
  }

  private readU32(address: number): number {
    const b = this.emulator!.read_memory(address, 4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  private writeU32(address: number, value: number): void {
    this.emulator!.write_memory(
      [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff],
      address,
    );
  }

  /**
   * Static resources confirmed absent in this session; avoid crossing File System Access/HTTP providers for thousands of RA2 loose-file probes of MIX entries. Writing a same-named file invalidates the cache immediately.
   */
  private readonly missingStaticGuestFiles = new Set<string>();

  private syncGuestLibrary(pathPtr: number, wide = false): Promise<void> | null {
    const name = wide ? this.readWideString(pathPtr) : this.readCString(pathPtr);
    return this.shim!.hasLoadedGuestLibrary(name) ? null : this.syncGuestFile(pathPtr, wide);
  }

  /**
   * Synchronize current provider content into the Win32 file layer before the guest opens a file.
   * Reread on every open: real Win9x sees externally replaced disk content on the next open, such as a save modified in Windows. The old read-once cache kept returning stale snapshots for Windows saves replaced within a page session, corrupting loaded state.
   */
  private syncGuestFile(pathPtr: number, wide = false): Promise<void> | null {
    const guestPath = wide ? this.readWideString(pathPtr) : this.readCString(pathPtr);
    const normalized = normalizeGuestPath(guestPath);
    if (!normalized) return null;
    const sessionStatic = this.platform.resourcePolicy.isSessionStatic(normalized);
    if (sessionStatic && (this.missingStaticGuestFiles.has(normalized) || this.shim!.hasMountedFile(normalized)))
      return null;
    // A provider can confirm absence from its directory or cache index without reading every MIX resource.
    if (sessionStatic && this.source.files.hasKnownFile?.(guestPath) === false) {
      this.missingStaticGuestFiles.add(normalized);
      return null;
    }
    const sparsePrefix = Object.entries(this.source.game.sparseFilePrefixes ?? {}).find(([path]) => {
      const candidate = normalizeGuestPath(path);
      return normalized === candidate || normalized.endsWith(`/${candidate}`);
    })?.[1];
    return (async () => {
      const provider = this.source.files;
      if (!this.hasPresentedFrame && ['loading', 'ready', 'running'].includes(this.currentPhase)) {
        this.status(this.currentPhase, `正在读取 ${guestPath}…`);
      }
      const sparse = sparsePrefix ? await provider.readPrefix?.(guestPath, sparsePrefix) : null;
      const bytes = sparse?.bytes ?? (await provider.read(guestPath));
      // Cache missing static resources too; RA2 first probes every MIX entry as a loose file.
      if (!bytes) {
        // Hot mounting may occur during an async read; a miss from the old provider must not contaminate the new cache.
        if (sessionStatic && provider === this.source.files) this.missingStaticGuestFiles.add(normalized);
        return;
      }
      this.missingStaticGuestFiles.delete(normalized);
      // provider.read returns a fresh buffer. Transfer its ownership into the
      // synchronous file layer so a 282MiB MIX is not cloned once more before it
      // is copied into the guest fast-read mirror.
      this.shim!.mountFile(guestPath, bytes, true, sparse?.totalSize ?? bytes.length);
      if (sparse && sparse.totalSize > sparse.bytes.length && this.source.files.readRange) {
        this.shim!.markFileRangeBacked(guestPath);
      }
    })();
  }

  private queueFileWrite(path: string, bytes: Uint8Array): void {
    this.rangePrefetch.clear();
    this.missingStaticGuestFiles.delete(normalizeGuestPath(path));
    let write: Promise<void>;
    try {
      write = this.source.files.write(path, bytes);
    } catch (error) {
      write = Promise.reject(error);
    }
    this.pendingFileWrites.add(write);
    void write
      .catch((error) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        this.pendingFileWriteError ??= reason;
        this.status('error', `写入游戏目录失败：${path}；${reason.message}`);
      })
      .finally(() => this.pendingFileWrites.delete(write));
  }

  private readCString(address: number, max = 1024): string {
    const bytes = this.emulator!.read_memory(address, max);
    const nul = bytes.indexOf(0);
    const end = nul < 0 ? bytes.length : nul;
    return decodeGuestNarrow(bytes.subarray(0, end));
  }

  private readWideString(address: number, max = 1024): string {
    const bytes = this.emulator!.read_memory(address, max * 2);
    let end = 0;
    while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end += 2;
    return new TextDecoder('utf-16le').decode(bytes.subarray(0, end));
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) globalThis.clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.diagnosticsTimer !== null) globalThis.clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
  }

  private async logDiagnostics(): Promise<void> {
    const shim = this.shim;
    if (!shim || this.currentPhase !== 'running') return;
    const performance = await this.getGamePerformance().catch(() => null);
    const heap = shim.inspectHeapState();
    const counts = shim.inspectResourceCounts();
    const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
    console.info(
      `[VM诊断] 逻辑帧=${performance?.frame ?? '-'} 逻辑fps=${performance?.logicFps?.toFixed(1) ?? '-'} ` +
        `页面=${shim.inspectShellPageTitle() || '战场'} ` +
        `堆: 活动${heap.liveAllocations}个/${mb(heap.liveBytes)}MB 空闲${mb(heap.freeBytes)}MB(${heap.freeBlocks}块) ` +
        `顶端${mb(heap.nextAddress)}MB 虚拟${mb(heap.virtualBytes)}MB；` +
        `stub已用${(counts.dynamicStubBytes / 1024).toFixed(1)}KB 声音缓冲${counts.soundBuffers} 表面${counts.surfaces}`,
    );
  }

  private currentPhase: VmStatus['phase'] = 'loading';
  private hasPresentedFrame = false;
  private runningDetail = '';

  private status(phase: VmStatus['phase'], detail: string): void {
    this.currentPhase = phase;
    this.callbacks.onStatus?.({ phase, detail });
  }
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function onceReady(emulator: V86): Promise<void> {
  return new Promise((resolve) => emulator.add_listener('emulator-ready', resolve));
}
