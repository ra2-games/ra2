import { GuestRegistry, RegistryHandles } from '../registry';
import type {
  GuestMemory,
  MciWindowState,
  MessageState,
  MmioState,
  MultimediaTimerState,
  PeImport,
  TimerState,
  VmCallbackState,
  VmHeapState,
  Win32Call,
  Win32Result,
  Win32ShimOptions,
} from '../win32';
import {
  GUEST_CALLBACK_BASE,
  GUEST_CALLBACK_STRIDE,
  GUEST_CALLBACK_SLOTS,
  GUEST_CALLBACK_SCRATCH_BYTES,
  GUEST_CALLBACK_OWNERS,
  HYPERCALL_CALLBACK_DEPTH,
  GUEST_THREAD_FPU_CONTEXTS,
  GUEST_THREAD_FPU_CONTEXT_BYTES,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_LIMIT,
  GUEST_THREAD_RUN_STATES,
  GUEST_WINDOW_ENTRY_BYTES,
  GUEST_WINDOW_EXSTYLE,
  GUEST_WINDOW_EXTRA0,
  GUEST_WINDOW_EXTRA12,
  GUEST_WINDOW_EXTRA4,
  GUEST_WINDOW_EXTRA8,
  GUEST_WINDOW_HEIGHT,
  GUEST_WINDOW_ID,
  GUEST_WINDOW_PARENT,
  GUEST_WINDOW_STYLE,
  GUEST_WINDOW_TABLE,
  GUEST_WINDOW_TABLE_MAX,
  GUEST_WINDOW_USERDATA,
  GUEST_WINDOW_OWNER,
  GUEST_WINDOW_VALID,
  GUEST_WINDOW_WIDTH,
  GUEST_WINDOW_WNDPROC,
  GUEST_WINDOW_X,
  GUEST_WINDOW_Y,
  HYPERCALL_ACTIVE_SHELL_SURFACE,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
  HYPERCALL_LAST_ERROR,
  HYPERCALL_PEEK_BUDGET,
  HYPERCALL_THREAD_COUNT,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../pe';
import { ScaledClock } from '../clock';
import { decodeGuestNarrow } from './text';
import { EMPTY_GAME_SHIM_PROFILE, type CampaignMenuCompatibility, type GameShimProfile } from './gameProfile';

/** Dynamic guest stubs grow upward from here; the region ends at 0x200000. */
export const DYNAMIC_STUB_BASE = 0x000c_0000;
/** Generic constructor for the mixin chain, producing instance type T. */
export type Constructor<T> = new (...args: any[]) => T;

/** Guest PeekMessageA fast returns allowed after confirming an empty message queue. */
const FAST_PEEK_EMPTY_BUDGET = 255;

export interface LoadedGuestDll {
  name: string;
  base: number;
  size: number;
  entry: number;
  initialized: boolean;
  exports: Map<string, number>;
}

/** Drive-type constants returned by Win32 GetDriveType. */
export const DRIVE_NO_ROOT_DIR = 1;
export const DRIVE_FIXED = 3;
export const DRIVE_CDROM = 5;

/** Each VM has one guest process; share its identity with window-ownership queries instead of host process IDs. */
export const GUEST_PROCESS_ID = 1;

// 0x70000-0x70fff contains FS/TEB; 0x71000-0x72fff is reserved RAM unused by firmware.
// Static/dynamic stubs start at 0x80000/0xc0000, so this cannot overlap import/vtable stubs.
export const FAST_FILE_TABLE = 0x0007_1000;
export const FAST_FILE_HANDLE_BASE = 0x4000;
export const FAST_FILE_TABLE_ENTRIES = 512;
export const FAST_FILE_ENTRY_BYTES = 16;
/** 64 TLS slots per thread, after fast-file and scheduler-state tables. */
export const FAST_TLS_TABLE = 0x0007_4000;
export const FAST_TLS_ENTRIES = 64;
export const FAST_TLS_THREAD_BYTES = FAST_TLS_ENTRIES * 4;
export interface GuestCallbackFrame {
  depth: number;
  trampoline: number;
  ownerAddress: number;
  /** Reserved data at the slot tail; generated instructions must stop before this address. */
  scratchAddress: number;
}

export interface GuestThreadState {
  id: number;
  handle: number;
  runnable: boolean;
  terminated: boolean;
  wakeAt: number;
  /** Heap allocation backing this thread's stack; released once the thread has exited and stopped running. */
  stackBase?: number;
  /** CloseHandle has been called, so the guest can no longer observe this thread and its id may be reused. */
  handleClosed?: boolean;
  wait?: GuestWaitState;
  criticalSection?: number;
  /** Wait result completed before saving the shared context, consumed by the host-delay return path. */
  waitResult?: number;
}

export interface GuestWaitState {
  handles: number[];
  waitAll: boolean;
  deadline?: number;
}

export interface GuestEventObject {
  manualReset: boolean;
  signaled: boolean;
  name: string;
  handles: Set<number>;
}

export interface GuestMutexObject {
  ownerThreadId: number | null;
  recursion: number;
  abandoned: boolean;
  name: string;
  handles: Set<number>;
}

// Default soft mirror limit: allocate from the game heap and free on close, so usage follows open files;
// over-limit files fall back to hypercall reads. Never carve out a fixed mirror region: repeated native save loads
// approach the 126MB guest limit, and reserving 48MB would exhaust address space prematurely.
export const FAST_FILE_MIRROR_LIMIT = 48 * 1024 * 1024;

/** Diagnostic tracing enabled only by Node smoke process.env; browsers/Workers lack process and always use false. */
export function shimTraceEnabled(name: string): boolean {
  return typeof process !== 'undefined' && !!process.env?.[name];
}

/**
 * Base state for the generic Win32 shim: heap/virtual memory, threads, windows, messages, input, memory helpers, and diagnostic snapshots. File, guest-DLL, synchronization, and graphics state live in stateFiles/stateGuestDll/stateSync/stateGraphics mixins, composed in order by win32.ts and Win32 dispatch modules.
 */
export class ShimState {
  protected get lastError(): number {
    return this.readU32(HYPERCALL_LAST_ERROR);
  }
  protected set lastError(value: number) {
    this.writeU32(HYPERCALL_LAST_ERROR, value >>> 0);
  }

  /** Up to 16 recent failed-open paths, deduplicating consecutive repeats, to identify missing files in crash reports. */
  readonly failedOpens: string[] = [];
  /**
   * Details shown with blocked status when dispatch returns null; vmCore clears them after reading. Currently CoCreateInstance uses this for rclsid/riid.
   */
  unimplementedDetail: string | null = null;
  // The heap starts above the game stack; large-image games may move it via heapBase.
  protected nextHeap: number;
  protected peakHeap: number;
  protected readonly heapBase: number;
  protected readonly allocations = new Map<number, number>();
  protected readonly freeBlocks: Array<{ ptr: number; size: number }> = [];
  /**
   * VirtualAlloc reservations follow the wemu model and never overlap the heap arena; MEM_DECOMMIT retains reservations. VC6 CRT reserves 1MB at startup, then commits/decommits 32KB blocks. These addresses must never enter heap free lists, or HeapAlloc users such as file mirrors could reuse live game blocks, causing the historical CPU #6 @EIP=0x8f crash.
   */
  protected readonly virtualRegions = new Map<number, { size: number }>();
  /**
   * Regions returned by MEM_RELEASE follow wemu try_free: reusable only by VirtualAlloc, never placed in heap free lists. Reservation and heap arenas are disjoint, so HeapAlloc cannot claim them.
   */
  protected readonly virtualFreeBlocks: Array<{ ptr: number; size: number }> = [];
  protected readonly virtualTop: number;
  protected readonly virtualBase: number;
  protected readonly heapTop: number;
  protected readonly warnedVirtual = new Set<number>();
  protected readonly tls = new Map<number, number>();
  protected nextTls = 0;
  /** Reusable scheduler slots; stateSync allocates the separate guest-visible wait handles. */
  protected nextThreadId = 1;
  protected readonly guestThreads = new Map<number, GuestThreadState>();
  protected readonly guestThreadHandles = new Map<number, number>();
  /** Ids of exited threads whose handles are closed; reused so long sessions do not exhaust GUEST_THREAD_LIMIT. */
  protected readonly freeThreadIds: number[] = [];
  protected threadExitStub = 0;
  protected threadReturnTrampoline = 0;
  protected readonly commandLine = 0x0006_1000;
  protected readonly modulePath = 0x0006_1100;
  protected readonly environmentA = 0x0006_1200;
  protected readonly environmentW = 0x0006_1300;
  /** Dynamic import IDs and stub allocator; stateGuestDll owns registration. */
  protected nextDynamicId: number;
  protected nextDynamicStub = DYNAMIC_STUB_BASE;
  protected readonly windowClasses = new Map<string, number>();
  protected readonly windows = new Map<number, number>();
  protected readonly windowClassNames = new Map<number, string>();
  protected readonly windowTexts = new Map<number, string>();
  protected readonly controlDisplayTexts = new Map<number, string>();
  protected readonly windowLongs = new Map<string, number>();
  protected readonly windowParents = new Map<number, number>();
  /** Window client rectangles: child coordinates are parent-relative; top-level coordinates are desktop-relative. */
  protected readonly windowRects = new Map<number, { x: number; y: number; width: number; height: number }>();
  /** Windows with update regions not yet consumed by BeginPaint/ValidateRect. */
  protected readonly invalidatedWindows = new Set<number>();
  protected readonly dialogChildren = new Map<string, number>();
  protected readonly controlIds = new Map<number, number>();
  /** Lightweight default system-control state; RA2 skirmish settings depend on these message results. */
  protected readonly trackbarStates = new Map<number, { min: number; max: number; pos: number }>();
  protected readonly buttonChecks = new Map<number, number>();
  protected readonly controlItems = new Map<number, Array<{ text: string; data: number }>>();
  protected readonly controlSelections = new Map<number, number>();
  protected readonly controlItemHeights = new Map<number, number>();
  /** ListBox top visible item index, synchronized by LB_GETTOPINDEX/LB_SETTOPINDEX/WM_VSCROLL. */
  protected readonly listboxTopIndices = new Map<number, number>();
  protected readonly comboStates = new Map<
    number,
    {
      selectionHeight: number;
      itemHeight: number;
      dropped: boolean;
      droppedWidth: number;
      droppedHeight: number;
    }
  >();
  protected readonly mciWindows = new Map<number, MciWindowState>();
  protected readonly timers = new Map<string, TimerState>();
  protected readonly multimediaTimers = new Map<number, MultimediaTimerState>();
  protected nextMultimediaTimer = 1;
  protected readonly messages: MessageState[] = [];
  protected readonly pendingHostMessages: MessageState[] = [];
  /** RA2 shell Peeks without Dispatch; synchronously deliver host input at the next API boundary. */
  protected readonly pendingHostDispatches: MessageState[] = [];
  /** Latest host-input hit/dispatch record, distinguishing coordinate hit testing, queueing, and WndProc failures. */
  protected readonly hostInputTrace: Array<{
    phase: 'post' | 'dispatch';
    hwnd: number;
    hitHwnd?: number;
    pointerX?: number;
    pointerY?: number;
    message: number;
    callback: number;
    className: string;
    lParam: number;
  }> = [];
  /** Window roots that synchronously entered WM_DESTROY and await guest callback unwinding before release. */
  protected readonly pendingWindowDestroys = new Map<number, number>();
  protected hostInputDispatchCount = 0;
  protected readonly keyStates = new Map<number, boolean>();
  protected lastHostKeyMessage = 0;
  protected lastHostKeyVirtualKey = 0;
  protected campaignHoverDispatchCount = 0;
  /** Synthesized WM_TIMER dispatch count for cross-thread probes of continued guest message pumping. */
  protected wmTimerDispatchCount = 0;

  protected nextWindow = 0x2000;
  protected primaryWindow = 0;
  protected focusWindow = 0;
  protected activeWindow = 0;
  protected foregroundWindow = 0;
  protected captureWindow = 0;
  /** USER32 Button down target; capture prevents the matching up from landing on controls from a new page. */
  protected pressedButton = 0;
  protected inputReady = false;
  protected cursorX = 400;
  protected cursorY = 300;
  /**
   * Hardware cursor cache: HCURSOR to decoded RGBA. RA2 switches cursors with Win32 LoadCursor/SetCursor without drawing into DirectDraw frames. The host overlays a small separate texture, retaining visibility under Pointer Lock without copying 800x600 frames per movement.
   */
  protected readonly cursorImages = new Map<
    number,
    { width: number; height: number; hotspotX: number; hotspotY: number; rgba: Uint8Array }
  >();
  /** module:id to HCURSOR, avoiding repeated decoding of the same cursor resource. */
  protected readonly cursorHandleById = new Map<string, number>();
  /** HCURSOR currently selected by SetCursor; 0 means absent/unset. */
  protected currentCursorHandle = 0;
  /** RegisterClassA hCursor; RA2 menus use class cursors without calling SetCursor. */
  protected classCursor = 0;
  protected cursorDebugCount = 0;
  protected nextCursorHandle = 0x9000;
  protected displayWidth = 800;
  protected displayHeight = 600;
  protected displayBpp = 8;
  /**
   * Dimensions of the last frame actually delivered to the frontend. Input follows the visible frame, not the current primary handle; RA2 transitions may create the next 800x600 primary while the old frame remains displayed.
   */
  protected presentedWidth = 800;
  protected presentedHeight = 600;
  protected primarySurface = 0;
  /**
   * Active 800x600 RA2 shell surface. The game draws main menus to primary, subpages to OFFSCREENPLAIN, and in-game menus to caps=0 surfaces, while primary emitFrame triggers presentation. The latest Unlock/Blt target holds current screen content.
   */
  protected activeShellSurface = 0;
  /** Most recent draw order of shell software surfaces; composition cannot rely on Map creation order. */
  protected shellSurfaceDrawSerial = 0;
  /** Title resource key of the current RA2 dialog template, distinguishing shell menus from content pages. */
  protected shellPageTitle = '';
  protected readonly clock: ScaledClock;
  protected frameScheduled = false;
  protected disposed = false;
  protected lastCallbackState: VmCallbackState | null = null;
  protected readonly driveTypes = new Map<string, number>();
  protected readonly registry: RegistryHandles;
  protected readonly staticImports: readonly PeImport[];
  protected readonly moduleName: string;
  protected currentDirectory = 'C:\\GAME';
  protected readonly gameProfile: GameShimProfile;
  protected readonly mmioHandles = new Map<number, MmioState>();
  protected nextMmioHandle = 0x5000;

  constructor(
    protected readonly memory: GuestMemory,
    protected readonly options: Win32ShimOptions = {},
  ) {
    this.clock = new ScaledClock();
    this.registry = new RegistryHandles(options.processContext?.kernel.registry ?? new GuestRegistry());
    this.nextDynamicId = options.firstDynamicId ?? 1;
    this.virtualTop = options.virtualTop ?? 0x07e0_0000;
    this.virtualBase = options.virtualBase ?? 0x004b_e000;
    this.heapTop = options.heapTop ?? 0x07e0_0000;
    this.heapBase = options.heapBase ?? 0x0070_0000;
    this.nextHeap = this.heapBase;
    this.peakHeap = this.heapBase;
    this.guestThreads.set(0, {
      id: 0,
      handle: 0xffff_fffe,
      runnable: true,
      terminated: false,
      wakeAt: 0,
    });
    this.writeU32(HYPERCALL_THREAD_CURRENT, 0);
    this.writeU32(HYPERCALL_THREAD_NEXT, 0);
    this.writeU32(HYPERCALL_THREAD_COUNT, 1);
    this.writeU32(GUEST_THREAD_RUN_STATES, 1);
    this.zero(GUEST_CALLBACK_OWNERS, GUEST_CALLBACK_SLOTS * 4);
    this.writeU32(HYPERCALL_CALLBACK_DEPTH, 0);
    for (let id = 0; id < GUEST_THREAD_LIMIT; id++) {
      const context = GUEST_THREAD_FPU_CONTEXTS + id * GUEST_THREAD_FPU_CONTEXT_BYTES;
      this.zero(context, GUEST_THREAD_FPU_CONTEXT_BYTES);
      this.writeU32(context, 0x037f); // Default x87 control word.
      this.writeU32(context + 24, 0x1f80); // Default MXCSR; zero abridged tag marks x87 registers empty.
    }
    this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, 0);
    this.writeU32(HYPERCALL_PEEK_BUDGET, 0);
    this.writeU32(HYPERCALL_CURSOR_X, this.cursorX);
    this.writeU32(HYPERCALL_CURSOR_Y, this.cursorY);
    // Default to a neutral placeholder module name; the generic layer does not assume executable names.
    // RA2/YR supply their own through options.moduleName.
    this.moduleName = options.moduleName || 'app.exe';
    this.staticImports = options.staticImports ?? [];
    this.gameProfile = options.gameProfile ?? EMPTY_GAME_SHIM_PROFILE;
    // Arguments affect only the command line, not module identity. Preserve NUL bounds at 0x61000..0x610ff;
    // reject excessive lengths or embedded NULs rather than truncating arguments or overwriting the following module path.
    const argumentsText = options.commandLineArguments?.trim() ?? '';
    const commandLine = this.moduleName + (argumentsText ? ` ${argumentsText}` : '');
    if (commandLine.includes('\0') || commandLine.length >= this.modulePath - this.commandLine) {
      throw new Error('客体命令行过长或包含 NUL');
    }
    this.writeAscii(this.commandLine, commandLine);
    this.writeAscii(this.modulePath, `C:\\GAME\\${this.moduleName}`);
    this.memory.write_memory(new Uint8Array([0, 0]), this.environmentA);
    this.memory.write_memory(new Uint8Array([0, 0, 0, 0]), this.environmentW);
    const driveTypes = options.driveTypes ?? { C: DRIVE_FIXED };
    for (const [letter, type] of Object.entries(driveTypes)) {
      if (/^[a-z]$/i.test(letter)) this.driveTypes.set(letter.toUpperCase(), type >>> 0);
    }
  }

  inspectCallbackState(): VmCallbackState | null {
    return this.lastCallbackState;
  }

  /** Current RA2 shell title resource key, letting state-driven input tests await actual menu creation. */
  inspectShellPageTitle(): string {
    return this.shellPageTitle;
  }

  /** Player-visible native control content, without callbacks, pointers or hidden windows. */
  inspectVisibleControlContent() {
    return [...this.windows.keys()]
      .filter((hwnd) => this.isWindowTreeVisible(hwnd))
      .flatMap((hwnd) => {
        const text = this.windowTexts.get(hwnd) ?? '';
        const displayText = this.controlDisplayTexts.get(hwnd);
        const items = this.controlItems.get(hwnd)?.map((item) => item.text) ?? [];
        if (!text && displayText === undefined && !items.length) return [];
        return [
          {
            id: this.controlIds.get(hwnd) ?? 0,
            className: this.windowClassNames.get(hwnd) ?? '',
            text,
            ...(displayText === undefined ? {} : { displayText }),
            items,
          },
        ];
      });
  }

  /** Copy transient custom label buffers without changing their native message dispatch. */
  protected observeControlTextMessage(hwnd: number, message: number, lParam: number): void {
    const protocol = this.gameProfile.shell?.controlTextMessage;
    if (
      message !== protocol?.message ||
      !protocol.classNames.includes(this.windowClassNames.get(hwnd)?.toLowerCase() ?? '')
    )
      return;
    // A later malformed update must not leave an old label looking current. Missing differs from empty.
    this.controlDisplayTexts.delete(hwnd);
    if (!lParam) {
      this.controlDisplayTexts.set(hwnd, '');
      return;
    }
    const units: number[] = [];
    try {
      for (let index = 0; index < 4096; index++) {
        const bytes = this.memory.read_memory(lParam + index * 2, 2);
        if (bytes.length !== 2) return;
        const unit = bytes[0]! | (bytes[1]! << 8);
        if (!unit) {
          this.controlDisplayTexts.set(hwnd, String.fromCharCode(...units));
          return;
        }
        units.push(unit);
      }
    } catch {
      // Observation must not turn an unreadable label into a guest execution failure.
    }
  }

  /** A window is actually visible only if it and every ancestor have WS_VISIBLE. */
  protected isWindowTreeVisible(start: number): boolean {
    const seen = new Set<number>();
    let hwnd = start;
    while (hwnd && !seen.has(hwnd)) {
      seen.add(hwnd);
      if (((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x1000_0000) === 0) return false;
      hwnd = this.windowParents.get(hwnd) ?? 0;
    }
    return true;
  }

  /** Identify shell menus using game-registered page-title state plus a visible dialog. */
  protected isShellVisible(): boolean {
    if (!this.gameProfile.shell?.compositeRgb565Layers) return false;
    const titleControlId = this.gameProfile.shell.titleControlId;
    if (titleControlId !== undefined) {
      if (!this.shellPageTitle) return false;
      for (const [hwnd, id] of this.controlIds) {
        if (id === titleControlId && ((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x1000_0000) !== 0) return true;
      }
      return false;
    }
    for (const [hwnd, className] of this.windowClassNames) {
      if (className.toLowerCase() !== '#32770' || !this.isWindowTreeVisible(hwnd)) continue;
      const rect = this.windowRects.get(hwnd);
      if (rect && rect.width >= this.displayWidth && rect.height >= this.displayHeight) return true;
    }
    return false;
  }

  /**
   * Return registered Campaign controls when the current shell page matches that game's Campaign page, otherwise undefined. Share this check across RGBA composition, hidden-list-border fixes, and logo-hover diagnostics. Games without registration receive no Campaign-specific compensation.
   */
  protected campaignMenu(): CampaignMenuCompatibility | undefined {
    const menu = this.gameProfile.shell?.campaignMenu;
    if (!menu) return undefined;
    const title = this.shellPageTitle.toLowerCase();
    return menu.titleKeys.some((key) => title.includes(key)) ? menu : undefined;
  }

  /** ListBox/ComboBox content snapshots for RA2 map/dropdown enumeration checks. */
  inspectControlItems(): Array<{ hwnd: number; className: string; selection: number; items: string[] }> {
    return [...this.controlItems.entries()].map(([hwnd, items]) => ({
      hwnd,
      className: this.windowClassNames.get(hwnd) ?? '',
      selection: this.controlSelections.get(hwnd) ?? -1,
      items: items.map((item) => item.text),
    }));
  }

  inspectHostInputTrace(): Array<{
    phase: 'post' | 'dispatch';
    hwnd: number;
    message: number;
    callback: number;
    className: string;
    lParam: number;
  }> {
    return this.hostInputTrace.map((entry) => ({ ...entry }));
  }

  /** User32 layout/hit-test snapshots; return copies only so tests cannot modify window-manager state. */
  inspectWindowState(): Array<{
    hwnd: number;
    callback: number;
    parent: number;
    id: number;
    className: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number } | null;
    style: number;
  }> {
    return [...this.windows].map(([hwnd, callback]) => ({
      hwnd,
      callback,
      parent: this.windowParents.get(hwnd) ?? 0,
      id: this.controlIds.get(hwnd) ?? 0,
      className: this.windowClassNames.get(hwnd) ?? '',
      text: this.windowTexts.get(hwnd) ?? '',
      rect: this.windowRects.get(hwnd) ? { ...this.windowRects.get(hwnd)! } : null,
      style: this.windowLongs.get(`${hwnd}:-16`) ?? 0,
    }));
  }

  /** Debugger guest-thread snapshots without exposing mutable internal scheduling state. */
  inspectGuestThreads(): Array<{
    id: number;
    handle: number;
    current: boolean;
    next: boolean;
    runnable: boolean;
    terminated: boolean;
    wakeInMs: number;
    waitHandles?: number[];
    waitForThread?: number;
    waitForCriticalSection?: number;
    waitInMs?: number;
    runState: number;
    criticalDepth: number;
  }> {
    const now = this.clock.now();
    const current = this.readU32(HYPERCALL_THREAD_CURRENT);
    const next = this.readU32(HYPERCALL_THREAD_NEXT);
    return [...this.guestThreads.values()].map((thread) => {
      const waitedThread =
        thread.wait?.handles.length === 1 ? this.guestThreadHandles.get(thread.wait.handles[0]!) : undefined;
      return {
        id: thread.id,
        handle: thread.handle,
        current: thread.id === current,
        next: thread.id === next,
        runnable: thread.runnable,
        terminated: thread.terminated,
        wakeInMs: thread.wakeAt > 0 ? Math.max(0, thread.wakeAt - now) : 0,
        runState: this.readU32(GUEST_THREAD_RUN_STATES + thread.id * 4),
        criticalDepth: this.readU32(GUEST_THREAD_CRITICAL_DEPTH + thread.id * 4),
        ...(thread.criticalSection === undefined ? {} : { waitForCriticalSection: thread.criticalSection }),
        ...(thread.wait ? { waitHandles: [...thread.wait.handles] } : {}),
        ...(waitedThread === undefined ? {} : { waitForThread: waitedThread }),
        ...(thread.wait?.deadline === undefined ? {} : { waitInMs: Math.max(0, thread.wait.deadline - now) }),
      };
    });
  }

  /** Game-specific imports intercepted by mixins before shared DLL dispatch; none by default. */
  protected dispatchExclusive(_call: Win32Call): Win32Result | null {
    return null;
  }

  /** Game composition may handle Winsock; the generic shim stops at unimplemented boundaries by default. */
  protected dispatchGameWinsock(_key: string, _args: number[]): Win32Result | null {
    return null;
  }

  /** Game composition releases its network resources; no-op in the generic shim. */
  protected disposeGameNetwork(): void {}

  /** Reserve slots during host generation; other threads or not-yet-started bridges cannot reuse them. */
  protected reserveGuestCallback(scratchBytes = GUEST_CALLBACK_SCRATCH_BYTES): GuestCallbackFrame {
    if (!Number.isInteger(scratchBytes) || scratchBytes < 0 || scratchBytes >= GUEST_CALLBACK_STRIDE) {
      throw new Error(`Invalid guest callback scratch size: ${scratchBytes}`);
    }
    for (let depth = 0; depth < GUEST_CALLBACK_SLOTS; depth++) {
      const ownerAddress = GUEST_CALLBACK_OWNERS + depth * 4;
      if (this.readU32(ownerAddress) !== 0) continue;
      this.writeU32(ownerAddress, this.readU32(HYPERCALL_THREAD_CURRENT) + 1);
      this.writeU32(HYPERCALL_CALLBACK_DEPTH, this.readU32(HYPERCALL_CALLBACK_DEPTH) + 1);
      const trampoline = GUEST_CALLBACK_BASE + depth * GUEST_CALLBACK_STRIDE;
      return { depth, trampoline, ownerAddress, scratchAddress: trampoline + GUEST_CALLBACK_STRIDE - scratchBytes };
    }
    throw new Error(`客体回调槽耗尽（${GUEST_CALLBACK_SLOTS} 个活动回调）`);
  }

  /** Cancel a reserved bridge when generation fails before its address is handed to the guest. */
  protected cancelGuestCallback(frame: GuestCallbackFrame): void {
    this.writeU32(frame.ownerAddress, 0);
    this.writeU32(HYPERCALL_CALLBACK_DEPTH, this.readU32(HYPERCALL_CALLBACK_DEPTH) - 1);
  }

  protected releaseExitedThreadCallbacks(threadId: number): void {
    let released = 0;
    for (let slot = 0; slot < GUEST_CALLBACK_SLOTS; slot++) {
      const address = GUEST_CALLBACK_OWNERS + slot * 4;
      if (this.readU32(address) !== threadId + 1) continue;
      this.writeU32(address, 0);
      released++;
    }
    // ExitThread bypasses bridge tails. The import handshake still blocks switching,
    // and the thread will never resume, so all its nested callback slots can safely be reclaimed.
    this.writeU32(HYPERCALL_CALLBACK_DEPTH, this.readU32(HYPERCALL_CALLBACK_DEPTH) - released);
  }

  protected appendGuestCallbackReturn(code: number[], frame: GuestCallbackFrame, originalReturn: number): void {
    const emit32 = (value: number) =>
      code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
    // Keep slot release through RET non-preemptible, or another thread could overwrite the tail still executing.
    code.push(0xfa, 0xff, 0x0d);
    emit32(HYPERCALL_CALLBACK_DEPTH); // cli; dec [active]
    code.push(0xc7, 0x05);
    emit32(frame.ownerAddress);
    emit32(0);
    code.push(0x68);
    emit32(originalReturn); // push return, preserving callback EAX.
    code.push(0x8b, 0x0d);
    emit32(HYPERCALL_THREAD_CURRENT);
    code.push(0x83, 0x3c, 0x8d);
    emit32(GUEST_THREAD_CRITICAL_DEPTH);
    code.push(0);
    code.push(0x75, 0x01, 0xfb, 0xc3); // jne ret; sti; ret, with STI's interrupt shadow covering RET.
    // Reject before the scratch tail, not at the slot end: bridges such as CoCreateInstance keep their data there.
    if (code.length > frame.scratchAddress - frame.trampoline) {
      throw new Error(`客体回调桥超出槽位: ${code.length}`);
    }
  }

  /** Generate dynamic guest stubs on the host, shared by file, DLL, synchronization, and graphics mixins. */
  protected allocateDynamicCode(code: Uint8Array | number[]): number {
    const bytes = code instanceof Uint8Array ? code : new Uint8Array(code);
    let address = this.nextDynamicStub;
    // 0xf0000..0xfffff contains live firmware, GDT, and IDT; never write dynamic stubs there.
    if (address < 0x0010_0000 && address + bytes.length > 0x000f_0000) address = 0x0010_0000;
    const end = Math.ceil((address + bytes.length) / 16) * 16;
    if (end > 0x0020_0000) throw new Error('动态 stub 区不足');
    this.memory.write_memory(bytes, address);
    this.nextDynamicStub = end;
    return address;
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.keyStates.set(virtualKey >>> 0, down);
  }

  /** Actual presented-surface mouse coordinates and bounds for cross-thread verification of final clamping. */
  inspectPointerState(): {
    x: number;
    y: number;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    lastKeyMessage: number;
    lastKeyVirtualKey: number;
    lastMouseMessage: number;
    lastMouseHwnd: number;
    lastMouseControlId: number;
    lastMouseCallback: number;
    lastMouseHitControlId: number;
    lastMouseHitClass: string;
    lastMouseHitText: string;
    lastMouseInputX: number;
    lastMouseInputY: number;
    lastMouseInputMessage: number;
    lastMouseDispatchHwnd: number;
    lastMouseDispatchControlId: number;
    lastMouseDispatchCallback: number;
    campaignHoverDispatches: number;
    wmTimerDispatches: number;
  } {
    const client = this.windowRects.get(this.primaryWindow);
    let mouse: (typeof this.hostInputTrace)[number] | undefined;
    let dispatchedMouse: (typeof this.hostInputTrace)[number] | undefined;
    for (let index = this.hostInputTrace.length - 1; index >= 0; index--) {
      const entry = this.hostInputTrace[index]!;
      if (!mouse && entry.phase === 'post') mouse = entry;
      if (!dispatchedMouse && entry.phase === 'dispatch') dispatchedMouse = entry;
      if (mouse && dispatchedMouse) break;
    }
    const hitHwnd = mouse?.hitHwnd ?? mouse?.hwnd ?? 0;
    return {
      x: this.cursorX,
      y: this.cursorY,
      width: this.presentedWidth,
      height: this.presentedHeight,
      clientWidth: client?.width ?? 0,
      clientHeight: client?.height ?? 0,
      lastKeyMessage: this.lastHostKeyMessage,
      lastKeyVirtualKey: this.lastHostKeyVirtualKey,
      lastMouseMessage: mouse?.message ?? 0,
      lastMouseHwnd: mouse?.hwnd ?? 0,
      lastMouseControlId: mouse ? (this.controlIds.get(mouse.hwnd) ?? 0) : 0,
      lastMouseCallback: mouse?.callback ?? 0,
      lastMouseHitControlId: hitHwnd ? (this.controlIds.get(hitHwnd) ?? 0) : 0,
      lastMouseHitClass: hitHwnd ? (this.windowClassNames.get(hitHwnd)?.toLowerCase() ?? '') : '',
      lastMouseHitText: hitHwnd ? (this.windowTexts.get(hitHwnd) ?? '') : '',
      lastMouseInputX: mouse?.pointerX ?? 0,
      lastMouseInputY: mouse?.pointerY ?? 0,
      lastMouseInputMessage: mouse?.message ?? 0,
      lastMouseDispatchHwnd: dispatchedMouse?.hwnd ?? 0,
      lastMouseDispatchControlId: dispatchedMouse ? (this.controlIds.get(dispatchedMouse.hwnd) ?? 0) : 0,
      lastMouseDispatchCallback: dispatchedMouse?.callback ?? 0,
      campaignHoverDispatches: this.campaignHoverDispatchCount,
      wmTimerDispatches: this.wmTimerDispatchCount,
    };
  }

  setCursorPosition(x: number, y: number): void {
    // During transitions, DirectDraw's current primary may already be the next 800x600 surface
    // while the browser still shows the previous 1440x900 battlefield. Clamp to the last presented frame
    // so RA2/YR frontend and final Worker coordinates share the same bounds.
    const width = this.presentedWidth;
    const height = this.presentedHeight;
    this.cursorX = Math.max(0, Math.min(Math.max(0, width - 1), Math.round(x)));
    this.cursorY = Math.max(0, Math.min(Math.max(0, height - 1), Math.round(y)));
    this.syncCursorPositionToGuest();
  }

  /** Cursor-coordinate mirror update shared by host input and SetCursorPos. */
  protected syncCursorPositionToGuest(): void {
    this.writeU32(HYPERCALL_CURSOR_X, this.cursorX >>> 0);
    this.writeU32(HYPERCALL_CURSOR_Y, this.cursorY >>> 0);
  }

  /** Force the next PeekMessageA back to the host when messages or timer state change. */
  protected invalidateFastPeek(): void {
    this.writeU32(HYPERCALL_PEEK_BUDGET, 0);
  }

  /** Allow bounded guest fast empty-polling only when the message queue and both timer classes are empty. */
  protected refreshFastPeekBudget(): void {
    const mustPollHost =
      this.messages.length > 0 ||
      this.pendingHostDispatches.length > 0 ||
      this.pendingHostMessages.length > 0 ||
      this.timers.size > 0 ||
      this.multimediaTimers.size > 0;
    this.writeU32(HYPERCALL_PEEK_BUDGET, mustPollHost ? 0 : FAST_PEEK_EMPTY_BUDGET);
  }

  setGameClockRate(rate: number): number {
    return this.clock.setRate(rate);
  }

  inspectHeapState(): VmHeapState {
    return {
      liveAllocations: this.allocations.size,
      liveBytes: [...this.allocations.values()].reduce((sum, size) => sum + size, 0),
      freeBlocks: this.freeBlocks.length,
      freeBytes: this.freeBlocks.reduce((sum, block) => sum + block.size, 0),
      nextAddress: this.nextHeap,
      peakAddress: this.peakHeap,
      virtualRegions: this.virtualRegions.size,
      virtualBytes: [...this.virtualRegions.values()].reduce((sum, region) => sum + region.size, 0),
      virtualFreeBytes: this.virtualFreeBlocks.reduce((sum, block) => sum + block.size, 0),
    };
  }

  protected readU32(ptr: number): number {
    const b = this.memory.read_memory(ptr, 4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  protected readU8(ptr: number): number {
    return this.memory.read_memory(ptr, 1)[0] ?? 0;
  }

  protected readU16(ptr: number): number {
    const b = this.memory.read_memory(ptr, 2);
    return (b[0]! | (b[1]! << 8)) >>> 0;
  }

  /**
   * Reusable four-byte writeU32 scratch buffer avoids array-literal allocation in high-frequency Lock/SetColorKey paths. write_memory copies synchronously, so reuse is safe.
   */
  private readonly writeU32Scratch = new Uint8Array(4);

  protected writeU32(ptr: number, value: number): void {
    const scratch = this.writeU32Scratch;
    scratch[0] = value & 0xff;
    scratch[1] = (value >>> 8) & 0xff;
    scratch[2] = (value >>> 16) & 0xff;
    scratch[3] = (value >>> 24) & 0xff;
    this.memory.write_memory(scratch, ptr);
  }

  /** 顶层窗口的 x/y 已经是屏幕坐标；只有 WS_CHILD 才沿父窗口累加客户区偏移。 */
  protected windowCoordinateParent(hwnd: number): number {
    const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
    return (style & 0x4000_0000) !== 0 ? (this.windowParents.get(hwnd) ?? 0) : 0;
  }

  /**
   * HWND values are never reused: RA2 keeps stale handles (page changes then repaint through them) and reuse made
   * new dialogs inherit a destroyed window's messages, leaving the menu blank. The mirror table wraps instead.
   */
  protected allocateWindowHandle(): number {
    return this.nextWindow++;
  }

  /**
   * Mirror window properties after each mutation so guest fast stubs observe current state. Store absolute
   * coordinates by accumulating parent offsets; colliding handles fall back to hypercalls after owner validation.
   */
  protected syncWindowToGuest(hwnd: number): void {
    if (hwnd < 0x2000) return;
    // Wrap instead of giving up past the end: a long session creates far more than GUEST_WINDOW_TABLE_MAX windows,
    // and without wrapping every later window permanently loses its fast stubs. Colliding hwnds differ by the table
    // size, so the owner field below tells the stub whether this entry is really its window.
    const index = (hwnd - 0x2000) & (GUEST_WINDOW_TABLE_MAX - 1);
    const base = GUEST_WINDOW_TABLE + index * GUEST_WINDOW_ENTRY_BYTES;
    // A destroyed window must not clear an entry a colliding live window has since claimed, or that window would
    // lose its fast stubs until its next state change. Live windows still take the slot over.
    if (!this.windows.has(hwnd) && this.readU32(base + GUEST_WINDOW_OWNER) !== hwnd) return;
    let absX = 0;
    let absY = 0;
    {
      let current = hwnd;
      const seen = new Set<number>();
      while (current && !seen.has(current)) {
        seen.add(current);
        const r = this.windowRects.get(current);
        if (r) {
          absX += r.x;
          absY += r.y;
        }
        current = this.windowCoordinateParent(current);
      }
    }
    const rect = this.windowRects.get(hwnd);
    this.writeU32(base + GUEST_WINDOW_X, absX >>> 0);
    this.writeU32(base + GUEST_WINDOW_Y, absY >>> 0);
    this.writeU32(base + GUEST_WINDOW_WIDTH, (rect?.width ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_HEIGHT, (rect?.height ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_PARENT, (this.windowParents.get(hwnd) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_STYLE, (this.windowLongs.get(`${hwnd}:-16`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_ID, (this.windowLongs.get(`${hwnd}:-12`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXSTYLE, (this.windowLongs.get(`${hwnd}:-20`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_WNDPROC, (this.windows.get(hwnd) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_USERDATA, (this.windowLongs.get(`${hwnd}:-21`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA0, (this.windowLongs.get(`${hwnd}:0`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA4, (this.windowLongs.get(`${hwnd}:4`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA8, (this.windowLongs.get(`${hwnd}:8`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA12, (this.windowLongs.get(`${hwnd}:12`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_OWNER, hwnd >>> 0);
    const live = this.windows.has(hwnd);
    this.writeU32(base + GUEST_WINDOW_VALID, live ? 1 : 0);
    // The slot is free again: hand it to a live window that wraps onto it, otherwise a long-lived window evicted
    // by a newer one (the main window is evicted every GUEST_WINDOW_TABLE_MAX windows) would stay on hypercalls.
    if (!live) {
      for (const candidate of this.windows.keys()) {
        if (candidate === hwnd || ((candidate - 0x2000) & (GUEST_WINDOW_TABLE_MAX - 1)) !== index) continue;
        this.syncWindowToGuest(candidate);
        break;
      }
    }
  }

  /**
   * Geometry or parent-chain changes affect descendant absolute coordinates; synchronize the entire subtree. Moves/reparenting are rare, mostly during layout, so O(descendants) updates are acceptable.
   */
  protected syncWindowTreeToGuest(hwnd: number): void {
    const queue = [hwnd];
    const seen = new Set<number>();
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      this.syncWindowToGuest(current);
      for (const [child, parent] of this.windowParents) {
        if (parent === current && !seen.has(child)) queue.push(child);
      }
    }
  }

  protected readBytes(ptr: number, max: number): Uint8Array {
    return this.memory.read_memory(ptr, max);
  }

  protected readCString(ptr: number, max = 0x1_0000): string {
    if (!ptr) return '';
    const bytes = this.readBytes(ptr, max);
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    return decodeGuestNarrow(bytes.subarray(0, end));
  }

  /** Raw byte count before NUL, matching Win32 lstrlenA without combining GBK byte pairs. */
  protected narrowStringLength(ptr: number, max = 0x1_0000): number {
    if (!ptr) return 0;
    const bytes = this.readBytes(ptr, max);
    const end = bytes.indexOf(0);
    return end < 0 ? bytes.length : end;
  }

  protected readNarrowBytes(ptr: number, length: number): Uint8Array {
    if (!ptr) return new Uint8Array();
    if (length >= 0) return this.memory.read_memory(ptr, length);
    const bytes = this.memory.read_memory(ptr, 0x1_0000);
    const nul = bytes.indexOf(0);
    return bytes.subarray(0, (nul < 0 ? bytes.length : nul) + 1);
  }

  protected readWideUnits(ptr: number, length: number): number[] {
    if (!ptr) return [];
    const maxUnits = length >= 0 ? length : 0x8000;
    const bytes = this.memory.read_memory(ptr, maxUnits * 2);
    const out: number[] = [];
    for (let i = 0; i < maxUnits; i++) {
      const value = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
      out.push(value);
      if (length < 0 && value === 0) break;
    }
    return out;
  }

  protected writeAscii(ptr: number, value: string): void {
    const out = new Uint8Array(value.length + 1);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0x7f;
    this.memory.write_memory(out, ptr);
  }

  protected writeCharTypes(ptr: number, units: number[]): void {
    if (!ptr) return;
    const out = new Uint8Array(units.length * 2);
    for (let i = 0; i < units.length; i++) {
      const c = units[i]!;
      let type = 0;
      if (c >= 0x41 && c <= 0x5a) type |= 0x0001 | 0x0100;
      if (c >= 0x61 && c <= 0x7a) type |= 0x0002 | 0x0100;
      if (c >= 0x30 && c <= 0x39) type |= 0x0004;
      if (c === 0x20 || (c >= 9 && c <= 13)) type |= 0x0008;
      if (c === 0x20 || c === 9) type |= 0x0040;
      if (c < 0x20 || c === 0x7f) type |= 0x0020;
      if ((c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e))
        type |= 0x0010;
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) type |= 0x0080;
      out[i * 2] = type & 0xff;
      out[i * 2 + 1] = type >>> 8;
    }
    this.memory.write_memory(out, ptr);
  }

  protected writeRect(ptr: number, left: number, top: number, right: number, bottom: number): void {
    this.writeU32(ptr, left);
    this.writeU32(ptr + 4, top);
    this.writeU32(ptr + 8, right);
    this.writeU32(ptr + 12, bottom);
  }

  protected readRect(ptr: number): [number, number, number, number] {
    // Read 16 bytes once instead of four readU32 calls, each requiring two WASM boundary checks;
    // RECT reads are fixed overhead in tens of thousands of BltFast/Blt calls per second.
    const b = this.memory.read_memory(ptr, 16);
    return [
      b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24) | 0,
      b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24) | 0,
      b[8]! | (b[9]! << 8) | (b[10]! << 16) | (b[11]! << 24) | 0,
      b[12]! | (b[13]! << 8) | (b[14]! << 16) | (b[15]! << 24) | 0,
    ];
  }

  protected mapAsciiCase(c: number, flags: number): number {
    if ((flags & 0x100) !== 0 && c >= 0x41 && c <= 0x5a) return c + 0x20; // LCMAP_LOWERCASE
    if ((flags & 0x200) !== 0 && c >= 0x61 && c <= 0x7a) return c - 0x20; // LCMAP_UPPERCASE
    return c;
  }

  /**
   * Reusable fill scratch buffer for small screen/surface/structure clears, avoiding Uint8Array allocation in frequent CreateSurface paths.
   */
  private fillScratch = new Uint8Array(64 * 1024);

  protected writeFilledRegion(ptr: number, size: number, index: number): void {
    if (size <= 0) return;
    const chunk = size <= this.fillScratch.length ? this.fillScratch : new Uint8Array(size);
    chunk.fill(index);
    if (size === chunk.length) {
      this.memory.write_memory(chunk, ptr);
      return;
    }
    let offset = 0;
    while (offset < size) {
      const step = Math.min(chunk.length, size - offset);
      this.memory.write_memory(chunk.subarray(0, step), ptr + offset);
      offset += step;
    }
  }

  protected zero(ptr: number, size: number): void {
    this.writeFilledRegion(ptr, size, 0);
  }
}
