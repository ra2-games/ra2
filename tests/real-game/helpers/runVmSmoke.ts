/**
 * VM route smoke harness: start v86 in Node and execute a real original EXE.
 * Callers supply input combinations; do not read selection variables such as VM_GAME / VM_SCENARIO. Trace variables VM_TRACE* / VM_FRAME_PPM / VM_PROFILE remain available for debugging.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { V86 } from 'v86';
import {
  HYPERCALL_EAX,
  HYPERCALL_EDX,
  HYPERCALL_ENTRY,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_EXCEPTION,
  HYPERCALL_EXCEPTION_CS,
  HYPERCALL_EXCEPTION_EAX,
  HYPERCALL_EXCEPTION_EBP,
  HYPERCALL_EXCEPTION_EBX,
  HYPERCALL_EXCEPTION_ECX,
  HYPERCALL_EXCEPTION_EDI,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_EXCEPTION_ERROR,
  HYPERCALL_EXCEPTION_EDX,
  HYPERCALL_EXCEPTION_ESP,
  HYPERCALL_EXCEPTION_EFLAGS,
  HYPERCALL_EXCEPTION_ESI,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
  HYPERCALL_STACK_TOP,
  GUEST_THREAD_CONTEXT_ESPS,
  loadPe,
} from '../../../src/vm86/pe';
import {
  annotateWin32Modules,
  decodeGuestNarrow,
  readStackArgs,
  makeWin32ImportStub,
  makeWin32ImportStubWithFastRead,
  type VmFrame,
} from '../../../src/vm86/win32';
import { normalizeGuestPath } from '../../../src/vm86/paths';
import { patchSessionIni, sessionIniName, type SessionIniOptions } from './sessionIni';
import { Win32Shim } from '../../../src/games/win32Shim';
import { guestFileSearch } from '../../../src/vm86/shim/fileSearch';
import { RGB565_TO_RGBA32 } from '../../../src/vm86/pixels';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../src/games/catalog';
import { REPO_ROOT, requireGameResources, resolveGameDir } from './gameDir';

export type VmClick = readonly [number, number];

function v86WasmPath(): string {
  const candidates = [
    join(REPO_ROOT, 'node_modules/v86/build/v86.wasm'),
    // Git worktrees commonly share dependencies from the main checkout.
    join(REPO_ROOT, '..', '..', 'node_modules/v86/build/v86.wasm'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export interface VmSmokeOptions {
  /** Fixed-EXE regressions may use the executable cache while resources still come from the game directory; never overwrite the player's local EXE. */
  executablePath?: string;
  gameId: SupportedGameId;
  /** Defaults to [[1, 1]] (the original VM_CLICK_X/Y default). */
  clicks?: readonly VmClick[];
  clickGapMessages?: number;
  clickGaps?: readonly number[];
  settleMessages?: number;
  /** Defaults to the registry's menuReadyGate. */
  waitMenuReady?: boolean;
  batchPointerClick?: boolean;
  hoverOnly?: boolean;
  /** Click earlier points normally; inject only WM_MOUSEMOVE at the final point for cross-page hover regressions. */
  finalHoverOnly?: boolean;
  /** Drag a specified press to target coordinates before releasing, to verify real scrollbar dragging. */
  dragTargets?: Readonly<Record<number, VmClick>>;
  firstClickAfterMs?: number;
  timeoutMs?: number;
  enableFastRead?: boolean;
  clockRate?: number;
  /** Override guest memory size, mainly to diagnose games with large images. */
  memoryBytes?: number;
  targetCalls?: number;
  /** Finish loading/animation loops without a message pump after a call count; only for confirmed legacy-game startup routes. */
  completeAtTargetCalls?: boolean;
  keys?: readonly number[];
  /** Shell-page title fragment to await before each click; an empty string disables the gate. */
  clickPageTitles?: readonly string[];
  /** Delay key-sequence injection until after hypercall N. */
  keysAfterCalls?: number;
  skipFrameCheck?: boolean;
  /** Assert on the final presented frame so message-route checks do not miss blank controls. */
  assertFinalFrame?: (frame: VmFrame) => void;
  /** Check control state after interaction so a merely visual scrollbar cannot pass without selecting hidden items. */
  assertFinalState?: (shim: Win32Shim, memory: V86) => void;
  /** Session-only RA2.INI/RA2MD.INI settings the route depends on, such as the resolution its click coordinates use. */
  ini?: SessionIniOptions;
  /** Explicit experimental entry: install guest probes before first execution; the allocator exclusively reserves the startup-stub region. */
  prepareGuest?: (memory: V86, executable: Uint8Array, reserve: (bytes: number) => number) => void;
}

export function vmSmokeTestTimeout(options: VmSmokeOptions): number {
  return Math.max(300_000, (options.timeoutMs ?? 60_000) + 60_000);
}

export function describeVmSmoke(
  title: string,
  options: VmSmokeOptions,
  itName = '原版 EXE 启动并进入主消息循环',
): void {
  // Fail at collection time: the missing executable must surface as a failure, never as a silently removed suite.
  requireGameResources(options.gameId);
  describe(title, () => {
    it(itName, () => runVmSmoke(options), vmSmokeTestTimeout(options));
  });
}

export async function runVmSmoke(options: VmSmokeOptions): Promise<void> {
  const GAME_ID = options.gameId;
  const found = SUPPORTED_GAMES.find((game) => game.id === GAME_ID);
  if (!found) throw new Error(`未知游戏: ${GAME_ID}`);
  const GAME = found;
  const EXECUTABLE = GAME.executable;
  const GAME_DIR = resolveGameDir(GAME_ID);
  const enableFastRead = options.enableFastRead !== false;
  const inputPoints = clampClicks(options.clicks ?? [[1, 1]]);
  const clickGapMessages = Math.max(0, options.clickGapMessages ?? 12);
  const clickGaps = (options.clickGaps ?? []).map((value) => Math.max(0, value | 0));
  const targetCalls = Math.max(0, options.targetCalls ?? 0);
  const hoverOnly = options.hoverOnly === true;
  const finalHoverOnly = options.finalHoverOnly === true;
  const inputDispatchBases: number[] = [];
  let inputDispatchTotal = 0;
  for (let index = 0; index < inputPoints.length; index++) {
    inputDispatchBases.push(inputDispatchTotal);
    inputDispatchTotal +=
      hoverOnly || (finalHoverOnly && index === inputPoints.length - 1) ? 1 : options.dragTargets?.[index] ? 4 : 3;
  }
  const expectedInputDispatches = inputDispatchTotal;
  const batchPointerClick = options.batchPointerClick === true;
  let dragPosted = false;
  // Main-menu readiness gate: wait for the counter at 0x4af1a4 to reach 25 before the first click, or the click is swallowed and the route shifts.
  const waitMenuReady = options.waitMenuReady ?? GAME.menuReadyGate === true;
  const firstClickAfter = Date.now() + Math.max(0, options.firstClickAfterMs ?? 0);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 60_000);
  const keySequence = [...(options.keys ?? [])].map((value) => value | 0);
  const clickPageTitles = (options.clickPageTitles ?? []).map((value) => value.trim().toLowerCase());
  const keysAfterCalls = Math.max(0, options.keysAfterCalls ?? 0);
  const memoryBytes = Math.max(128 * 1024 * 1024, options.memoryBytes ?? GAME.guestMemoryBytes ?? 128 * 1024 * 1024);
  const exe = bytesOf(options.executablePath ?? join(GAME_DIR, EXECUTABLE));
  const biosBytes = bytesOf(join(REPO_ROOT, 'src/vm86/boot.bin'));
  if (biosBytes.length !== 0x10000) throw new Error(`boot.bin 应为 64KB，实际 ${biosBytes.length}`);

  const staging = new Uint8Array(16 * 1024 * 1024);
  let stubNext = 0x80000;
  const image = loadPe(
    staging,
    exe,
    (size) => {
      const address = stubNext;
      stubNext = (stubNext + size + 15) & ~15;
      return address;
    },
    GAME.argBytes,
    enableFastRead ? makeWin32ImportStubWithFastRead : makeWin32ImportStub,
  );
  annotateWin32Modules(image.importList);
  if (GAME.smokeEntry !== undefined && image.entry !== GAME.smokeEntry) {
    throw new Error(`PE 入口错误: 0x${image.entry.toString(16)}`);
  }
  // XWIS-distributed RA2 adds startup-handshake ord1 outside the original import table; the profile supports both EXEs.
  const launcherImports =
    GAME_ID === 'ra2' ? image.importList.filter((imported) => imported.key === 'XWIS.DLL!ord1').length : 0;
  if (GAME.smokeImports !== undefined && image.importList.length - launcherImports !== GAME.smokeImports) {
    throw new Error(`PE 导入数错误: ${image.importList.length}`);
  }
  /** Run one VM round: load EXE -> input route -> completion/timeout/exception. */
  async function runPass() {
    const mapTrace: unknown[] = [];
    const stats = {
      fileWrites: new Map<string, Uint8Array>(),
      exitCode: 0,
    };

    const emulator = new V86({
      wasm_path: v86WasmPath(),
      memory_size: memoryBytes,
      bios: { buffer: exactBuffer(biosBytes) },
      autostart: false,
      disable_jit: process.env.VM_DISABLE_JIT === '1',
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
    });
    await new Promise<void>((done) => emulator.add_listener('emulator-ready', done));
    emulator.write_memory(staging.subarray(HYPERCALL_STACK, stubNext), HYPERCALL_STACK);
    emulator.write_memory(staging.subarray(image.imageBase, image.imageBase + image.sizeOfImage), image.imageBase);
    const runtimeHooks = GAME.runtimeHooks?.resolve?.(emulator, exe) ?? GAME.runtimeHooks;
    runtimeHooks?.prepareImage?.(emulator);
    let probeNext = stubNext;
    options.prepareGuest?.(emulator, exe, (size) => {
      const address = probeNext;
      // The region from 0xc0000 belongs to dynamic shim stubs; zero current bytes do not make it available.
      if (!Number.isInteger(size) || size <= 0 || address + size > 0xc0000) throw new Error('实验探针桩区不足');
      probeNext = (address + size + 15) & ~15;
      return address;
    });
    writeU32(emulator, HYPERCALL_ENTRY, image.entry);
    writeU32(emulator, HYPERCALL_CALLBACK_DEPTH, 0);
    writeU32(emulator, HYPERCALL_STACK_TOP, GAME.stackTop ?? 0x0070_0000);
    let frames = 0;
    let frameBytes = 0;
    let lastFrameSize = '';
    let lastFrame: VmFrame | null = null;
    // Periodic frame dumps for UI timing observations, such as automatic title-to-menu transitions.
    const frameEveryMs = Math.max(0, Number(process.env.VM_FRAME_EVERY_MS ?? 0) | 0);
    const frameTimer =
      frameEveryMs > 0
        ? setInterval(() => {
            if (lastFrame) writePpm(`/tmp/frame-${Date.now()}.ppm`, lastFrame);
          }, frameEveryMs)
        : undefined;
    const shim = new Win32Shim(emulator, {
      firstDynamicId: image.importList.length + 1,
      staticImports: image.importList,
      enableFastFileMirror: enableFastRead,
      moduleName: EXECUTABLE,
      gameProfile: process.env.VM_COMPOSITE === '0' ? { ...GAME.shimProfile, shell: undefined } : GAME.shimProfile,
      driveTypes: GAME.driveTypes,
      volumeSerial: Number(process.env.VM_SERIAL ?? 0x2001_0701) >>> 0,
      heapBase: GAME.heapBase ?? GAME.stackTop,
      virtualTop: GAME.arenaTop,
      virtualBase: GAME.heapBase,
      heapTop: GAME.arenaTop,
      importArgBytes: GAME.argBytes,
      dynamicImportStub: enableFastRead ? makeWin32ImportStubWithFastRead : makeWin32ImportStub,
      fastFileMirrorLimit:
        GAME.fastFileMirrorBase !== undefined && GAME.fastFileMirrorTop !== undefined
          ? Math.max(0, Math.min(GAME.fastFileMirrorTop, memoryBytes) - GAME.fastFileMirrorBase)
          : GAME.guestMemoryBytes
            ? Math.floor(GAME.guestMemoryBytes / 2)
            : undefined,
      fastFileMirrorBase: GAME.fastFileMirrorBase,
      fastFileMirrorTop:
        GAME.fastFileMirrorTop === undefined ? undefined : Math.min(GAME.fastFileMirrorTop, memoryBytes),
      fastFileMirrorFiles: GAME.fastFileMirrorFiles,
      scheduleFrame: (emit) => {
        setImmediate(emit);
      },
      packedRgb565Frames: process.env.VM_PACKED_FRAMES === '1',
      // Match the browser worker mailbox: while a frame is pending, retain only
      // the dirty bit and snapshot the newest surface at delivery time. Campaign
      // transitions can otherwise queue hundreds of 1440x900 RGBA allocations.
      deferFrameSnapshot: true,
      onFrame: (frame) => {
        frames++;
        frameBytes += frame.rgba?.byteLength ?? frame.rgb565?.byteLength ?? frame.pixels.byteLength;
        if (firstFrameMs < 0) firstFrameMs = performance.now() - profileT0;
        lastFrameSize = `${frame.width}x${frame.height}`;
        lastFrame = frame;
        const frameDumpLimit = Math.max(1, Number(process.env.VM_FRAME_PPM_LIMIT ?? 64) | 0);
        if (process.env.VM_FRAME_PPM_PREFIX && frames <= frameDumpLimit) {
          writePpm(`${process.env.VM_FRAME_PPM_PREFIX}-${String(frames).padStart(3, '0')}.ppm`, frame);
        }
      },
      onFileWrite: (path, bytes) => {
        stats.fileWrites.set(path, bytes);
        console.log(`📁 客体写文件 ${path} ${bytes.length}B`);
      },
    });
    // On a real machine, the original EXE exists in the game directory; the virtual file layer must also be able to open it.
    // normalizeGuestPath retains the GAME prefix, so mount the full path to match.
    shim.mountFile(`C:\\GAME\\${EXECUTABLE}`, exe);
    let linkedEntry = image.entry;
    for (const preload of GAME.preloadFiles ?? []) {
      const preloadPath = resolveGuestFile(GAME_DIR, preload.path);
      if (!preloadPath) {
        if (preload.linkBeforeEntry) throw new Error(`Required guest DLL is missing: ${preload.path}`);
        continue;
      }
      // readFileSync returns a fresh buffer for this mount; transfer ownership so
      // large DLL/archive fixtures are not duplicated before the guest mirror is built.
      shim.mountFile(preload.path, bytesOf(preloadPath), true);
      if (preload.linkBeforeEntry) {
        linkedEntry = shim.linkGuestDllBeforeEntry(preload.path, linkedEntry, image.importList);
      } else if (preload.initializeBeforeEntry) {
        linkedEntry = shim.initializeGuestDllBeforeEntry(preload.path, linkedEntry);
      }
    }
    if (linkedEntry !== image.entry) writeU32(emulator, HYPERCALL_ENTRY, linkedEntry);
    shim.setGameClockRate(options.clockRate ?? 1);

    // Continuous DPlay probing: observe shim-state changes in polling ticks. DP creation can occur during reload,
    // so a single post-settle check may miss it. Judge completion using the maximum observed value.
    const dpSeen = { created: 0, hosting: false, joined: false, players: 0 };
    let dpProbeLastLog = '';
    const watchDplay = (): void => {
      if (!process.env.VM_DP_PROBE) return;
      const st = shim.inspectDplayState();
      if (st.created > dpSeen.created) dpSeen.created = st.created;
      if (st.session?.hosting) dpSeen.hosting = true;
      if (st.session?.hosting === false) dpSeen.joined = true;
      if (st.players.length > dpSeen.players) dpSeen.players = st.players.length;
      const line = `${st.created},${st.session?.hosting ?? '-'},${st.players.length}`;
      if (line !== dpProbeLastLog) {
        dpProbeLastLog = line;
        console.log(`🔎 DPlay 变化：${JSON.stringify(st)}`);
      }
    };
    let calls = 0;
    let stackWatchSeen = false;
    let breakOriginal: number | undefined;
    // Single-step mode: set TF after VM_STEP_AFTER API calls; boot's #1 handler publishes EIP after each instruction.
    const stepAfter = Math.max(0, Number(process.env.VM_STEP_AFTER ?? 0) | 0);
    let stepTraceMode = false;
    const stepTrace: number[] = [];
    const callCounts = new Map<string, number>();
    // VM_PROFILE timing: cumulative and maximum host-side duration per import, in milliseconds.
    const callTimes = new Map<string, number>();
    const callMaxTimes = new Map<string, number>();
    let dispatchTotalMs = 0;
    // Cumulative harness file resolution/read/mount cost, corresponding to production syncGuestFile provider round trips.
    let fileMountMs = 0;
    let fileMountCount = 0;
    const profileT0 = performance.now();
    let firstFrameMs = -1;
    let mainLoopMs = -1;
    const fileReadSizes = new Map<number, number>();
    let first = '';
    let blocked = '';
    let exitSeen = false;
    let reachedMainLoop = false;
    let inputPhase = 0;
    let inputIndex = 0;
    let clickGap = 0;
    let keyIndex = 0;
    let keyDownPosted = false;
    let keyUpPosted = false;
    let charPosted = false;
    const dispatchedKey: number[] = [];
    const dispatchedInput: number[] = [];
    let settleMessages = Math.max(0, options.settleMessages ?? 0);
    let nextProgressCall = 250_000;
    const tracedDirectDraw = new Set<string>();
    const tracedFonts = new Set<string>();
    const tracedControlCalls = new Set<string>();
    const tracedShowWindows = new Set<string>();
    const defaultControlMessages = new Map<string, { count: number; result: number; wParam: number; lParam: number }>();
    const recentCalls: string[] = [];
    // Synchronization primitive/message usage counts by handle type, to investigate whether event stubs cause loading stalls.
    const syncOps = {
      createEvent: 0,
      setEvent: 0,
      resetEvent: 0,
      waitMutex: 0,
      waitEvent: 0,
      waitThread: 0,
      waitOther: 0,
      waitMulti: 0,
      postMessage: 0,
      sendMessage: 0,
      postThread: 0,
      createThread: 0,
      fileOpenByThread: new Map<number, number>(),
    };
    // VM_TRACE_AFTER_CLICK starts full tracing only after the final click's WM_LBUTTONDOWN,
    // showing precise gadget/menu responses to one click without overwhelming startup traffic.
    const traceAfterClick = process.env.VM_TRACE_AFTER_CLICK === '1';
    let traceArmed = false;
    // VM_TRACE_AFTER_CALLS prints VM_TRACE lines only after hypercall N; combine it with
    // VM_KEYS_AFTER_CALLS to observe guest responses after key injection while skipping map-loading traffic.
    const traceAfterCalls = Math.max(0, Number(process.env.VM_TRACE_AFTER_CALLS ?? 0) | 0);
    // Retain a few COM/OLE boundaries and return values; millions of map-loading calls make full VM_TRACE impractical.
    const recentComCalls: string[] = [];
    const recentBinkCalls: string[] = [];
    const formatProfile = () => {
      const topCalls = [...callCounts]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([key, count]) => `${key}=${count}`)
        .join(', ');
      const topReadSizes = [...fileReadSizes]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 16)
        .map(([size, count]) => `${size}B×${count}`)
        .join(', ');
      // Sort by cumulative host duration for the complete call count x cost-per-call view.
      const topTimes = [...callTimes]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(
          ([key, ms]) =>
            `${key}=${ms.toFixed(1)}ms/${callCounts.get(key) ?? 0}次` +
            `(均${(ms / Math.max(1, callCounts.get(key) ?? 1)).toFixed(3)}ms,峰${(callMaxTimes.get(key) ?? 0).toFixed(1)}ms)`,
        )
        .join(', ');
      return { topCalls, topReadSizes, topTimes };
    };
    const completion = new Promise<void>((done, reject) => {
      let poll: ReturnType<typeof setInterval>;
      let delayTimer: ReturnType<typeof setTimeout> | undefined;
      let waiting = false;
      let stopped = false;
      const notify = () => queueMicrotask(service);
      // VM_PROFILE timeline: report call/time deltas and the top five incremental costs every second to locate phase-specific hotspots.
      let timelineLastCalls = 0;
      let timelineLastDispatchMs = 0;
      let timelineLastFrames = 0;
      const timelineCounts = new Map<string, number>();
      const timelineTimer = process.env.VM_PROFILE
        ? setInterval(() => {
            const deltaCalls = calls - timelineLastCalls;
            const deltaMs = dispatchTotalMs - timelineLastDispatchMs;
            const deltaFrames = frames - timelineLastFrames;
            const deltas: Array<[string, number]> = [];
            for (const [key, count] of callCounts) {
              const prev = timelineCounts.get(key) ?? 0;
              if (count > prev) deltas.push([key, count - prev]);
              timelineCounts.set(key, count);
            }
            deltas.sort((a, b) => b[1] - a[1]);
            const top = deltas
              .slice(0, 5)
              .map(([k, n]) => `${k.split('!')[1]}×${n}`)
              .join(' ');
            console.log(
              `⏱️ [${((performance.now() - profileT0) / 1000).toFixed(1)}s] ` +
                `calls+${deltaCalls} host+${deltaMs.toFixed(0)}ms frames+${deltaFrames} | ${top}`,
            );
            timelineLastCalls = calls;
            timelineLastDispatchMs = dispatchTotalMs;
            timelineLastFrames = frames;
          }, 1000)
        : undefined;
      // EIP sampling (VM_EIP_SAMPLE_MS): periodically sample [instruction count, EIP] to replay the trace after a crash.
      const eipSampleMs = Math.max(0, Number(process.env.VM_EIP_SAMPLE_MS ?? 0) | 0);
      const eipSamples: Array<[number, number]> = [];
      const eipSnapshots = new Map<number, string>();
      let lastLowEip = 0;
      const sampleTimer =
        eipSampleMs > 0
          ? setInterval(() => {
              const cpu = (
                emulator as unknown as {
                  v86?: { cpu?: { get_real_eip?: () => number } };
                }
              ).v86?.cpu;
              const eip = cpu?.get_real_eip?.();
              if (eip !== undefined) eipSamples.push([emulator.get_instruction_counter(), eip]);
              if (eipSamples.length > 16384) eipSamples.splice(0, 8192);
              // Detect low-to-high (loading-region) transitions to locate the instruction that jumped into the loading region.
              if (eip !== undefined) {
                if (eip < 0x1000000) lastLowEip = eip;
                else if (eip > 0x40000000 && lastLowEip) {
                  console.log(
                    `🔍 跳变 ${emulator.get_instruction_counter()}: 0x${lastLowEip.toString(16)} → 0x${eip.toString(16)}`,
                  );
                  lastLowEip = 0;
                }
              }
              // For execution in the loading region (8 MB below memory top), capture instruction-byte snapshots when sampling.
              const top = memoryBytes;
              if (eip !== undefined && eip > top - 8 * 1024 * 1024 && eip < top && !eipSnapshots.has(eip & ~0xf)) {
                eipSnapshots.set(
                  eip & ~0xf,
                  [...emulator.read_memory(eip & ~0xf, 64)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
                );
                if (eipSnapshots.size > 64) {
                  const oldest = eipSnapshots.keys().next().value;
                  if (oldest !== undefined) eipSnapshots.delete(oldest);
                }
              }
            }, eipSampleMs)
          : undefined;
      // Battlefield freeze diagnostics (VM_BATTLE_DUMP_MS): periodically report current EIP, recent calls, and network-call counts.
      const battleDumpMs = Math.max(0, Number(process.env.VM_BATTLE_DUMP_MS ?? 0) | 0);
      let battleEips: number[] = [];
      const battleSampleTimer =
        battleDumpMs > 0
          ? setInterval(() => {
              const cpu = (emulator as unknown as { v86?: { cpu?: { get_real_eip?: () => number } } }).v86?.cpu;
              const eip = cpu?.get_real_eip?.();
              if (eip !== undefined) battleEips.push(eip);
            }, 5)
          : undefined;
      const battleDumpTimer =
        battleDumpMs > 0
          ? setInterval(() => {
              const freq = new Map<number, number>();
              for (const eip of battleEips) freq.set(eip, (freq.get(eip) ?? 0) + 1);
              const top = [...freq.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([eip, n]) => `0x${eip.toString(16)}×${n}`)
                .join(' ');
              const timerCalls = recentCalls.filter(
                (c) => c.includes('TickCount') || c.includes('imeGetTime') || c.includes('PerformanceCounter'),
              ).length;
              // Main-loop progress flag checked by the message loop at 0x522ed0.
              const flagA = readU32(emulator, 0xa522ac);
              const flagB = readU32(emulator, 0xa522e0);
              const flagC = readU32(emulator, 0xa522d4);
              // RA2 load-readiness chain diagnostics: prerequisites for 0x690246 calling 0x522c50 to set [0xa522ac]=1.
              const flagA41 = readU32(emulator, 0xa41664); // Must equal 1
              const flagB0 = readU32(emulator, 0xa522b0); // Must be nonzero
              const flagD0 = readU32(emulator, 0xa522d0); // Must equal 0
              // Key main-game state-machine transition (0x5138ee): state runner 0x516f00 enters setup only when
              // [0x7d20e0]==-2 or [0x850828]==1; otherwise it returns state 7.
              const flag850 = readU32(emulator, 0x850828);
              const flag7d2 = readU32(emulator, 0x7d20e0);
              // Persistent state-machine mode [0xa3d298]: 0 -> initial state18 (create loading dialog), 4 -> state17, otherwise -> state16.
              // [0xa40d05]!=0 -> state 8; [0xa40d13]!=0 -> skip initialization.
              const statePersist = readU32(emulator, 0xa3d298);
              const flagD05 = readU32(emulator, 0xa40d05);
              const flagD13 = readU32(emulator, 0xa40d13);
              // Internal substate [0xa3d2a4] of the scene-loading pipeline at 0x73a300 (0..5 dispatched through 0x73a65c);
              // [0x7db55c]: 2 = wait in a loop, -1 = advance.
              const loadSub = readU32(emulator, 0xa3d2a4);
              const flagB55c = readU32(emulator, 0x7db55c);
              // 0x753110 starts asynchronous loading through [0xa72d00] (the COM loader object); zero skips it and enters an idle
              // modal loop. Prerequisites also check container 0xb26cb8's count (0x76e7a0) and the string at 0xb29018.
              const comLoader = readU32(emulator, 0xa72d00);
              const comLoaderVt = comLoader ? readU32(emulator, comLoader) : 0;
              const wmTimer = shim.inspectPointerState().wmTimerDispatches;
              const cpuT = (
                emulator as unknown as { v86?: { cpu?: { current_tsc?: Uint32Array; store_current_tsc?: () => void } } }
              ).v86?.cpu;
              let tscStr = 'N/A';
              try {
                cpuT?.store_current_tsc?.();
                const t = cpuT?.current_tsc;
                if (t) tscStr = `hi=0x${t[1]!.toString(16)} lo=0x${t[0]!.toString(16)}`;
              } catch {
                /* ignore */
              }
              // World-progress gate object: the difference between +0x34 and +0x38 of [0xa522cc] determines whether to advance.
              const gateObj = readU32(emulator, 0xa522cc);
              const g34 = gateObj ? readU32(emulator, gateObj + 0x34) : 0;
              const g38 = gateObj ? readU32(emulator, gateObj + 0x38) : 0;
              const gateStr = `obj=0x${gateObj.toString(16)} +34=${g34} +38=${g38} 差=${(g34 - g38) | 0}`;
              const getTimeFn = readU32(emulator, 0x831558);
              // Experiment: 0x83155c is the main game tick counter (incremented at 0x409310). Sample its increase against
              // wall time to measure actual logic progress directly (speed5 should be about 30 ticks/second).
              const gameTick = readU32(emulator, 0x83155c);
              console.log(
                `🔬 [${emulator.get_instruction_counter()}] 采样${battleEips.length} EIP热点=${top} 定时器=${timerCalls} WM_TIMER=${wmTimer} TSC.hi=${tscStr.split(' ')[0]} 门控${gateStr} getTimeFn=0x${getTimeFn.toString(16)} 标志=${flagA}/${flagB}/${flagC} shortGame=${emulator.read_memory(0xa3d2c2, 1)[0]} a41664=${flagA41} b0=0x${flagB0.toString(16)} d0=0x${flagD0.toString(16)} 850=0x${flag850.toString(16)} 7d2=0x${flag7d2.toString(16)} a3d298=0x${statePersist.toString(16)} d05=${flagD05} d13=${flagD13} loadSub=${loadSub} b55c=${flagB55c} comLoader=0x${comLoader.toString(16)}/vt0x${comLoaderVt.toString(16)} gameTick=${gameTick} 最近=${recentCalls.slice(-5).join('→') || '无'}`,
              );
              const localHouse = readU32(emulator, 0xa35db4);
              const houseVector = readU32(emulator, 0xa3229c);
              const houses: string[] = [];
              for (let i = 0; houseVector && i < 8; i++) {
                const house = readU32(emulator, houseVector + i * 4);
                if (!house) continue;
                houses.push(
                  `#${i}@0x${house.toString(16)}${house === localHouse ? '*' : ''}` +
                    `[228=${readU32(emulator, house + 0x228)},230=${readU32(emulator, house + 0x230)},` +
                    `234=${readU32(emulator, house + 0x234)},238=${readU32(emulator, house + 0x238)},` +
                    `flags=${[0x134, 0x135, 0x13d, 0x13e, 0x13f, 0x140]
                      .map((offset) => emulator.read_memory(house + offset, 1)[0]!)
                      .join('/')},` +
                    `timers=${readU32(emulator, house + 0x1e0)}/${readU32(emulator, house + 0x1e8)}]`,
                );
              }
              console.log(
                `🔬 House：local=0x${localHouse.toString(16)} vector=0x${houseVector.toString(16)} ${houses.join(' ') || '无'}`,
              );
              // Guest thread snapshot: check whether the game logic thread is blocked.
              const threads = shim
                .inspectGuestThreads()
                .map(
                  (t) =>
                    `#${t.id}${t.current ? '*' : ''}${t.terminated ? '✝' : t.runnable ? '✓' : '…'}${t.waitForThread !== undefined ? '>等' + t.waitForThread : ''}${t.wakeInMs > 0 ? '>眠' + t.wakeInMs : ''}`,
                )
                .join(' ');
              console.log(`🔬 线程：${threads}`);
              console.log(
                `🔬 同步原语：createEvent=${syncOps.createEvent} setEvent=${syncOps.setEvent} resetEvent=${syncOps.resetEvent} waitMutex=${syncOps.waitMutex} waitEvent=${syncOps.waitEvent} waitOther=${syncOps.waitOther} waitMulti=${syncOps.waitMulti} post=${syncOps.postMessage} send=${syncOps.sendMessage} postThread=${syncOps.postThread} createThread=${syncOps.createThread} 文件打开按线程=${[...syncOps.fileOpenByThread.entries()].map(([t, c]) => `#${t}:${c}`).join(',')}`,
              );
              // Load-completion check (0x5bdb4f): list [0xa3fa80], count [0xa3fa8c], with item +0x5b==-1 meaning complete.
              // Only when nearly all items finish is 0x6e0 sent to advance [0xa3d2a4]. Dump item states to identify stalls.
              const itemCount = readU32(emulator, 0xa3fa8c);
              const itemList = readU32(emulator, 0xa3fa80);
              const a71e8c = readU32(emulator, 0xa71e8c);
              let doneCount = 0;
              const pendingItems: string[] = [];
              for (let i = 0; i < itemCount && i < 64; i++) {
                const item = readU32(emulator, itemList + i * 4);
                if (!item) continue;
                const doneFlag = readU32(emulator, item + 0x5b);
                if (doneFlag === 0xffffffff) doneCount++;
                else pendingItems.push(`#${i}@0x${item.toString(16)}+5b=0x${doneFlag.toString(16)}`);
              }
              console.log(
                `🔬 加载项：总数=${itemCount} 已完成=${doneCount} 待完成=${itemCount - doneCount} a71e8c=0x${a71e8c.toString(16)} 待完成项=${pendingItems.slice(0, 8).join(' ') || '无'}`,
              );
              // Main-thread stack frames reconstruct the main-loop call chain.
              const cpu2 = (emulator as unknown as { v86?: { cpu?: { reg32?: Int32Array } } }).v86?.cpu;
              const esp = cpu2?.reg32?.[4];
              if (esp) {
                const frames: number[] = [];
                for (let off = 0; off < 0x800 && frames.length < 8; off += 4) {
                  const value = readU32(emulator, esp + off);
                  if (value >= 0x401000 && value <= 0x799000) frames.push(value);
                }
                console.log(`🔬 主线程栈帧：[${frames.map((v) => '0x' + v.toString(16)).join(',')}]`);
              }
              // Background-thread resume EIPs and stack frames locate loading/logic-thread stalls beyond the main thread.
              for (const thread of shim.inspectGuestThreads()) {
                if (thread.current || thread.terminated) continue;
                const savedEsp = readU32(emulator, GUEST_THREAD_CONTEXT_ESPS + thread.id * 4);
                if (!savedEsp) continue;
                const cont = readU32(emulator, savedEsp + 36);
                const tframes: number[] = [];
                for (let off = 36; off < 0x400 && tframes.length < 6; off += 4) {
                  const value = readU32(emulator, savedEsp + off);
                  if (value >= 0x401000 && value <= 0x799000) tframes.push(value);
                }
                console.log(
                  `🔬 线程${thread.id} cont=0x${cont.toString(16)} 帧=[${tframes.map((v) => '0x' + v.toString(16)).join(',')}]`,
                );
              }
              if (process.env.VM_DUMP_WINDOWS === '1') {
                console.log(`🔬 页标题="${shim.inspectShellPageTitle()}"`);
                for (const w of shim.inspectWindowState()) {
                  const r = w.rect;
                  console.log(
                    `🪟 hwnd=0x${w.hwnd.toString(16)} id=${w.id} cls=${w.className} 文本="${w.text}" 矩形=${r ? `${r.x},${r.y} ${r.width}x${r.height}` : '无'} 风格=0x${w.style.toString(16)} cb=${w.callback ? '有' : '无'}`,
                  );
                }
              }
              if (process.env.VM_DUMP_SURFACES === '1') {
                const list = shim.inspectSurfaceObjects();
                console.log(
                  `🖼️ surface列表：${list.map((s) => `0x${s.object.toString(16)}(${s.width}x${s.height}b${s.bpp}c0x${s.caps.toString(16)})`).join(' ')}`,
                );
                if (lastFrame) writePpm('/tmp/surf-presented.ppm', lastFrame); // Composited presentation frame at the same instant
                let idx = 0;
                for (const s of list) {
                  if (s.height === 600 && s.bpp === 16) {
                    const snap = shim.inspectSurface(s.object);
                    if (snap)
                      writeSurfacePpm(
                        `/tmp/surf-${String(idx++).padStart(2, '0')}-0x${s.object.toString(16)}-${s.width}x${s.height}-c${s.caps.toString(16)}.ppm`,
                        snap,
                      );
                  }
                }
              }
              battleEips = [];
            }, battleDumpMs)
          : undefined;
      const formatEipSamples = (): string => {
        // Coalesce consecutive identical EIPs into segments and print the latest 40.
        const runs: Array<{ eip: number; count: number; insn: number }> = [];
        for (const [insn, eip] of eipSamples) {
          const last = runs[runs.length - 1];
          if (last && last.eip === eip) {
            last.count++;
            last.insn = insn;
          } else runs.push({ eip, count: 1, insn });
        }
        return runs
          .slice(-200)
          .map((run) => `0x${run.eip.toString(16)}×${run.count}@${run.insn}`)
          .join(' → ');
      };
      const cleanup = () => {
        stopped = true;
        clearTimeout(deadline);
        clearTimeout(delayTimer);
        clearInterval(poll);
        if (timelineTimer) clearInterval(timelineTimer);
        if (sampleTimer) clearInterval(sampleTimer);
        if (battleDumpTimer) clearInterval(battleDumpTimer);
        if (battleSampleTimer) clearInterval(battleSampleTimer);
        if (frameTimer) clearInterval(frameTimer);
        emulator.remove_listener('serial0-output-byte', notify);
      };
      const deadline = setTimeout(() => {
        cleanup();
        if (process.env.VM_FRAME_PPM && lastFrame) writePpm(process.env.VM_FRAME_PPM, lastFrame);
        if (process.env.VM_PROFILE) {
          const profile = formatProfile();
          console.log(`📊 Win32 调用 Top 20：${profile.topCalls}`);
          console.log(`📊 耗时 Top 20：${profile.topTimes}`);
          console.log(
            `📊 dispatch 总耗时：${dispatchTotalMs.toFixed(0)}ms / ${calls} 次（均 ${(dispatchTotalMs / Math.max(1, calls)).toFixed(3)}ms）`,
          );
          console.log(`📊 文件挂载（harness/provider 侧）：${fileMountMs.toFixed(0)}ms / ${fileMountCount} 次`);
          console.log(
            `📊 里程碑：首帧=${firstFrameMs.toFixed(0)}ms 主循环=${mainLoopMs.toFixed(0)}ms 总计=${(performance.now() - profileT0).toFixed(0)}ms`,
          );
          console.log(`📊 _lread 长度：${profile.topReadSizes || '无'}`);
          console.log(`📊 超时时 shell 页标题：${JSON.stringify(shim.inspectShellPageTitle())}`);
          console.log(`📊 超时时输入：${dispatchedInput.join(',') || '无'}`);
          console.log(`📊 最近调用：${recentCalls.join(' → ') || '无'}`);
          console.log(`📊 最近 Bink：${recentBinkCalls.join(' → ') || '无'}`);
          console.log(`📊 最后回调：${JSON.stringify(shim.inspectCallbackState())}`);
          console.log(`📊 宿主输入：${JSON.stringify(shim.inspectHostInputTrace())}`);
          console.log(`📊 窗口快照：${JSON.stringify(shim.inspectWindowState())}`);
          console.log(`📊 客体线程：${JSON.stringify(shim.inspectGuestThreads())}`);
          // Each sleeping thread's resume EIP (continuation at pushad frame +36), to locate individual stalls.
          for (const thread of shim.inspectGuestThreads()) {
            if (thread.current || thread.terminated) continue;
            const savedEsp = readU32(emulator, GUEST_THREAD_CONTEXT_ESPS + thread.id * 4);
            if (!savedEsp) continue;
            const cont = readU32(emulator, savedEsp + 36);
            // Walk up the stack for return addresses in .text to reconstruct the call chain.
            const frames: number[] = [];
            for (let off = 36; off < 0x400 && frames.length < 6; off += 4) {
              const value = readU32(emulator, savedEsp + off);
              if (value >= 0x401000 && value <= 0x799000) frames.push(value);
            }
            console.log(
              `📊 线程 ${thread.id} 栈：cont=0x${cont.toString(16)} 帧=[${frames.map((v) => '0x' + v.toString(16)).join(',')}]`,
            );
          }
          const cpu = (
            emulator as unknown as {
              v86?: { cpu?: { get_real_eip?: () => number; reg32?: Int32Array } };
            }
          ).v86?.cpu;
          const eip = cpu?.get_real_eip?.();
          const regs = cpu?.reg32 ? [...cpu.reg32].map((value) => `0x${(value >>> 0).toString(16)}`).join(',') : '';
          console.log(
            `📊 超时 CPU：EIP=${eip === undefined ? '未知' : `0x${eip.toString(16)}`} regs=${regs || '未知'}`,
          );
          const pendingException = readU32(emulator, HYPERCALL_EXCEPTION);
          if (pendingException) {
            console.log(
              `📊 超时异常：#${pendingException - 1} ` +
                `CS:EIP=0x${readU32(emulator, HYPERCALL_EXCEPTION_CS).toString(16)}:` +
                `0x${readU32(emulator, HYPERCALL_EXCEPTION_EIP).toString(16)} ` +
                `ESP=0x${readU32(emulator, HYPERCALL_EXCEPTION_ESP).toString(16)} ` +
                `error=0x${readU32(emulator, HYPERCALL_EXCEPTION_ERROR).toString(16)}`,
            );
          }
          // The main thread is in a hypercall stub; scan from current ESP for .text return addresses to reconstruct the loading loop.
          const esp = cpu?.reg32?.[4];
          if (esp) {
            const frames: number[] = [];
            for (let off = 0; off < 0x600 && frames.length < 10; off += 4) {
              const value = readU32(emulator, esp + off);
              if (value >= 0x401000 && value <= 0x799000) frames.push(value);
            }
            console.log(`📊 主线程栈帧：[${frames.map((v) => '0x' + v.toString(16)).join(',')}]`);
          }
          if (eipSamples.length) console.log(`📊 EIP轨迹 ${formatEipSamples()}`);
        }
        reject(new Error(`VM 超时：calls=${calls}，blocked=${blocked || '无'}`));
      }, timeoutMs);
      function service(): void {
        if (stopped || waiting) return;
        watchDplay();
        const exception = readU32(emulator, HYPERCALL_EXCEPTION);
        if (exception === 1 && stepTraceMode) {
          // Single-step trace: record EIP and clear the publication signal; the #1 handler resumes through iret.
          stepTrace.push(readU32(emulator, HYPERCALL_EXCEPTION_EIP));
          if (stepTrace.length >= 2500) {
            // For VM_STEP_ON_CLICK: clear TF after 2500 instructions and return to full speed.
            stepTraceMode = false;
            writeU32(emulator, 0x60050, 0);
          }
          writeU32(emulator, HYPERCALL_EXCEPTION, 0);
          return;
        }
        // HYPERCALL_EXCEPTION stores vector + 1; INT3 is vector 3, so the value here must be 4.
        if (exception === 4 && breakOriginal !== undefined) {
          // int3 breakpoint: print context and terminate (exception_common has already halted).
          cleanup();
          const eip = readU32(emulator, HYPERCALL_EXCEPTION_EIP);
          const reg = (name: string) => {
            const address = {
              eax: HYPERCALL_EXCEPTION_EAX,
              ecx: HYPERCALL_EXCEPTION_ECX,
              edx: HYPERCALL_EXCEPTION_EDX,
              ebx: HYPERCALL_EXCEPTION_EBX,
              ebp: HYPERCALL_EXCEPTION_EBP,
              esi: HYPERCALL_EXCEPTION_ESI,
              edi: HYPERCALL_EXCEPTION_EDI,
            }[name]!;
            const value = readU32(emulator, address);
            return `${name}=0x${value.toString(16)}`;
          };
          const ebp = readU32(emulator, HYPERCALL_EXCEPTION_EBP);
          const dumpRange = (address: number, size: number) =>
            `[0x${address.toString(16)}]=` +
            [...emulator.read_memory(address, size)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const ra2Rules = GAME_ID === 'ra2' ? readU32(emulator, 0x0083_9848) : 0;
          const ra2RulesDump = ra2Rules ? ` Rules=0x${ra2Rules.toString(16)} ${dumpRange(ra2Rules + 0x1338, 32)}` : '';
          reject(
            new Error(
              `💥 int3 断点 @0x${eip.toString(16)}（原字节 0x${breakOriginal.toString(16)}） ` +
                `${reg('eax')} ${reg('ecx')} ${reg('edx')} ${reg('ebx')} ${reg('ebp')} ${reg('esi')} ${reg('edi')} ` +
                `calls=${calls}${ra2RulesDump}` +
                `\n[ebp-0x50] ${dumpRange(ebp - 0x50, 16)} [ebp-0x54] ${dumpRange(ebp - 0x54, 16)} [ebp-4] ${dumpRange(ebp - 4, 16)}`,
            ),
          );
          return;
        }
        if (exception) {
          cleanup();
          const eip = readU32(emulator, HYPERCALL_EXCEPTION_EIP);
          const error = readU32(emulator, HYPERCALL_EXCEPTION_ERROR);
          const cs = readU32(emulator, HYPERCALL_EXCEPTION_CS);
          const esp = readU32(emulator, HYPERCALL_EXCEPTION_ESP);
          const eflags = readU32(emulator, HYPERCALL_EXCEPTION_EFLAGS);
          const registers = [
            ['eax', HYPERCALL_EXCEPTION_EAX],
            ['ecx', HYPERCALL_EXCEPTION_ECX],
            ['edx', HYPERCALL_EXCEPTION_EDX],
            ['ebx', HYPERCALL_EXCEPTION_EBX],
            ['ebp', HYPERCALL_EXCEPTION_EBP],
            ['esi', HYPERCALL_EXCEPTION_ESI],
            ['edi', HYPERCALL_EXCEPTION_EDI],
          ]
            .map(([name, address]) => `${name}=0x${readU32(emulator, address as number).toString(16)}`)
            .join(' ');
          const stackBytes = emulator.read_memory(esp, 32);
          const stackDump = [...stackBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          const dump = (address: number) => {
            const bytes = emulator.read_memory(address, 48);
            return (
              `0x${address.toString(16)}=` + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
            );
          };
          const esi = readU32(emulator, HYPERCALL_EXCEPTION_ESI);
          const copyProtectionView = readU32(emulator, 0x851b3c);
          reject(
            new Error(
              `CPU 异常 #${exception - 1}: CS:EIP=0x${cs.toString(16)}:0x${eip.toString(16)} ` +
                `ESP=0x${esp.toString(16)} EFLAGS=0x${eflags.toString(16)} error=0x${error.toString(16)} ` +
                `${registers} stack=${stackDump} calls=${calls} recent=${recentCalls.join(' -> ')}` +
                `\n${dump(eip)}\n${dump(esi)}` +
                `\nAutoDet ${dump(0x851b3c)}${copyProtectionView ? ` view=${dump(copyProtectionView)}` : ''}` +
                `\n栈${dump(esp - 0x40)}\n栈${dump(esp + 0x60)}\nEIP前 ${dump(eip - 0x20)}\nEIP后 ${dump(eip + 0x20)}` +
                `\n最后回调 ${JSON.stringify(shim.inspectCallbackState())}` +
                `\n窗口 ${JSON.stringify(shim.inspectWindowState())}` +
                `\n调用计数 ${[...callCounts.entries()].map(([k, n]) => `${k.split('!')[1]}:${n}`).join(' ')}` +
                `\nEIP轨迹 ${formatEipSamples()}` +
                `\n装载快照 ${[...eipSnapshots.entries()].map(([a, b]) => `0x${a.toString(16)}=${b}`).join(' | ')}` +
                `\n非零区 ${(() => {
                  const found: string[] = [];
                  for (let a = 0x1000000; a < 0x43000000 && found.length < 60; a += 0x100000) {
                    try {
                      const bytes = emulator.read_memory(a, 64);
                      if (bytes.some((b) => b !== 0))
                        found.push(
                          `0x${a.toString(16)}=${[...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
                        );
                    } catch {
                      found.push(`0x${a.toString(16)}=ERR`);
                    }
                  }
                  return found.join(' ');
                })()}` +
                `\n单步 ${stepTrace
                  .slice(-80)
                  .map((address) => `0x${address.toString(16)}`)
                  .join(' ')}`,
            ),
          );
          return;
        }
        const id = readU32(emulator, HYPERCALL_REQUEST);
        if (!id) return;
        const imported = image.importList[id - 1] ?? shim.resolveDynamicImport(id);
        if (!imported) {
          cleanup();
          reject(new Error(`非法 hypercall id ${id}`));
          return;
        }
        const stack = readU32(emulator, HYPERCALL_STACK);
        const args = readStackArgs(emulator, stack, imported.argBytes);
        calls++;
        callCounts.set(imported.key, (callCounts.get(imported.key) ?? 0) + 1);
        if (imported.key === 'KERNEL32.DLL!_lread') {
          const size = args[2] ?? 0;
          fileReadSizes.set(size, (fileReadSizes.get(size) ?? 0) + 1);
        }
        if (imported.key === 'KERNEL32.DLL!RaiseException') {
          const parameterCount = Math.min(args[2] ?? 0, 15);
          const parameters = args[3]
            ? Array.from({ length: parameterCount }, (_, index) => readU32(emulator, args[3]! + index * 4))
            : [];
          console.log(
            `⚠️ RaiseException code=0x${(args[0] ?? 0).toString(16)} flags=0x${(args[1] ?? 0).toString(16)} ` +
              `params=${parameters.map((value) => `0x${value.toString(16)}`).join(',') || '无'}`,
          );
          console.log(`⚠️ RaiseException 前 COM/OLE：${recentComCalls.join(' → ') || '无'}`);
        }
        if (process.env.VM_TRACE_GDI && imported.key === 'GDI32.DLL!TextOutA') {
          const bytes = args[3] && args[4] ? emulator.read_memory(args[3], args[4]) : new Uint8Array();
          const text = new TextDecoder('big5').decode(bytes);
          const dc = shim.inspectGdiDc(args[0] ?? 0);
          console.log(
            `🔤 TextOutA dc=0x${(args[0] ?? 0).toString(16)} surface=0x${(dc?.surface ?? 0).toString(16)} ` +
              `xy=${args[1] ?? 0},${args[2] ?? 0} text=${JSON.stringify(text)} ` +
              `COLORREF=0x${(dc?.textColor ?? 0).toString(16)} index=${dc?.paletteIndex ?? -1} ` +
              `rgb=${dc?.paletteColor.join('/') ?? '-'}`,
          );
        }
        if (process.env.VM_TRACE_CONTROLS === '1') {
          let hwnd = 0;
          let message = 0;
          let wParam = 0;
          let lParam = 0;
          if (imported.key === 'USER32.DLL!SendMessageA') {
            [hwnd, message, wParam, lParam] = args as [number, number, number, number];
          } else if (imported.key === 'USER32.DLL!CallWindowProcA') {
            [, hwnd, message, wParam, lParam] = args as [number, number, number, number, number];
          }
          if (hwnd && message >= 0x0100 && message <= 0x0500 && tracedControlCalls.size < 400) {
            const window = shim.inspectWindowState().find((candidate) => candidate.hwnd === hwnd);
            const line =
              `${imported.key.split('!')[1]} hwnd=0x${hwnd.toString(16)}` +
              ` class=${window?.className || '?'} id=0x${(window?.id ?? 0).toString(16)}` +
              ` msg=0x${message.toString(16)} w=0x${wParam.toString(16)} l=0x${lParam.toString(16)}`;
            if (!tracedControlCalls.has(line)) {
              tracedControlCalls.add(line);
              console.log(`🎛️ ${line}`);
            }
          }
        }
        if (process.env.VM_TRACE_SHOW === '1' && imported.key === 'USER32.DLL!ShowWindow') {
          const hwnd = args[0] ?? 0;
          const window = shim.inspectWindowState().find((candidate) => candidate.hwnd === hwnd);
          const line =
            `hwnd=0x${hwnd.toString(16)} cmd=${args[1] ?? 0}` +
            ` class=${window?.className ?? '?'} id=${window?.id ?? 0}` +
            ` text=${JSON.stringify(window?.text ?? '')} style=0x${(window?.style ?? 0).toString(16)}`;
          if (!tracedShowWindows.has(line)) {
            tracedShowWindows.add(line);
            console.log(`👁️ ShowWindow ${line}`);
          }
        }
        if (process.env.VM_TRACE_FONTS && imported.key === 'GDI32.DLL!CreateFontIndirectA' && args[0]) {
          const logFont = args[0];
          const faceBytes = emulator.read_memory(logFont + 28, 32);
          const end = faceBytes.indexOf(0);
          const face = new TextDecoder('big5').decode(faceBytes.subarray(0, end < 0 ? 32 : end));
          const line =
            `height=${readU32(emulator, logFont) | 0} width=${readU32(emulator, logFont + 4) | 0} ` +
            `weight=${readU32(emulator, logFont + 16) | 0} ` +
            `italic=${emulator.read_memory(logFont + 20, 1)[0] ?? 0} ` +
            `charset=${emulator.read_memory(logFont + 23, 1)[0] ?? 0} ` +
            `quality=${emulator.read_memory(logFont + 26, 1)[0] ?? 0} face=${JSON.stringify(face)}`;
          if (!tracedFonts.has(line)) {
            tracedFonts.add(line);
            console.log(`🔠 LOGFONT ${line}`);
          }
        }
        if (targetCalls && calls >= nextProgressCall) {
          console.log(`⏳ VM 稳定性进度：hypercall ${calls}/${targetCalls}`);
          nextProgressCall += 250_000;
        }
        recentCalls.push(imported.key);
        if (recentCalls.length > 16) recentCalls.shift();
        if (process.env.VM_TRACE && (!traceAfterClick || traceArmed) && calls >= traceAfterCalls) {
          console.log(
            `${calls} ${imported.key}(${args.map((value) => `0x${value.toString(16)}`).join(', ')})` +
              ` tid=${readU32(emulator, 0x0006_0068)} sp=0x${stack.toString(16)}` +
              ` ret=0x${readU32(emulator, stack).toString(16)} pop=${imported.argBytes}` +
              ` lock=${readU32(emulator, 0x0007_3b00 + readU32(emulator, 0x0006_0068) * 4)}`,
          );
          if (imported.key === 'USER32.DLL!RegisterClassA' && args[0]) {
            console.log(
              `  class=${JSON.stringify(readCString(emulator, readU32(emulator, args[0] + 36)))}` +
                ` wndproc=0x${readU32(emulator, args[0] + 4).toString(16)}`,
            );
          }
          if (imported.key === 'USER32.DLL!DispatchMessageA' && args[0]) {
            console.log(
              `  msg=hwnd:0x${readU32(emulator, args[0]).toString(16)}` +
                ` id:0x${readU32(emulator, args[0] + 4).toString(16)}`,
            );
          }
          if (imported.key.endsWith('IDirectDrawSurface.BltFast') && args[4]) {
            console.log(`  srcRect=${readRect(emulator, args[4]).join(',')}`);
          }
          if (imported.key.endsWith('IDirectDrawSurface.Blt')) {
            if (args[1]) console.log(`  destRect=${readRect(emulator, args[1]).join(',')}`);
            if (args[3]) console.log(`  srcRect=${readRect(emulator, args[3]).join(',')}`);
          }
          if (imported.key === 'DDRAW.COM!IDirectDraw.CreateSurface' && args[1]) {
            const desc = args[1];
            console.log(
              `  DDSURFACEDESC size=${readU32(emulator, desc)} flags=0x${readU32(emulator, desc + 4).toString(16)}` +
                ` height=${readU32(emulator, desc + 8)} width=${readU32(emulator, desc + 12)}` +
                ` backBuffers=${readU32(emulator, desc + 20)} caps=0x${readU32(emulator, desc + 104).toString(16)}`,
            );
          }
        }
        if (imported.key === 'KERNEL32.DLL!FindFirstFileA' && args[0]) {
          console.log(
            `🔎 FindFirstFileA pattern=${JSON.stringify(readCString(emulator, args[0]))}` +
              ` buffer=0x${(args[1] ?? 0).toString(16)}`,
          );
        }
        if (imported.key === 'KERNEL32.DLL!CreateFileA' && args[0]) {
          const tid = readU32(emulator, 0x0006_0068);
          syncOps.fileOpenByThread.set(tid, (syncOps.fileOpenByThread.get(tid) ?? 0) + 1);
          if (process.env.VM_TRACE_OPEN === '1') {
            console.log(
              `🔎 CreateFileA tid=${tid} path=${JSON.stringify(readCString(emulator, args[0]))} disp=${args[4] ?? '?'}`,
            );
          }
        }
        if (imported.key === 'KERNEL32.DLL!CreateEventA') syncOps.createEvent++;
        if (imported.key === 'KERNEL32.DLL!SetEvent') syncOps.setEvent++;
        if (imported.key === 'KERNEL32.DLL!ResetEvent') syncOps.resetEvent++;
        if (imported.key === 'KERNEL32.DLL!CreateThread') syncOps.createThread++;
        if (imported.key === 'KERNEL32.DLL!WaitForMultipleObjects') syncOps.waitMulti++;
        if (imported.key === 'KERNEL32.DLL!WaitForSingleObject') {
          const h = args[0] ?? 0;
          if (h === 0x10020) syncOps.waitMutex++;
          else if (h === 0x10021) syncOps.waitEvent++;
          else syncOps.waitOther++;
        }
        if (imported.key === 'USER32.DLL!PostMessageA') syncOps.postMessage++;
        if (imported.key === 'USER32.DLL!SendMessageA') syncOps.sendMessage++;
        if (imported.key === 'USER32.DLL!PostThreadMessageA') syncOps.postThread++;
        if (imported.key === 'KERNEL32.DLL!CreateProcessA') {
          console.log(
            `🔎 CreateProcessA app=${JSON.stringify(readCString(emulator, args[0] ?? 0))}` +
              ` cmd=${JSON.stringify(readCString(emulator, args[1] ?? 0))}`,
          );
        }
        if (
          process.env.VM_TRACE_WGEOM &&
          (imported.key === 'USER32.DLL!MoveWindow' || imported.key === 'USER32.DLL!SetWindowPos')
        ) {
          const isMove = imported.key.endsWith('MoveWindow');
          const rectArgs = isMove ? args.slice(1, 5) : args.slice(2, 6);
          console.log(
            `📐 ${imported.key.split('!')[1]} hwnd=0x${(args[0] ?? 0).toString(16)}` +
              ` xywh=${rectArgs.map((value) => value | 0).join(',')}${isMove ? '' : ` flags=0x${(args[6] ?? 0).toString(16)}`}`,
          );
        }
        if (
          process.env.VM_TRACE_DIALOG &&
          (imported.key === 'USER32.DLL!DialogBoxIndirectParamA' ||
            imported.key === 'USER32.DLL!DialogBoxParamA' ||
            imported.key === 'USER32.DLL!CreateDialogIndirectParamA' ||
            imported.key === 'USER32.DLL!CreateDialogParamA')
        ) {
          console.log(
            `🧩 ${imported.key}(template=0x${(args[1] ?? 0).toString(16)},` +
              ` parent=0x${(args[2] ?? 0).toString(16)}, dlgproc=0x${(args[3] ?? 0).toString(16)})` +
              ` 调用自=0x${readU32(emulator, stack).toString(16)}`,
          );
          // CreateDialogParamA args[1] is a resource name, not a template pointer; dump only Indirect variants.
          if (imported.key.includes('Indirect')) {
            dumpDialogTemplate(emulator, args[1] ?? 0);
          }
          if (process.env.VM_TRACE_DIALOG === '2') {
            const raw = emulator.read_memory(args[1] ?? 0, 400);
            console.log(
              `🧩 模板原始字节 @0x${(args[1] ?? 0).toString(16)}: ` +
                [...raw].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
            );
            if (args[3]) {
              const code = emulator.read_memory(args[3], 512);
              console.log(
                `🧩 dlgproc@0x${args[3].toString(16)}: ` +
                  [...code].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
              );
            }
            const callSite = readU32(emulator, stack) - 64;
            const callerBytes = emulator.read_memory(callSite, 192);
            console.log(
              `🧩 调用点前 64B @0x${callSite.toString(16)}: ` +
                [...callerBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
            );
          }
        }
        if (process.env.VM_TRACE_DDRAW && imported.key.startsWith('DDRAW.COM!IDirectDrawSurface.')) {
          let detail = '';
          const surfacePrefix = `surface=0x${(args[0] ?? 0).toString(16)} `;
          if (imported.key.endsWith('.SetColorKey')) {
            detail =
              surfacePrefix +
              `flags=0x${(args[1] ?? 0).toString(16)} key=${
                args[2] ? `${readU32(emulator, args[2])}..${readU32(emulator, args[2] + 4)}` : 'null'
              }`;
          } else if (imported.key.endsWith('.Blt')) {
            const effects = args[5] ?? 0;
            detail =
              surfacePrefix +
              `flags=0x${(args[4] ?? 0).toString(16)} source=0x${(args[2] ?? 0).toString(16)}` +
              ` dst=${args[1] ? readRect(emulator, args[1]).join(',') : 'full'}` +
              ` src=${args[3] ? readRect(emulator, args[3]).join(',') : 'full'}` +
              (effects
                ? ` fxSize=${readU32(emulator, effects)} fill76=${readU32(emulator, effects + 76)}` +
                  ` fill80=${readU32(emulator, effects + 80)} fill84=${readU32(emulator, effects + 84)}`
                : ' fx=null');
          } else if (imported.key.endsWith('.BltFast')) {
            detail =
              surfacePrefix +
              `flags=0x${(args[5] ?? 0).toString(16)} source=0x${(args[3] ?? 0).toString(16)}` +
              ` dst=${args[1] ?? 0},${args[2] ?? 0}` +
              ` src=${args[4] ? readRect(emulator, args[4]).join(',') : 'full'}`;
          } else if (imported.key.endsWith('.Lock')) {
            detail =
              surfacePrefix +
              `rect=${args[1] ? readRect(emulator, args[1]).join(',') : 'full'}` +
              ` desc=0x${(args[2] ?? 0).toString(16)} flags=0x${(args[3] ?? 0).toString(16)}`;
          }
          if (detail) {
            const line = `${imported.key} ${detail}`;
            if (!tracedDirectDraw.has(line) && tracedDirectDraw.size < 240) {
              tracedDirectDraw.add(line);
              console.log(`🔎 ${line}`);
            }
          }
        }
        if (process.env.VM_TRACE_DDRAW && imported.key === 'DDRAW.COM!IDirectDraw.CreatePalette') {
          console.log(
            `🔎 ${imported.key} flags=0x${(args[1] ?? 0).toString(16)} entries=0x${(args[2] ?? 0).toString(16)}`,
          );
        }
        if (process.env.VM_TRACE_DDRAW && imported.key === 'DDRAW.COM!IDirectDraw.CreateSurface' && args[1]) {
          const desc = args[1];
          console.log(
            `🔎 ${imported.key} flags=0x${readU32(emulator, desc + 4).toString(16)}` +
              ` size=${readU32(emulator, desc + 12)}x${readU32(emulator, desc + 8)}` +
              ` pitch=${readU32(emulator, desc + 16)} back=${readU32(emulator, desc + 20)}` +
              ` bpp=${readU32(emulator, desc + 84)} caps=0x${readU32(emulator, desc + 104).toString(16)}`,
          );
        }
        if (!first) first = imported.key;
        // Support both blocking GetMessageA and RA2's PeekMessageA pump with its own ticker.
        if (imported.key === 'USER32.DLL!GetMessageA' || imported.key === 'USER32.DLL!PeekMessageA') {
          if (!reachedMainLoop) mainLoopMs = performance.now() - profileT0;
          reachedMainLoop = true;
          const [currentX, currentY] = inputPoints[inputIndex]!;
          const pointHoverOnly = hoverOnly || (finalHoverOnly && inputIndex === inputPoints.length - 1);
          const point = (currentY << 16) | currentX;
          const drag = options.dragTargets?.[inputIndex];
          const releasePoint = drag ? (drag[1] << 16) | drag[0] : point;
          const shellPageTitle = shim.inspectShellPageTitle().toLowerCase();
          const expectedPageTitle = clickPageTitles[inputIndex] ?? '';
          // RA2 enters PeekMessage early, so a running message pump does not imply menu readiness.
          // Inject the first click only after the GUI:MainMenu title control is actually created from the dialog template.
          // Main-menu buttons then exist too, allowing hit testing to find a Button rather than the top-level window.
          const ra2FirstMenuReady =
            GAME_ID !== 'ra2' || inputIndex > 0 || shellPageTitle.includes(expectedPageTitle || 'mainmenu');
          const expectedShellPageReady =
            GAME_ID !== 'ra2' || !expectedPageTitle || shellPageTitle.includes(expectedPageTitle);
          if (inputPhase === 0 && clickGap > 0) {
            clickGap--;
          } else if (inputPhase === 0 && Date.now() < firstClickAfter) {
            // Wall-clock gate: do not click during the startup cutscene.
          } else if (
            inputPhase === 0 &&
            ra2FirstMenuReady &&
            expectedShellPageReady &&
            ((GAME_ID !== 'ra2' && inputIndex === inputPoints.length - 1) ||
              ((readU32(emulator, 0x004a_c0a8) & 0xff) === 6 && readU32(emulator, 0x004a_84f4) > 0) ||
              !waitMenuReady ||
              readU32(emulator, 0x004a_f1a4) >= 25)
          ) {
            // Pre-click frame dump for screen-transition detection (title -> menu, etc.) and comparison with the final frame.
            if (process.env.VM_FRAME_PPM_BEFORE && inputIndex === 0 && lastFrame) {
              writePpm(process.env.VM_FRAME_PPM_BEFORE, lastFrame);
            }
            shim.setCursorPosition(currentX, currentY);
            shim.postMessage(0x0200, 0, point); // WM_MOUSEMOVE
            if (batchPointerClick && !pointHoverOnly && !drag) {
              // Browsers do not wait for WndProc to return before producing pointerup. The original game may enter a
              // modal message pump inside WM_LBUTTONDOWN, so enqueue the release in advance.
              // VM_STEP_ON_CLICK: enable TF before the final click's press to capture menu-action handling.
              if (process.env.VM_STEP_ON_CLICK === '1' && inputIndex === inputPoints.length - 1 && !stepTraceMode) {
                stepTraceMode = true;
                writeU32(emulator, 0x60050, 1);
              }
              shim.setKeyState(0x01, true);
              shim.postMessage(0x0201, 0x0001, point); // WM_LBUTTONDOWN
              shim.setKeyState(0x01, false);
              shim.postMessage(0x0202, 0, point); // WM_LBUTTONUP
              inputPhase = 3;
            } else {
              inputPhase = 1;
            }
          } else if (
            inputPhase === 1 &&
            pointHoverOnly &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 1 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 1)
          ) {
            if ((!targetCalls || calls >= targetCalls) && settleMessages-- <= 0) {
              cleanup();
              done();
              return;
            }
          } else if (
            inputPhase === 1 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 1 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 1)
          ) {
            shim.setKeyState(0x01, true);
            shim.postMessage(0x0201, 0x0001, point); // WM_LBUTTONDOWN
            if (traceAfterClick && inputIndex === inputPoints.length - 1) {
              traceArmed = true;
              console.log(`🔭 追踪窗口开启 @calls=${calls} point=${point}`);
            }
            inputPhase = 2;
          } else if (
            inputPhase === 2 &&
            drag &&
            !dragPosted &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 2 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 2)
          ) {
            shim.setCursorPosition(drag[0], drag[1]);
            shim.postMessage(0x0200, 1, releasePoint);
            dragPosted = true;
          } else if (
            inputPhase === 2 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + (drag ? 3 : 2) ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + (drag ? 3 : 2))
          ) {
            shim.setKeyState(0x01, false);
            // Closing a popup on press consumes the release; that input is complete and must not wait for another guest dispatch.
            if (shim.postMessage(0x0202, 0, releasePoint) === false) dispatchedInput.push(0x0202);
            inputPhase = 3;
          } else if (
            inputPhase === 3 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + (drag ? 4 : 3) ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + (drag ? 4 : 3))
          ) {
            if (inputIndex + 1 < inputPoints.length) {
              inputIndex++;
              dragPosted = false;
              inputPhase = 0;
              clickGap = clickGaps[inputIndex] ?? clickGapMessages;
            } else if (keyIndex < keySequence.length) {
              // After the click route finishes, inject keys in sequence (VM_KEYS is a list of VK codes).
              inputPhase = 4;
            } else if ((!targetCalls || calls >= targetCalls) && settleMessages-- <= 0) {
              cleanup();
              done();
              return;
            }
          } else if (inputPhase === 4 && calls >= keysAfterCalls) {
            // Key injection sends DOWN/CHAR/UP only once each; several GetMessageA ticks may occur before observed dispatch,
            // so unguarded injection would queue duplicates. Add WM_CHAR for printable ASCII keys because game text fields
            // may consume only TranslateMessage output; real key CHAR messages are generated by TranslateMessage in the loop.
            const vk = keySequence[keyIndex]!;
            const printable = vk >= 0x20 && vk <= 0x7e;
            const lastDispatched = dispatchedKey.at(-1);
            if (lastDispatched === 0x0100) {
              if (printable && !charPosted) {
                shim.postMessage(0x0102, vk, 0x001c_0001); // WM_CHAR
                charPosted = true;
              } else if (!keyUpPosted) {
                shim.postMessage(0x0101, 0, 0xc000_0001); // WM_KEYUP
                keyUpPosted = true;
              }
            } else if (lastDispatched === 0x0102) {
              if (!keyUpPosted) {
                shim.postMessage(0x0101, 0, 0xc000_0001); // WM_KEYUP
                keyUpPosted = true;
              }
            } else if (!keyDownPosted) {
              shim.postMessage(0x0100, vk, 0x001c_0001); // WM_KEYDOWN
              keyDownPosted = true;
            }
            if (dispatchedKey.length >= 2 && dispatchedKey.at(-1) === 0x0101) {
              dispatchedKey.length = 0;
              keyIndex++;
              inputPhase = 3;
              keyDownPosted = false;
              keyUpPosted = false;
              charPosted = false;
            }
          }
        }
        if (imported.key === 'USER32.DLL!DispatchMessageA' && args[0]) {
          const message = readU32(emulator, args[0] + 4);
          if (message >= 0x0200 && message <= 0x0202) dispatchedInput.push(message);
          if (message === 0x0100 || message === 0x0101 || message === 0x0102) dispatchedKey.push(message);
        }
        if (
          (imported.key === 'KERNEL32.DLL!CreateFileA' ||
            imported.key === 'KERNEL32.DLL!_lopen' ||
            imported.key === 'KERNEL32.DLL!LoadLibraryA' ||
            imported.key === 'WINMM.DLL!mmioOpenA') &&
          args[0]
        ) {
          const guestPath = readCString(emulator, args[0]);
          if (process.env.VM_TRACE) console.log(`  file=${JSON.stringify(guestPath)}`);
          const mountT0 = process.env.VM_PROFILE ? performance.now() : 0;
          const normalizedGuestPath = normalizeGuestPath(guestPath);
          const sparsePrefix = Object.entries(GAME.sparseFilePrefixes ?? {}).find(([path]) => {
            const candidate = normalizeGuestPath(path);
            return normalizedGuestPath === candidate || normalizedGuestPath.endsWith(`/${candidate}`);
          })?.[1];
          const hostPath = resolveGuestFile(GAME_DIR, guestPath);
          const immutableArchive = /\.(?:mix|bag)$/i.test(normalizedGuestPath);
          const sessionIni =
            options.ini && normalizedGuestPath.split(/[\\/]/).at(-1) === sessionIniName(GAME_ID).toLowerCase();
          if (sessionIni) {
            // Same remount-per-open semantics as other loose files, with the overlay applied to the installed bytes.
            shim.mountFile(
              guestPath,
              patchSessionIni(hostPath ? bytesOf(hostPath) : new Uint8Array(), options.ini!),
              true,
            );
          } else if (hostPath && !(immutableArchive && shim.hasMountedFile(guestPath))) {
            if (sparsePrefix) {
              const sparse = bytesPrefix(hostPath, sparsePrefix);
              shim.mountFile(guestPath, sparse.bytes, true, sparse.totalSize);
            } else {
              // The harness has no other consumer for this freshly-read buffer.
              // Keeping a second canonical copy here can push long campaign smokes
              // over the worker RSS limit while RA2.MIX is copied into guest RAM.
              shim.mountFile(guestPath, bytesOf(hostPath), true);
            }
          }
          if (process.env.VM_PROFILE) {
            fileMountMs += performance.now() - mountT0;
            fileMountCount++;
          }
        }
        // Equivalent to VmCore's asynchronous provider-enumeration bridge; stat only matches without pre-reading MIX contents.
        if (imported.key === 'KERNEL32.DLL!FindFirstFileA' && args[0] && args[1]) {
          const pattern = readCString(emulator, args[0]);
          const search = guestFileSearch(pattern);
          let directory = GAME_DIR;
          for (const part of search.directory.split('/').filter(Boolean)) {
            const actual =
              existsSync(directory) && statSync(directory).isDirectory()
                ? readdirSync(directory).find((name) => name.toLowerCase() === part)
                : undefined;
            directory = join(directory, actual ?? part);
          }
          const entries =
            existsSync(directory) && statSync(directory).isDirectory()
              ? readdirSync(directory)
                  .filter(search.matches)
                  .map((name) => {
                    const stat = statSync(join(directory, name));
                    return {
                      path: search.directory ? `${search.directory}/${name}` : name,
                      size: stat.isDirectory() ? 0 : stat.size,
                      directory: stat.isDirectory(),
                    };
                  })
              : [];
          shim.setFileSearchResults(pattern, entries);
        }
        const dispatchT0 = process.env.VM_PROFILE ? performance.now() : 0;
        const result = shim.dispatch({ imported, stack, args });
        if (process.env.VM_PROFILE) {
          const elapsed = performance.now() - dispatchT0;
          dispatchTotalMs += elapsed;
          callTimes.set(imported.key, (callTimes.get(imported.key) ?? 0) + elapsed);
          if (elapsed > (callMaxTimes.get(imported.key) ?? 0)) callMaxTimes.set(imported.key, elapsed);
        }
        if (
          process.env.VM_TRACE_OPEN === '1' &&
          (imported.key === 'KERNEL32.DLL!CreateFileA' || imported.key === 'KERNEL32.DLL!_lopen') &&
          args[0]
        ) {
          console.log(`📂 ${readCString(emulator, args[0])} => 0x${(result?.eax ?? 0).toString(16)}`);
        }
        if (process.env.VM_TRACE_OPEN === '1' && imported.key.startsWith('BINKW32.DLL!')) {
          console.log(
            `🎞️ ${imported.key}(${args.map((v) => '0x' + (v ?? 0).toString(16)).join(',')}) => 0x${(result?.eax ?? 0).toString(16)}`,
          );
        }
        if (
          process.env.VM_TRACE_MESSAGES === '1' &&
          (imported.key === 'USER32.DLL!PeekMessageA' ||
            imported.key === 'USER32.DLL!GetMessageA' ||
            imported.key === 'USER32.DLL!DispatchMessageA')
        ) {
          const messagePtr = args[0] ?? 0;
          if (messagePtr && result?.eax) {
            console.log(
              `📨 #${calls} ${imported.key.split('!')[1]} remove=${args[4] ?? '-'} ` +
                `hwnd=0x${readU32(emulator, messagePtr).toString(16)} ` +
                `msg=0x${readU32(emulator, messagePtr + 4).toString(16)} ` +
                `w=0x${readU32(emulator, messagePtr + 8).toString(16)} ` +
                `l=0x${readU32(emulator, messagePtr + 12).toString(16)}`,
            );
          }
        }
        if (process.env.VM_DEBUG_MAP && inputIndex >= 3 && imported.key.startsWith('USER32.')) {
          const isCallProc = imported.name === 'CallWindowProcA';
          const hwnd = args[isCallProc ? 1 : 0] ?? 0;
          const state = shim as unknown as { controlIds: Map<number, number> };
          if (
            !['PeekMessageA', 'GetMessageA', 'GetCursorPos', 'GetKeyState', 'GetAsyncKeyState'].includes(imported.name)
          ) {
            mapTrace.push({
              inputIndex,
              key: imported.name,
              args,
              result: result?.eax,
              id: state.controlIds.get(hwnd),
              depth: readU32(emulator, HYPERCALL_CALLBACK_DEPTH),
              caller: readU32(emulator, stack),
              scrollInfo:
                isCallProc && [0xe9, 0xea].includes(args[2]!) && args[4]
                  ? Array.from(new Uint32Array(emulator.read_memory(args[4], 28).slice().buffer))
                  : undefined,
              msg: imported.name === 'DispatchMessageA' ? Array.from(emulator.read_memory(args[0]!, 16)) : undefined,
            });
          }
        }
        if (process.env.VM_TRACE_GEOMETRY === '1') {
          const hwnd = args[0] ?? 0;
          const window = hwnd ? shim.inspectWindowState().find((candidate) => candidate.hwnd === hwnd) : undefined;
          if (
            window &&
            (window.className === 'Button' || window.className === 'Static' || window.className === '#32770')
          ) {
            let detail = '';
            if (
              (imported.key === 'USER32.DLL!GetWindowRect' || imported.key === 'USER32.DLL!GetClientRect') &&
              args[1]
            ) {
              detail = ` out=${readRect(emulator, args[1]).join(',')}`;
            } else if (
              (imported.key === 'USER32.DLL!ClientToScreen' || imported.key === 'USER32.DLL!ScreenToClient') &&
              args[1]
            ) {
              detail = ` point=${readU32(emulator, args[1]) | 0},${readU32(emulator, args[1] + 4) | 0}`;
            }
            if (detail)
              console.log(`📐 ${imported.key.split('!')[1]} hwnd=0x${hwnd.toString(16)} id=${window.id}${detail}`);
            if (imported.key === 'USER32.DLL!MoveWindow') {
              console.log(
                `📐 MoveWindow hwnd=0x${hwnd.toString(16)} id=${window.id} ` +
                  `rect=${(args[1] ?? 0) | 0},${(args[2] ?? 0) | 0},${(args[3] ?? 0) | 0},${(args[4] ?? 0) | 0} repaint=${args[5] ?? 0}`,
              );
            } else if (imported.key === 'USER32.DLL!SetWindowPos') {
              console.log(
                `📐 SetWindowPos hwnd=0x${hwnd.toString(16)} id=${window.id} ` +
                  `rect=${(args[2] ?? 0) | 0},${(args[3] ?? 0) | 0},${(args[4] ?? 0) | 0},${(args[5] ?? 0) | 0} ` +
                  `flags=0x${(args[6] ?? 0).toString(16)}`,
              );
            }
          }
        }
        if (imported.key === 'USER32.DLL!CallWindowProcA' && (args[0] ?? 0) === 0 && result) {
          const hwnd = args[1] ?? 0;
          const message = args[2] ?? 0;
          const window =
            process.env.VM_TRACE_CONTROL_SUMMARY === '1'
              ? shim.inspectWindowState().find((candidate) => candidate.hwnd === hwnd)
              : undefined;
          if (window) {
            const key = `${window.className.toLowerCase()}:0x${message.toString(16)}`;
            const previous = defaultControlMessages.get(key);
            defaultControlMessages.set(key, {
              count: (previous?.count ?? 0) + 1,
              result: result.eax >>> 0,
              wParam: args[3] ?? 0,
              lParam: args[4] ?? 0,
            });
          }
        }
        if (imported.key.startsWith('OLE32.DLL!') || imported.key.startsWith('OLEAUT32.DLL!')) {
          recentComCalls.push(
            `${imported.key}(${args.map((value) => `0x${value.toString(16)}`).join(',')})` +
              `=>${result ? `0x${(result.eax >>> 0).toString(16)}` : 'blocked'}`,
          );
          if (recentComCalls.length > 32) recentComCalls.shift();
        }
        if (imported.key.startsWith('BINKW32.DLL!')) {
          recentBinkCalls.push(
            `${imported.key}(${args.map((value) => `0x${value.toString(16)}`).join(',')})` +
              `=>${result ? `0x${(result.eax >>> 0).toString(16)}` : 'blocked'}` +
              `@0x${readU32(emulator, stack).toString(16)}`,
          );
          if (recentBinkCalls.length > 20) recentBinkCalls.shift();
        }
        if (process.env.VM_TRACE && imported.key === 'DDRAW.COM!IDirectDraw.CreateSurface' && args[2]) {
          console.log(`  surfaceOut=0x${readU32(emulator, args[2]).toString(16)}`);
        }
        if (!result) {
          blocked = imported.key;
          cleanup();
          done();
          return;
        }
        const threadDelay = shim.prepareGuestThreadReturn({ imported, args }, result);
        const release = () => {
          waiting = false;
          if (stepAfter > 0 && calls >= stepAfter && !stepTraceMode) {
            stepTraceMode = true;
            // Guest-side injection: boot's IRQ handler sets TF in the iret frame when 0x60050 is set.
            writeU32(emulator, 0x60050, 1);
          }
          if (process.env.VM_BREAK_AT) {
            const breakAt = Number(process.env.VM_BREAK_AT) | 0;
            const breakAfter = Number(process.env.VM_BREAK_AFTER ?? 0) | 0;
            // The guest may rewrite the target region at runtime, overwriting an early 0xCC.
            // VM_BREAK_AFTER installs the breakpoint only after API call N.
            if (breakAt && calls >= breakAfter && breakOriginal === undefined) {
              breakOriginal = emulator.read_memory(breakAt, 1)[0]!;
              emulator.write_memory([0xcc], breakAt); // int3
            }
          }
          if (process.env.VM_STACK_WATCH) {
            // Watch 16 bytes from the specified trampoline address to identify the API boundary where a write occurs.
            const watchAddr = Number(process.env.VM_STACK_WATCH_ADDR ?? 0x6ffbc0) | 0;
            const bytes = emulator.read_memory(watchAddr, 16);
            const nonzero = bytes.some((byte) => byte !== 0);
            if (nonzero && !stackWatchSeen) {
              stackWatchSeen = true;
              console.log(
                `🧱 跳板区写入 #${calls} ${imported.key}：` +
                  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') +
                  ` esp=0x${readU32(emulator, HYPERCALL_STACK).toString(16)}`,
              );
            }
          }
          // Network-pump injection: when the queue is nonempty, use this hypercall's return path to run the pump once on the main thread
          writeU32(emulator, HYPERCALL_EAX, result.eax);
          writeU32(emulator, HYPERCALL_EDX, result.edx ?? 0);
          writeU32(emulator, HYPERCALL_REQUEST, 0);
          emulator.serial0_send('\0');
          // VM_TARGET_CALLS is the stability observation boundary. After asset loading, RA2's main ticker need not call
          // PeekMessage again, so completion checks cannot depend solely on the next message API.
          const inputRoundTripComplete =
            dispatchedInput.length >= expectedInputDispatches ||
            shim.getHostInputDispatchCount() >= expectedInputDispatches;
          if (
            targetCalls &&
            calls >= targetCalls &&
            (options.completeAtTargetCalls || (inputPhase === 3 && inputRoundTripComplete))
          ) {
            cleanup();
            done();
          }
        };
        if (result.exit) {
          exitSeen = true;
          stats.exitCode = result.eax;
          release();
          cleanup();
          done();
          return;
        }
        if (threadDelay) {
          waiting = true;
          // Match vmCore: keep waiting while no thread is runnable; a single delay must not let a thread return from
          // EnterCriticalSection before acquiring the lock.
          const resume = () => {
            if (stopped) return;
            try {
              const completion = shim.completeGuestThreadDelay();
              if (completion.result !== undefined) result.eax = completion.result;
              if (completion.delayMs) delayTimer = setTimeout(resume, completion.delayMs);
              else release();
            } catch (error) {
              cleanup();
              reject(error);
            }
          };
          delayTimer = setTimeout(resume, threadDelay);
        } else {
          release();
        }
      }
      emulator.add_listener('serial0-output-byte', notify);
      poll = setInterval(service, 50);
    });
    await emulator.run();
    await completion;

    if (emulator.is_running()) await emulator.stop();
    return {
      ...stats,
      frames,
      frameBytes,
      lastFrameSize,
      // lastFrame is assigned only inside the onFrame closure, so TS narrows the return point to null;
      // explicitly restore its declared type (type-only correction; runtime behavior is unchanged).
      lastFrame: lastFrame as VmFrame | null,
      calls,
      first,
      blocked,
      reachedMainLoop,
      exited: exitSeen,
      dispatchedInput,
      callCounts,
      fileReadSizes,
      callTimes,
      callMaxTimes,
      dispatchTotalMs,
      fileMountMs,
      fileMountCount,
      firstFrameMs,
      mainLoopMs,
      profileT0,
      emulator,
      shim,
      dpSeen,
      stepTrace,
      recentBinkCalls,
      defaultControlMessages,
      mapTrace,
    };
  }

  const final = await runPass();
  const {
    emulator,
    shim,
    frames,
    frameBytes,
    lastFrameSize,
    lastFrame,
    calls,
    first,
    blocked,
    reachedMainLoop,
    exited,
    dispatchedInput,
    callCounts,
    fileReadSizes,
    dpSeen,
    stepTrace,
    recentBinkCalls,
    defaultControlMessages,
    callTimes,
    callMaxTimes,
    dispatchTotalMs,
    fileMountMs,
    fileMountCount,
    firstFrameMs,
    mainLoopMs,
    profileT0,
  } = final;

  // Each game's CRT begins with a different API; the registry's smokeFirstCall supplies the expected value.
  if (GAME.smokeFirstCall && first !== GAME.smokeFirstCall) {
    throw new Error(`首个 API 异常: ${first}`);
  }
  const stableTargetReached = !!options.completeAtTargetCalls && !!targetCalls && calls >= targetCalls;
  if (((!reachedMainLoop && !stableTargetReached) || blocked) && !exited) {
    throw new Error(`主消息循环未到达: blocked=${blocked}，calls=${calls}`);
  }
  if (exited) {
    if (process.env.VM_FRAME_PPM && lastFrame) writePpm(process.env.VM_FRAME_PPM, lastFrame);
    if (stepTrace.length) {
      console.log(
        `👣 退出前单步（前 160）: ${stepTrace
          .slice(0, 160)
          .map((a) => `0x${a.toString(16)}`)
          .join(' ')}`,
      );
      console.log(
        `👣 退出前单步（后 160）: ${stepTrace
          .slice(-160)
          .map((a) => `0x${a.toString(16)}`)
          .join(' ')}`,
      );
    }
    throw new Error(`游戏在主循环前自行退出: ExitProcess code=0x${final.exitCode.toString(16)}，calls=${calls}`);
  }
  const minimumCalls = GAME_ID === 'ra2' || GAME_ID === 'yr' ? 4_000 : 10_000;
  if (calls < minimumCalls) throw new Error(`WinMain 调用轨迹过短: ${calls}`);
  // RA2/YR use the INI video mode directly; an e2e workspace may configure 1440x900 or another size,
  // provided a real primary frame is produced. Other legacy games still require 800x600.
  const fixedFrameSize = GAME_ID !== 'ra2' && GAME_ID !== 'yr';
  if (!options.skipFrameCheck && (!frames || (fixedFrameSize && lastFrameSize !== '800x600'))) {
    throw new Error(`DirectDraw 主表面未输出: frames=${frames}, size=${lastFrameSize}`);
  }
  const expectedInput = inputPoints
    .flatMap((_point, index) =>
      hoverOnly || (finalHoverOnly && index === inputPoints.length - 1)
        ? [0x0200]
        : options.dragTargets?.[index]
          ? [0x0200, 0x0201, 0x0200, 0x0202]
          : [0x0200, 0x0201, 0x0202],
    )
    .join(',');
  // Key routes or discovery rounds (VM_DP_PROBE) may enter a modal pump and redispatch queued mouse
  // messages, so do not assert round-trip counts.
  const expectedHostDispatches = expectedInputDispatches;
  const synchronouslyDispatched = shim.getHostInputDispatchCount() >= expectedHostDispatches;
  if (
    !options.completeAtTargetCalls &&
    !keySequence.length &&
    !process.env.VM_DP_PROBE &&
    dispatchedInput.join(',') !== expectedInput &&
    !synchronouslyDispatched
  ) {
    throw new Error(
      `鼠标消息未经原版 WndProc 完整往返: ${dispatchedInput.join(',') || '无'}，同步=${shim.getHostInputDispatchCount()}`,
    );
  }
  if (process.env.VM_DEBUG_MAP)
    writeFileSync(
      process.env.VM_DEBUG_MAP,
      JSON.stringify({
        trace: final.mapTrace,
        windows: shim.inspectWindowState(),
        controls: shim.inspectControlItems(),
      }),
    );
  // Write the final frame first so the post-click UI survives a later probe exception.
  if (process.env.VM_FRAME_PPM && lastFrame) writePpm(process.env.VM_FRAME_PPM, lastFrame);
  options.assertFinalState?.(shim, emulator);
  if (options.assertFinalFrame) {
    if (!lastFrame) throw new Error('没有可验证的最终画面');
    options.assertFinalFrame(lastFrame);
  }
  // VM_FRAME_RAW: persist the raw 8-bit indexed surface and palette (rerender Graphics.dat bitmaps with the current palette).
  if (process.env.VM_FRAME_RAW && lastFrame) {
    writeFileSync(process.env.VM_FRAME_RAW, Buffer.from(lastFrame.pixels));
    writeFileSync(`${process.env.VM_FRAME_RAW}.pal`, Buffer.from(lastFrame.palette));
    console.log(`💾 原始索引帧 ${lastFrame.width}×${lastFrame.height} → ${process.env.VM_FRAME_RAW}`);
  }
  // VM_MEM_SNAP: persist a guest RAM snapshot for memory diffs that locate screen-state variables.
  if (process.env.VM_MEM_SNAP) {
    const from = Number(process.env.VM_MEM_SNAP_FROM ?? 0x400000);
    const to = Number(process.env.VM_MEM_SNAP_TO ?? 0x5000000);
    const buf = emulator.read_memory(from, to - from);
    writeFileSync(process.env.VM_MEM_SNAP, Buffer.from(buf));
    console.log(`💾 客体内存快照 0x${from.toString(16)}..0x${to.toString(16)} → ${process.env.VM_MEM_SNAP}`);
  }
  // VM_CSF_SCAN: scan guest memory for decoded game strings (comma-separated ASCII/UTF-16 keywords)
  // and raw CSF caches (" LBL" headers) to identify the byte sources of flag-row strings.
  if (process.env.VM_CSF_SCAN) {
    const heap = shim.inspectHeapState();
    const from = 0x400000;
    const to =
      Math.min(Number(process.env.VM_CSF_SCAN_TO ?? 0), 0x10000000) || Math.max(heap.peakAddress + 0x100000, 0x3000000);
    const chunk = 4 * 1024 * 1024;
    const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = (bytes: Uint8Array): string =>
      [...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    console.log(
      `🔎 CSF 扫描 0x${from.toString(16)}..0x${to.toString(16)}（堆峰值 0x${heap.peakAddress.toString(16)}）`,
    );
    const needles = process.env.VM_CSF_SCAN.split(',').flatMap(
      (text) =>
        [
          { label: `${text}/ANSI`, bytes: [...Buffer.from(text, 'latin1')] },
          { label: `${text}/UTF16`, bytes: [...Buffer.from(text, 'latin1')].flatMap((b) => [b, 0]) },
        ] as const,
    );
    const show = (addr: number, size: number, label: string): void => {
      const bytes = emulator.read_memory(addr, size);
      console.log(`🎯 ${label} @0x${addr.toString(16)}: ${hex(bytes)}\n   ${ascii(bytes)}`);
    };
    for (const pattern of needles) {
      let hits = 0;
      for (let addr = from; addr < to - pattern.bytes.length && hits < 12; addr += chunk) {
        const buf = emulator.read_memory(addr, Math.min(chunk, to - addr));
        for (let i = 0; i <= buf.length - pattern.bytes.length && hits < 12; i++) {
          if (!pattern.bytes.every((b, k) => buf[i + k] === b)) continue;
          hits++;
          show(Math.max(from, addr + i - 40), 96, pattern.label);
        }
      }
      console.log(`🔎 ${pattern.label} 命中 ${hits}`);
    }
    // Raw CSF entry header " LBL": parse and print the label/string in place; the game may cache the
    // unpacked ra2.csf buffer.
    let lblHits = 0;
    for (let addr = from; addr < to - 4 && lblHits < 12; addr += chunk) {
      const buf = emulator.read_memory(addr, Math.min(chunk, to - addr));
      for (let i = 0; i <= buf.length - 4 && lblHits < 12; i++) {
        if (buf[i] !== 0x20 || buf[i + 1] !== 0x4c || buf[i + 2] !== 0x42 || buf[i + 3] !== 0x4c) continue;
        const head = emulator.read_memory(addr + i, 256);
        const u32 = (at: number): number =>
          (head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16) | (head[at + 3]! << 24)) >>> 0;
        const labelLen = u32(4);
        const rtsAt = 8 + labelLen;
        if (labelLen > 120 || rtsAt + 8 > head.length) continue;
        const strLen = u32(rtsAt + 4);
        const strAt = rtsAt + 8;
        const strBytes = head.slice(strAt, Math.min(strAt + Math.min(strLen, 48), head.length));
        const label = ascii(head.slice(8, 8 + labelLen));
        console.log(
          `🎯 LBL @0x${(addr + i).toString(16)} label=${label} len=${strLen} str=[${hex(strBytes)}] "${ascii(strBytes)}"`,
        );
        lblHits++;
      }
    }
    console.log(`🔎 LBL 命中 ${lblHits}`);
    // ListBox item bytes: decoded strings inserted through LB_ADDSTRING provide direct evidence of CSF
    // decoding results. Print the code point of each character.
    for (const control of shim.inspectControlItems()) {
      if (!control.items.length) continue;
      console.log(`📋 hwnd=0x${control.hwnd.toString(16)} ${control.className} sel=${control.selection}`);
      for (const item of control.items.slice(0, 10)) {
        const codes = [...item].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join(' ');
        console.log(
          `   [${codes}] "${[...item].map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127 ? c : '·')).join('')}"`,
        );
      }
    }
  }
  // DPlay probe for menu-route discovery (see watchDplay for continuous monitoring; unmet VM_DP_EXPECT fails).
  if (process.env.VM_DP_PROBE) {
    console.log(
      `🔎 DPlay 探测（全程峰值）：created=${dpSeen.created} hosting=${dpSeen.hosting} ` +
        `joined=${dpSeen.joined} players=${dpSeen.players}`,
    );
    const expect = process.env.VM_DP_EXPECT;
    if (expect) {
      const matched =
        (expect === 'created' && dpSeen.created > 0) ||
        (expect === 'hosting' && dpSeen.hosting) ||
        (expect === 'join' && dpSeen.joined) ||
        (expect === 'players2' && dpSeen.players >= 2);
      if (!matched) throw new Error(`DPlay 探测未达预期: ${expect}`);
      console.log(`✅ DPlay 探测达成: ${expect}`);
    }
  }
  // Click single-step trace: menu-action handling (VM_STEP_ON_CLICK=1).
  if (process.env.VM_STEP_ON_CLICK === '1' && stepTrace.length) {
    console.log(
      `👣 点击单步（前 160）: ${stepTrace
        .slice(0, 160)
        .map((a) => `0x${a.toString(16)}`)
        .join(' ')}`,
    );
    console.log(
      `👣 点击单步（后 40）: ${stepTrace
        .slice(-40)
        .map((a) => `0x${a.toString(16)}`)
        .join(' ')}`,
    );
  }
  if (GAME_ID === 'ra2') {
    const threads = shim.inspectGuestThreads();
    if (threads.length < 4 || (callCounts.get('KERNEL32.DLL!CreateThread') ?? 0) < 3) {
      throw new Error(`RA2 客体多线程未完整启动：${JSON.stringify(threads)}`);
    }
    console.log(`✅ RA2 客体调度：${threads.length} 条线程，PIT 抢占/Sleep/退出路径已执行`);
    console.log(`🖥️ RA2 shell 页标题：${JSON.stringify(shim.inspectShellPageTitle())}`);
    if (process.env.VM_TRACE_CONTROLS === '1') {
      for (const control of shim.inspectControlItems()) {
        console.log(
          `📋 hwnd=0x${control.hwnd.toString(16)} ${control.className} sel=${control.selection} items=${control.items.length}` +
            (control.items.length ? ` [${control.items.slice(0, 6).join(' | ')}]` : ''),
        );
      }
    }
    if (process.env.VM_TRACE_INPUT === '1') {
      console.log(
        `🖱️ 输入轨迹：${shim
          .inspectHostInputTrace()
          .map(
            (e) =>
              `${e.phase}:hwnd=0x${e.hwnd.toString(16)},msg=0x${e.message.toString(16)},cb=0x${e.callback.toString(16)},${e.className},l=0x${e.lParam.toString(16)}`,
          )
          .join(' | ')}`,
      );
    }
  }
  console.log(`✅ v86 已执行 ${EXECUTABLE}: entry=0x${image.entry.toString(16)}, imports=${image.importList.length}`);
  console.log(`✅ CRT/WinMain/DirectX hypercall ${calls} 次，原版资源已载入并进入 GetMessageA 主循环`);
  console.log(`✅ DirectDraw 已输出 ${frames} 帧，主表面 ${lastFrameSize}`);
  if (process.env.VM_INSPECT_WINDOWS === '1') {
    console.log(`🪟 窗口快照：${JSON.stringify(shim.inspectWindowState())}`);
  }
  if (process.env.VM_TRACE_CONTROL_SUMMARY === '1') {
    console.log(
      `🎛️ 默认控件消息：${[...defaultControlMessages]
        .map(
          ([key, value]) =>
            `${key}×${value.count}=>0x${value.result.toString(16)}` +
            `(w=0x${value.wParam.toString(16)},l=0x${value.lParam.toString(16)})`,
        )
        .join(' ')}`,
    );
  }
  if (recentBinkCalls.length) console.log(`🎞️ 最近 Bink 调用：${recentBinkCalls.join(' → ')}`);
  const heapState = shim.inspectHeapState();
  console.log(
    `✅ 客体堆：live=${heapState.liveBytes}，free=${heapState.freeBytes}，` +
      `next=0x${heapState.nextAddress.toString(16)}，peak=0x${heapState.peakAddress.toString(16)}`,
  );
  if (process.env.VM_PROFILE) {
    const topCalls = [...callCounts]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ');
    const topReadSizes = [...fileReadSizes]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16)
      .map(([size, count]) => `${size}B×${count}`)
      .join(', ');
    const topTimes = [...callTimes]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(
        ([key, ms]) =>
          `${key}=${ms.toFixed(1)}ms/${callCounts.get(key) ?? 0}次` +
          `(均${(ms / Math.max(1, callCounts.get(key) ?? 1)).toFixed(3)}ms,峰${(callMaxTimes.get(key) ?? 0).toFixed(1)}ms)`,
      )
      .join(', ');
    console.log(`📊 Win32 调用 Top 20：${topCalls}`);
    console.log(`📊 耗时 Top 20：${topTimes}`);
    console.log(
      `📊 dispatch 总耗时：${dispatchTotalMs.toFixed(0)}ms / ${calls} 次（均 ${(dispatchTotalMs / Math.max(1, calls)).toFixed(3)}ms）`,
    );
    console.log(`📊 文件挂载（harness/provider 侧）：${fileMountMs.toFixed(0)}ms / ${fileMountCount} 次`);
    console.log(`📊 ${frames} 帧像素总量 ${(frameBytes / 1024 / 1024).toFixed(0)} MiB`);
    console.log(
      `📊 里程碑：首帧=${firstFrameMs.toFixed(0)}ms 主循环=${mainLoopMs.toFixed(0)}ms 总计=${(performance.now() - profileT0).toFixed(0)}ms`,
    );
    console.log(`📊 _lread 长度：${topReadSizes || '无'}`);
  }
  console.log(
    hoverOnly
      ? '✅ 鼠标移动已经 GetMessageA 与 DispatchMessageA 进入原版 WndProc'
      : finalHoverOnly
        ? '✅ 点击路线与末点 hover 已经 GetMessageA 与 DispatchMessageA 进入原版 WndProc'
        : '✅ 鼠标移动/按下/抬起已经 GetMessageA 与 DispatchMessageA 进入原版 WndProc',
  );
  for (const rawAddress of (process.env.VM_PROBE_ADDRESSES ?? '').split(',').filter(Boolean)) {
    const address = Number(rawAddress);
    if (!Number.isFinite(address)) throw new Error(`无效 VM_PROBE_ADDRESSES 地址: ${rawAddress}`);
    const probeLength = Math.max(1, Math.min(4096, Number(process.env.VM_PROBE_LENGTH ?? 32) | 0));
    const bytes = emulator.read_memory(address, probeLength);
    console.log(
      `🔎 0x${address.toString(16)}: ` + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
  }
  if (process.env.VM_SURFACE_GLOBAL || process.env.VM_SURFACE_OBJECTS) {
    const globalAddress = Number(process.env.VM_SURFACE_GLOBAL ?? 0);
    const objects = process.env.VM_SURFACE_OBJECTS
      ? process.env.VM_SURFACE_OBJECTS.split(',').filter(Boolean).map(Number)
      : [readU32(emulator, globalAddress)];
    for (const object of objects) {
      const surface = shim.inspectSurface(object);
      if (!surface) throw new Error(`0x${object.toString(16)} 不是已登记的 DirectDraw surface`);
      let hash = 0x811c_9dc5;
      for (const byte of surface.pixels) hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
      console.log(
        `🔎 surface ${globalAddress ? `[0x${globalAddress.toString(16)}]=` : ''}0x${object.toString(16)} ` +
          `${surface.width}x${surface.height} pitch=${surface.pitch} fnv1a=0x${hash.toString(16)}`,
      );
      if (process.env.VM_SURFACE_PPM_PREFIX) {
        const path = `${process.env.VM_SURFACE_PPM_PREFIX}-${object.toString(16)}.ppm`;
        writeSurfacePpm(path, surface);
        console.log(`💾 surface 0x${object.toString(16)} → ${path}`);
      }
    }
  }
  if (process.env.VM_SURFACE_ALL_PPM_PREFIX) {
    for (const [index, info] of shim.inspectSurfaceObjects().entries()) {
      if (info.bpp !== 16) continue;
      const surface = shim.inspectSurface(info.object);
      if (!surface) continue;
      const path =
        `${process.env.VM_SURFACE_ALL_PPM_PREFIX}-${String(index).padStart(2, '0')}` +
        `-0x${info.object.toString(16)}-c${info.caps.toString(16)}.ppm`;
      writeSurfacePpm(path, surface);
      console.log(`💾 surface 0x${info.object.toString(16)} caps=0x${info.caps.toString(16)} → ${path}`);
    }
  }
  await emulator.destroy();
}

function clampClicks(clicks: readonly VmClick[]): Array<[number, number]> {
  if (!clicks.length) throw new Error('点击路线不能为空');
  // WM_*BUTTON/WM_MOUSEMOVE lParam uses signed 16-bit client coordinates.
  // RA2.INI can configure framebuffer dimensions; do not clip test points for sizes such as 1440x900 to
  // the old 800x600 bounds, or right-side shell-button hover events land in empty dialog space.
  return clicks.map(([x, y]) => [
    Math.max(-0x8000, Math.min(0x7fff, x | 0)),
    Math.max(-0x8000, Math.min(0x7fff, y | 0)),
  ]);
}

function writePpm(path: string, frame: VmFrame): void {
  const header = Buffer.from(`P6\n${frame.width} ${frame.height}\n255\n`);
  const pixels = Buffer.alloc(frame.width * frame.height * 3);
  if (frame.rgb565 && !frame.rgba) {
    for (let i = 0; i < frame.rgb565.length; i++) {
      const color = RGB565_TO_RGBA32[frame.rgb565[i]!]!;
      pixels[i * 3] = color & 255;
      pixels[i * 3 + 1] = (color >>> 8) & 255;
      pixels[i * 3 + 2] = (color >>> 16) & 255;
    }
    writeFileSync(path, Buffer.concat([header, pixels]));
    return;
  }
  if (frame.rgba) {
    for (let i = 0; i < frame.width * frame.height; i++) {
      pixels[i * 3] = frame.rgba[i * 4] ?? 0;
      pixels[i * 3 + 1] = frame.rgba[i * 4 + 1] ?? 0;
      pixels[i * 3 + 2] = frame.rgba[i * 4 + 2] ?? 0;
    }
    writeFileSync(path, Buffer.concat([header, pixels]));
    return;
  }
  for (let i = 0; i < frame.pixels.length; i++) {
    const color = frame.pixels[i]! * 4;
    pixels[i * 3] = frame.palette[color] ?? 0;
    pixels[i * 3 + 1] = frame.palette[color + 1] ?? 0;
    pixels[i * 3 + 2] = frame.palette[color + 2] ?? 0;
  }
  writeFileSync(path, Buffer.concat([header, pixels]));
}

function writeSurfacePpm(
  path: string,
  surface: { width: number; height: number; pitch: number; bpp: number; pixels: Uint8Array },
): void {
  const header = Buffer.from(`P6\n${surface.width} ${surface.height}\n255\n`);
  const output = Buffer.alloc(surface.width * surface.height * 3);
  if (surface.bpp !== 16) {
    writeFileSync(path, Buffer.concat([header, output]));
    return;
  }
  for (let y = 0; y < surface.height; y++) {
    for (let x = 0; x < surface.width; x++) {
      const source = y * surface.pitch + x * 2;
      const pixel = surface.pixels[source]! | (surface.pixels[source + 1]! << 8);
      const target = (y * surface.width + x) * 3;
      output[target] = ((((pixel >>> 11) & 0x1f) * 255) / 31) | 0;
      output[target + 1] = ((((pixel >>> 5) & 0x3f) * 255) / 63) | 0;
      output[target + 2] = (((pixel & 0x1f) * 255) / 31) | 0;
    }
  }
  writeFileSync(path, Buffer.concat([header, output]));
}

function bytesOf(path: string): Uint8Array {
  const bytes = readFileSync(path);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function bytesPrefix(path: string, maxBytes: number): { bytes: Uint8Array; totalSize: number } {
  const totalSize = statSync(path).size;
  const bytes = new Uint8Array(Math.min(maxBytes, totalSize));
  const fd = openSync(path, 'r');
  try {
    readSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
  return { bytes, totalSize };
}

function readCString(memory: V86, address: number, max = 1024): string {
  const bytes = memory.read_memory(address, max);
  const nul = bytes.indexOf(0);
  const end = nul < 0 ? bytes.length : nul;
  return decodeGuestNarrow(bytes.subarray(0, end));
}

function resolveGuestFile(gameDir: string, guestPath: string): string | null {
  const relative = normalizeGuestPath(guestPath);
  if (!relative) return null;
  let current = gameDir;
  for (const wanted of relative.split('/')) {
    const actual = readdirSync(current).find((name) => name.toLowerCase() === wanted);
    if (!actual) return null;
    current = join(current, actual);
  }
  return statSync(current).isFile() ? current : null;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readU32(memory: V86, address: number): number {
  const b = memory.read_memory(address, 4);
  return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
}

function readRect(memory: V86, address: number): [number, number, number, number] {
  return [
    readU32(memory, address) | 0,
    readU32(memory, address + 4) | 0,
    readU32(memory, address + 8) | 0,
    readU32(memory, address + 12) | 0,
  ];
}

function readU16(memory: V86, address: number): number {
  const b = memory.read_memory(address, 2);
  return (b[0]! | (b[1]! << 8)) >>> 0;
}

function readI16(memory: V86, address: number): number {
  const value = readU16(memory, address);
  return value & 0x8000 ? value | 0xffff_0000 : value;
}

/** Read variable-length template fields: 0xFFFF -> ordinal; otherwise UTF-16LE string (all DLGTEMPLATE strings are Unicode). */
function templateField(memory: V86, address: number): { next: number; text: string } {
  const first = readU16(memory, address);
  if (first === 0xffff) return { next: address + 4, text: `#${readU16(memory, address + 2)}` };
  const raw = memory.read_memory(address, 512);
  let utf16End = -1;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i] === 0 && raw[i + 1] === 0) {
      utf16End = i;
      break;
    }
  }
  if (utf16End >= 0) {
    const text = new TextDecoder('utf-16le').decode(raw.subarray(0, utf16End));
    return { next: address + utf16End + 2, text: JSON.stringify(text) };
  }
  // No UTF-16 terminator: fall back to an ANSI (Big5) single-byte scan.
  const nul = raw.indexOf(0);
  const bytes = raw.subarray(0, nul < 0 ? raw.length : nul);
  return {
    next: address + bytes.length + 1,
    text: `${JSON.stringify(new TextDecoder('big5').decode(bytes))} [ansi]`,
  };
}

/** Probe helper: parse DLGTEMPLATE/DLGTEMPLATEEX and print every control's template address, ID, coordinates, and title. */
function dumpDialogTemplate(memory: V86, address: number): void {
  try {
    const isEx = readU16(memory, address) === 1 && readU16(memory, address + 2) === 0xffff;
    if (isEx) {
      const style = readU32(memory, address + 12);
      const exStyle = readU32(memory, address + 8);
      const itemCount = readU16(memory, address + 16);
      const rect =
        `${readI16(memory, address + 18)},${readI16(memory, address + 20)},` +
        `${readI16(memory, address + 22)},${readI16(memory, address + 24)}`;
      console.log(
        `🧩 DLGTEMPLATEEX style=0x${style.toString(16)} ex=0x${exStyle.toString(16)} ` +
          `items=${itemCount} xywh(du)=${rect}${(style & 0x40) !== 0 ? ' DS_SETFONT' : ''}`,
      );
      let p = address + 26;
      for (const label of ['menu', 'class', 'title']) {
        const field = templateField(memory, p);
        console.log(`🧩   ${label}: ${field.text}`);
        p = field.next;
      }
      if ((style & 0x40) !== 0) {
        const pointsize = readU16(memory, p);
        p += 2 + 2 + 1 + 1; // pointsize, weight, italic, charset
        const typeface = templateField(memory, p);
        console.log(`🧩   font: ${pointsize}pt ${typeface.text}`);
        p = typeface.next;
      }
      for (let i = 0; i < itemCount; i++) {
        p = (p + 3) & ~3;
        const itemAddress = p;
        const itemEx = readU32(memory, p + 4);
        const itemStyle = readU32(memory, p + 8);
        const itemRect =
          `${readI16(memory, p + 12)},${readI16(memory, p + 14)},` +
          `${readI16(memory, p + 16)},${readI16(memory, p + 18)}`;
        const id = readU32(memory, p + 20);
        p += 24;
        const klass = templateField(memory, p);
        p = klass.next;
        const caption = templateField(memory, p);
        p = caption.next;
        const extra = readU16(memory, p);
        p += 2 + extra;
        console.log(
          `🧩   item[${i}] @0x${itemAddress.toString(16)} id=${id} xywh(du)=${itemRect} ` +
            `style=0x${itemStyle.toString(16)} ex=0x${itemEx.toString(16)} ` +
            `class=${klass.text} title=${caption.text}`,
        );
      }
      return;
    }
    const style = readU32(memory, address);
    const exStyle = readU32(memory, address + 4);
    const itemCount = readU16(memory, address + 8);
    const rect =
      `${readI16(memory, address + 10)},${readI16(memory, address + 12)},` +
      `${readI16(memory, address + 14)},${readI16(memory, address + 16)}`;
    console.log(
      `🧩 DLGTEMPLATE style=0x${style.toString(16)} ex=0x${exStyle.toString(16)} ` +
        `items=${itemCount} xywh=${rect}${(style & 0x40) !== 0 ? ' DS_SETFONT' : ''}`,
    );
    let p = address + 18;
    for (const label of ['menu', 'class', 'title']) {
      const field = templateField(memory, p);
      console.log(`🧩   ${label}: ${field.text}`);
      p = field.next;
    }
    if ((style & 0x40) !== 0) {
      p += 2; // pointsize
      const typeface = templateField(memory, p);
      console.log(`🧩   typeface: ${typeface.text}`);
      p = typeface.next;
    }
    for (let i = 0; i < itemCount; i++) {
      const itemAddress = p;
      const itemStyle = readU32(memory, p);
      const itemEx = readU32(memory, p + 4);
      const itemRect =
        `${readI16(memory, p + 8)},${readI16(memory, p + 10)},` +
        `${readI16(memory, p + 12)},${readI16(memory, p + 14)}`;
      const id = readU16(memory, p + 16);
      p += 18;
      const klass = templateField(memory, p);
      p = klass.next;
      const caption = templateField(memory, p);
      p = caption.next;
      console.log(
        `🧩   item[${i}] @0x${itemAddress.toString(16)} id=${id} xywh=${itemRect} ` +
          `style=0x${itemStyle.toString(16)} ex=0x${itemEx.toString(16)} ` +
          `class=${klass.text} title=${caption.text}`,
      );
    }
  } catch (error) {
    console.log(`🧩 DLGTEMPLATE 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeU32(memory: V86, address: number, value: number): void {
  memory.write_memory([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff], address);
}
