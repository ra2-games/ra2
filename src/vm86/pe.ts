/**
 * RA2/YR PE32 loader.
 *
 * Implements only the minimal Windows-loader subset: place the PE image in v86 guest memory and replace IAT entries with synchronous hypercall stubs. The JS host implements Win32 semantics; this is not a Windows emulator.
 */

export const HYPERCALL_PAGE = 0x0006_0000;
export const HYPERCALL_STACK = HYPERCALL_PAGE + 0x00;
export const HYPERCALL_EAX = HYPERCALL_PAGE + 0x04;
export const HYPERCALL_EDX = HYPERCALL_PAGE + 0x08;
export const HYPERCALL_REQUEST = HYPERCALL_PAGE + 0x0c;
/** Wake the host immediately through COM1 output events instead of waiting for polling on every hypercall. */
export const HYPERCALL_NOTIFY_PORT = 0x03f8;
/** 0 means no exception; otherwise CPU vector + 1, published last by boot.asm. */
export const HYPERCALL_EXCEPTION = HYPERCALL_PAGE + 0x10;
export const HYPERCALL_EXCEPTION_ERROR = HYPERCALL_PAGE + 0x14;
export const HYPERCALL_EXCEPTION_EIP = HYPERCALL_PAGE + 0x18;
export const HYPERCALL_EXCEPTION_CS = HYPERCALL_PAGE + 0x1c;
export const HYPERCALL_EXCEPTION_EFLAGS = HYPERCALL_PAGE + 0x20;
export const HYPERCALL_EXCEPTION_ESP = HYPERCALL_PAGE + 0x24;
export const HYPERCALL_EXCEPTION_EAX = HYPERCALL_PAGE + 0x28;
export const HYPERCALL_EXCEPTION_ECX = HYPERCALL_PAGE + 0x2c;
export const HYPERCALL_EXCEPTION_EDX = HYPERCALL_PAGE + 0x30;
export const HYPERCALL_EXCEPTION_EBX = HYPERCALL_PAGE + 0x34;
export const HYPERCALL_EXCEPTION_EBP = HYPERCALL_PAGE + 0x38;
export const HYPERCALL_EXCEPTION_ESI = HYPERCALL_PAGE + 0x3c;
export const HYPERCALL_EXCEPTION_EDI = HYPERCALL_PAGE + 0x40;
/** Firmware scheduling barrier throughout exception delivery and context restoration. */
export const HYPERCALL_DEBUG_ACTIVE = HYPERCALL_PAGE + 0x94;
/** Actual AddressOfEntryPoint written by the host after PE parsing, used by generic boot firmware. */
export const HYPERCALL_ENTRY = HYPERCALL_PAGE + 0x44;
/** Total reserved callback bridges not yet returned, including bridges not yet started. */
export const HYPERCALL_CALLBACK_DEPTH = HYPERCALL_PAGE + 0x48;
/** Firmware halt-loop marker: hang writes 1 after PE entry returns, letting the host recognize silent halts as exit. */
export const HYPERCALL_HALTED = HYPERCALL_PAGE + 0x4c;
/** Store guest callback EAX after trampoline return for diagnostics, including enumeration callback BOOL results. */
export const HYPERCALL_CALLBACK_RESULT = HYPERCALL_PAGE + 0x50;
/** Host-selected main-thread stack top for the current game; large PEs can avoid the old fixed stack region. */
export const HYPERCALL_STACK_TOP = HYPERCALL_PAGE + 0x58;
/** 64-bit monotonic guest QueryPerformanceCounter, with 1 tick = 1ms. */
export const HYPERCALL_QPC_LOW = HYPERCALL_PAGE + 0x5c;
export const HYPERCALL_QPC_HIGH = HYPERCALL_PAGE + 0x60;
/** Win32 LastError shared by guest and host. */
export const HYPERCALL_LAST_ERROR = HYPERCALL_PAGE + 0x64;
/** Cooperative guest-thread scheduling: current/next thread IDs and API-return continuation address. */
export const HYPERCALL_THREAD_CURRENT = HYPERCALL_PAGE + 0x68;
export const HYPERCALL_THREAD_NEXT = HYPERCALL_PAGE + 0x6c;
export const HYPERCALL_THREAD_CONTINUATION = HYPERCALL_PAGE + 0x70;
/** Thread count shared by PIT preemption and the host. */
export const HYPERCALL_THREAD_COUNT = HYPERCALL_PAGE + 0x74;
/** Win32 cursor display count returned by ShowCursor; >=0 means visible. */
export const HYPERCALL_CURSOR_COUNT = HYPERCALL_PAGE + 0x78;
/** PeekMessageA empty-queue fast-return budget; at 0, return to the host to check messages/timers. */
export const HYPERCALL_PEEK_BUDGET = HYPERCALL_PAGE + 0x7c;
/** Host/guest shared Win32 cursor coordinates read directly by the GetCursorPos fast stub. */
export const HYPERCALL_CURSOR_X = HYPERCALL_PAGE + 0x80;
export const HYPERCALL_CURSOR_Y = HYPERCALL_PAGE + 0x84;
/** Current host-composited RA2 shell offscreen surface, used by the Unlock fast stub to detect layer changes. */
export const HYPERCALL_ACTIVE_SHELL_SURFACE = HYPERCALL_PAGE + 0x88;
/**
 * Full lifetime during which an import stub owns the global request/EAX/EDX return slots.
 * The host clears request before IRQ4, so request=0 does not mean the thread consumed return values. PIT uses this marker as a switch barrier, closing the preemption window between IRQ4 iret and the stub's cli.
 */
export const HYPERCALL_IMPORT_ACTIVE = HYPERCALL_PAGE + 0x8c;
export const GUEST_THREAD_LIMIT = 64;
/** Common contexts are 40 bytes (pushad, EFLAGS, EIP); PIT/yield snapshots live in private firmware storage. */
export const GUEST_THREAD_CONTEXT_ESPS = 0x0007_3400;
export const GUEST_THREAD_CONTEXT_SEH = 0x0007_3500;
export const GUEST_THREAD_CONTEXT_STACK_TOP = 0x0007_3600;
export const GUEST_THREAD_CONTEXT_STACK_BOTTOM = 0x0007_3700;
export const GUEST_THREAD_CONTEXT_LAST_ERROR = 0x0007_3800;
/** 0=absent/exited, 1=runnable, >=2 means 100Hz tick deadline + 2. */
export const GUEST_THREAD_RUN_STATES = 0x0007_3900;
export const GUEST_SCHEDULER_TICKS = 0x0007_3a00;
/** Per-thread compatibility atomic-execution depth; nonzero keeps CLI after import return and does not represent a Win32 lock. */
export const GUEST_THREAD_CRITICAL_DEPTH = 0x0007_3b00;
export const GUEST_CALLBACK_OWNERS = 0x0007_3c00;
export const GUEST_CALLBACK_BASE = 0x0022_0000;
export const GUEST_CALLBACK_STRIDE = 4096;
export const GUEST_CALLBACK_SLOTS = 64;
/** Tail bytes of each callback slot reserved for bridge scratch data (see ole32 CoCreateInstance); code must not reach them. */
export const GUEST_CALLBACK_SCRATCH_BYTES = 32;
/** Match boot.asm FXSAVE/FXRSTOR layout: 512-byte, 16-byte-aligned state. */
export const GUEST_THREAD_FPU_CONTEXTS = 0x0007_8000;
export const GUEST_THREAD_FPU_CONTEXT_BYTES = 512;

// Window geometry/property mirror keeps frequent read-only GetClientRect/GetWindowRect/ClientToScreen/GetParent/
// GetWindowLongA queries inside the guest, avoiding VM/JS crossings per call.
// Located at 0x62000, free space after environment strings at 0x61300 and before TEB at 0x70000.
// Allocate hwnd sequentially from 0x2000 and index by hwnd-0x2000; out-of-range/unsynchronized entries use full hypercalls.
// X/Y hold absolute screen coordinates, accumulated through parents during shim synchronization; guest stubs need no parent traversal.
export const GUEST_WINDOW_TABLE = 0x0006_2000;
/** Power of two: guest stubs mask the hwnd instead of dividing, and entries carry their owner for collisions. */
export const GUEST_WINDOW_TABLE_MAX = 512;
export const GUEST_WINDOW_ENTRY_BYTES = 64;
export const GUEST_WINDOW_X = 0;
export const GUEST_WINDOW_Y = 4;
export const GUEST_WINDOW_WIDTH = 8;
export const GUEST_WINDOW_HEIGHT = 12;
export const GUEST_WINDOW_PARENT = 16;
export const GUEST_WINDOW_STYLE = 20; // GWL_STYLE (-16)
export const GUEST_WINDOW_ID = 24; // GWL_ID (-12)
export const GUEST_WINDOW_EXSTYLE = 28; // GWL_EXSTYLE (-20)
export const GUEST_WINDOW_WNDPROC = 32; // GWL_WNDPROC (-4)
export const GUEST_WINDOW_USERDATA = 36; // GWL_USERDATA (-21)
export const GUEST_WINDOW_EXTRA0 = 40; // Window extra bytes at 0/4/8/12.
export const GUEST_WINDOW_EXTRA4 = 44;
export const GUEST_WINDOW_EXTRA8 = 48;
export const GUEST_WINDOW_EXTRA12 = 52;
export const GUEST_WINDOW_VALID = 56;
export const GUEST_WINDOW_OWNER = 60; // HWND owning this wrapped entry.

export interface PeImport {
  /** Hypercall request ID; reserve 0 for no request, so IDs start at 1. */
  id: number;
  dll: string;
  name: string;
  key: string;
  slot: number;
  stub: number;
  argBytes: number;
  /** Numeric DLL tag annotated by the Win32 layer after loading, using win32ModuleOf; ignored by non-Win32 loaders. */
  win32Module?: number;
  /** Precomputed dynamic COM-stub routing: numeric interface tag from shim/directx.ts COM_TAG_*; undefined for non-COM entries. */
  comTag?: number;
  /**
   * Method name after the final dot in key, computed at stub creation. Per-call lastIndexOf+slice is a routing hotspot under hundreds of thousands of hypercalls per second in the Tongyi Tianxia MOD.
   */
  method?: string;
}

export interface PeImage {
  entry: number;
  imageBase: number;
  sizeOfImage: number;
  /** Import name DLL!Func to patched IAT-slot address. */
  imports: Map<string, number>;
  importList: PeImport[];
  /** IAT start/slot count per DLL for debugging. */
  iatRanges: Array<{ dll: string; firstThunk: number; count: number }>;
}

export type ImportArgBytes = (dll: string, name: string) => number;
export type ImportStubFactory = (dll: string, name: string, id: number, argBytes: number) => Uint8Array;

/**
 * Generate x86 stdcall import stubs. The guest publishes request and notifies the host through COM1, then waits for JS to write EAX/EDX and clear request. This handshake preserves synchronous Win32 semantics across v86 and the asynchronous browser event loop.
 */
export function makeImportStub(id: number, argBytes: number): Uint8Array {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`import stub id 非法: ${id}`);
  if (!Number.isInteger(argBytes) || argBytes < 0 || argBytes > 0xffff || argBytes % 4 !== 0) {
    throw new Error(`import stub 参数字节数非法: ${argBytes}`);
  }
  const b = new Uint8Array(512);
  let p = 0;
  // The API handshake uses a global shared page; prevent PIT thread switches during request publication/reclamation.
  b[p++] = 0xfa; // cli
  // C7 05 8C000600 01000000  mov dword [importActive],1
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 1);
  // 89 25 00000600          mov [0x60000], esp
  b[p++] = 0x89;
  b[p++] = 0x25;
  p = put32(b, p, HYPERCALL_STACK);
  // B8 id                    mov eax, id
  b[p++] = 0xb8;
  p = put32(b, p, id);
  // A3 0C000600              mov [0x6000c], eax
  b[p++] = 0xa3;
  p = put32(b, p, HYPERCALL_REQUEST);
  // 66 BA F8 03 / EE         mov dx, 0x3f8; out dx, al（v86 serial0-output-byte）
  b[p++] = 0x66;
  b[p++] = 0xba;
  b[p++] = HYPERCALL_NOTIFY_PORT & 0xff;
  b[p++] = HYPERCALL_NOTIFY_PORT >>> 8;
  b[p++] = 0xee;
  // wait: check request after STI. The host may release it before HLT on the fast path,
  // with the wake byte already consumed by firmware irq_common; unconditional HLT would then never wake.
  // HLT only while unreleased, waking through COM1 RX IRQ4; CLI restores the game environment.
  const wait = p;
  b[p++] = 0xfb; // sti
  b[p++] = 0x83;
  b[p++] = 0x3d;
  p = put32(b, p, HYPERCALL_REQUEST);
  b[p++] = 0x00;
  b[p++] = 0x74; // je done
  const jeOffset = p++;
  b[p++] = 0xf4; // hlt
  b[p++] = 0xfa; // cli
  b[p++] = 0xec; // in al, dx: firmware usually already consumed the byte; reading an empty FIFO is harmless.
  b[p++] = 0xeb; // jmp wait
  const jmpRel8 = wait - (p + 1);
  b[p++] = jmpRel8 & 0xff;
  const done = p;
  b[jeOffset] = done - (jeOffset + 1);
  b[p++] = 0xfa; // cli
  // A1 04000600              mov eax, [0x60004]
  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_EAX);
  // 8B 15 08000600           mov edx, [0x60008]
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, HYPERCALL_EDX);
  // The host may select another runnable NEXT thread. EAX/EDX already contain API results;
  // save them with all registers before switching so every thread resumes with its own result.
  b[p++] = 0x8b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_NEXT); // mov ecx,[next]
  b[p++] = 0x3b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT); // cmp ecx,[current]
  b[p++] = 0x0f;
  b[p++] = 0x84;
  const noSwitchRel = p;
  p += 4;

  // Fold stdcall return+arguments into one continuation address before constructing the shared context frame.
  b[p++] = 0x8f;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_THREAD_CONTINUATION); // pop [cont]
  b[p++] = 0x81;
  b[p++] = 0xc4;
  p = put32(b, p, argBytes); // add esp,argBytes
  b[p++] = 0xff;
  b[p++] = 0x35;
  p = put32(b, p, HYPERCALL_THREAD_CONTINUATION); // push [cont]
  // The task gate saves real registers on a private kernel stack. The current
  // thread later resumes at RET with its cleaned-up native continuation intact.
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 0);
  b[p++] = 0xcd;
  b[p++] = 0x31;
  b[p++] = 0xc3;

  const noSwitch = p;
  const relative = noSwitch - (noSwitchRel + 4);
  put32(b, noSwitchRel, relative);
  // EAX/EDX are loaded and no thread switch will occur; release global return slots before returning.
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 0);
  b[p++] = 0x8b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT);
  b[p++] = 0x83;
  b[p++] = 0x3c;
  b[p++] = 0x8d;
  p = put32(b, p, GUEST_THREAD_CRITICAL_DEPTH);
  b[p++] = 0;
  b[p++] = 0x75;
  b[p++] = 0x01;
  b[p++] = 0xfb; // sti: allow preemption outside compatibility atomic regions.
  b[p++] = 0xc2;
  b[p++] = argBytes & 0xff;
  b[p++] = (argBytes >>> 8) & 0xff;
  if (p > b.length) throw new Error(`import stub 超出容量: ${p}`);
  return b.slice(0, p);
}

/** Host-free stdcall fast stub: return a fixed EAX and pop arguments. */
export function makeConstantImportStub(eax: number, argBytes: number): Uint8Array {
  validateArgBytes(argBytes);
  return new Uint8Array([
    0xb8,
    eax & 0xff,
    (eax >>> 8) & 0xff,
    (eax >>> 16) & 0xff,
    (eax >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/** Host-free stdcall fast stub: return the first argument unchanged. */
export function makeFirstArgImportStub(argBytes: number): Uint8Array {
  validateArgBytes(argBytes);
  return new Uint8Array([
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/**
 * Load a PE into a guest-memory image indexed by physical address.
 *
 * stubAlloc must return guest virtual/physical addresses; current firmware uses a flat identity mapping without paging.
 */
export function loadPe(
  mem8: Uint8Array,
  exe: Uint8Array,
  stubAlloc: (bytes: number) => number,
  importArgBytes: ImportArgBytes,
  importStub: ImportStubFactory = (_dll, _name, id, argBytes) => makeImportStub(id, argBytes),
): PeImage {
  const dv = viewOf(exe);
  need(exe, 0, 0x40, 'DOS 头');
  const peOff = dv.getUint32(0x3c, true);
  need(exe, peOff, 24, 'PE 头');
  if (dv.getUint32(peOff, true) !== 0x0000_4550) throw new Error('非 PE 文件');
  const numSections = dv.getUint16(peOff + 6, true);
  const optionalSize = dv.getUint16(peOff + 20, true);
  const optOff = peOff + 24;
  need(exe, optOff, optionalSize, 'PE optional header');
  if (dv.getUint16(optOff, true) !== 0x10b) throw new Error('仅支持 PE32');

  const imageBase = dv.getUint32(optOff + 28, true);
  const entry = dv.getUint32(optOff + 16, true) + imageBase;
  const sizeOfImage = dv.getUint32(optOff + 56, true);
  const sizeOfHeaders = dv.getUint32(optOff + 60, true);
  need(mem8, imageBase, sizeOfImage, 'VM 中的 PE 映像');

  // Windows maps DOS/PE headers too; some CRT code and code following GetModuleHandle read them.
  const headerBytes = Math.min(sizeOfHeaders, exe.length);
  mem8.set(exe.subarray(0, headerBytes), imageBase);

  const sectionTable = optOff + optionalSize;
  need(exe, sectionTable, numSections * 40, 'section 表');
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    const vsize = dv.getUint32(s + 8, true);
    const vaddr = dv.getUint32(s + 12, true);
    const rawSize = dv.getUint32(s + 16, true);
    const rawOff = dv.getUint32(s + 20, true);
    const mappedSize = Math.max(vsize, rawSize);
    const dst = imageBase + vaddr;
    need(mem8, dst, mappedSize, `section #${i} 目标`);
    if (rawSize > 0) {
      need(exe, rawOff, rawSize, `section #${i} 原始数据`);
      mem8.set(exe.subarray(rawOff, rawOff + rawSize), dst);
    }
    if (mappedSize > rawSize) mem8.fill(0, dst + rawSize, dst + mappedSize);
  }

  const imports = new Map<string, number>();
  const importList: PeImport[] = [];
  const iatRanges: PeImage['iatRanges'] = [];
  const importDirRva = dv.getUint32(optOff + 104, true); // data directory[1]
  let descOff = importDirRva ? rvaToOff(exe, importDirRva) : -1;
  for (let descriptor = 0; descOff >= 0 && descriptor < 128; descriptor++, descOff += 20) {
    need(exe, descOff, 20, `import descriptor #${descriptor}`);
    const dllNameRva = dv.getUint32(descOff + 12, true);
    const firstThunkRva = dv.getUint32(descOff + 16, true);
    const origThunkRva = dv.getUint32(descOff, true);
    if (!dllNameRva && !firstThunkRva) break;
    if (!dllNameRva || !firstThunkRva) throw new Error(`import descriptor #${descriptor} 不完整`);

    const dll = readCstr(exe, dllNameRva);
    const dllUpper = dll.toUpperCase();
    let count = 0;
    for (let k = 0; k < 4096; k++) {
      const thunkRva = (origThunkRva || firstThunkRva) + k * 4;
      const thunkOff = rvaToOff(exe, thunkRva);
      if (thunkOff < 0) throw new Error(`${dll} thunk RVA 无效: 0x${thunkRva.toString(16)}`);
      need(exe, thunkOff, 4, `${dll} thunk #${k}`);
      const thunk = dv.getUint32(thunkOff, true);
      if (!thunk) break;

      const name = (thunk & 0x8000_0000) !== 0 ? `ord${thunk & 0xffff}` : readCstr(exe, thunk + 2); // The first two IMAGE_IMPORT_BY_NAME bytes contain the hint.
      const slot = imageBase + firstThunkRva + k * 4;
      need(mem8, slot, 4, `${dll}!${name} IAT`);
      const argBytes = importArgBytes(dllUpper, name);
      const id = importList.length + 1;
      const stubBytes = importStub(dllUpper, name, id, argBytes);
      const stub = stubAlloc(stubBytes.length);
      need(mem8, stub, stubBytes.length, `${dll}!${name} stub`);
      mem8.set(stubBytes, stub);
      putU32(mem8, slot, stub);

      const key = `${dllUpper}!${name}`;
      imports.set(key, slot);
      importList.push({ id, dll: dllUpper, name, key, slot, stub, argBytes });
      count++;
    }
    iatRanges.push({ dll, firstThunk: imageBase + firstThunkRva, count });
  }

  return { entry, imageBase, sizeOfImage, imports, importList, iatRanges };
}

function validateArgBytes(argBytes: number): void {
  if (!Number.isInteger(argBytes) || argBytes < 0 || argBytes > 0xffff || argBytes % 4 !== 0) {
    throw new Error(`import stub 参数字节数非法: ${argBytes}`);
  }
}

/** RVA to file offset in headers/sections; return -1 if unmatched. */
/**
 * Enumerate all uppercase DLL!function import keys without generating stubs.
 * The file layer uses import coverage to classify custom-named EXEs into compatibility layers; return an empty list for malformed structures.
 */
export function peImportKeys(exe: Uint8Array): string[] {
  try {
    const dv = viewOf(exe);
    const keys: string[] = [];
    if (exe.length < 0x40) return keys;
    const peOff = dv.getUint32(0x3c, true);
    if (peOff < 0 || peOff + 24 > exe.length) return keys;
    const optionalSize = dv.getUint16(peOff + 20, true);
    const optOff = peOff + 24;
    if (optOff + optionalSize > exe.length) return keys;
    const importDirRva = optionalSize >= 108 ? dv.getUint32(optOff + 104, true) : 0; // data directory[1]
    let descOff = importDirRva ? rvaToOff(exe, importDirRva) : -1;
    for (let descriptor = 0; descOff >= 0 && descriptor < 128; descriptor++, descOff += 20) {
      if (descOff + 20 > exe.length) return keys;
      const dllNameRva = dv.getUint32(descOff + 12, true);
      const firstThunkRva = dv.getUint32(descOff + 16, true);
      const origThunkRva = dv.getUint32(descOff, true);
      if (!dllNameRva && !firstThunkRva) break;
      if (!dllNameRva || !firstThunkRva) return keys;
      const dllUpper = readCstr(exe, dllNameRva).toUpperCase();
      for (let k = 0; k < 4096; k++) {
        const thunkRva = (origThunkRva || firstThunkRva) + k * 4;
        const thunkOff = rvaToOff(exe, thunkRva);
        if (thunkOff < 0 || thunkOff + 4 > exe.length) return keys;
        const thunk = dv.getUint32(thunkOff, true);
        if (!thunk) break;
        const name = (thunk & 0x8000_0000) !== 0 ? `ord${thunk & 0xffff}` : readCstr(exe, thunk + 2); // The first two IMAGE_IMPORT_BY_NAME bytes contain the hint.
        keys.push(`${dllUpper}!${name}`);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

export function rvaToOff(exe: Uint8Array, rva: number): number {
  const dv = viewOf(exe);
  if (exe.length < 0x40) return -1;
  const peOff = dv.getUint32(0x3c, true);
  if (peOff < 0 || peOff + 24 > exe.length) return -1;
  const numSections = dv.getUint16(peOff + 6, true);
  const optionalSize = dv.getUint16(peOff + 20, true);
  const optOff = peOff + 24;
  if (optOff + optionalSize > exe.length) return -1;
  const sizeOfHeaders = optionalSize >= 64 ? dv.getUint32(optOff + 60, true) : 0;
  if (rva < sizeOfHeaders && rva < exe.length) return rva;
  const sectionTable = optOff + optionalSize;
  if (sectionTable + numSections * 40 > exe.length) return -1;
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    const vsize = dv.getUint32(s + 8, true);
    const vaddr = dv.getUint32(s + 12, true);
    const rawSize = dv.getUint32(s + 16, true);
    const rawOff = dv.getUint32(s + 20, true);
    if (rva >= vaddr && rva < vaddr + Math.max(vsize, rawSize)) {
      const off = rawOff + (rva - vaddr);
      return off < exe.length ? off : -1;
    }
  }
  return -1;
}

function readCstr(exe: Uint8Array, rva: number): string {
  const off = rvaToOff(exe, rva);
  if (off < 0) throw new Error(`ASCII 串 RVA 无效: 0x${rva.toString(16)}`);
  let end = off;
  while (end < exe.length && exe[end] !== 0) end++;
  if (end === exe.length) throw new Error(`ASCII 串未终止: RVA 0x${rva.toString(16)}`);
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(exe[i]!);
  return s;
}

function put32(bytes: Uint8Array, p: number, value: number): number {
  bytes[p++] = value & 0xff;
  bytes[p++] = (value >>> 8) & 0xff;
  bytes[p++] = (value >>> 16) & 0xff;
  bytes[p++] = (value >>> 24) & 0xff;
  return p;
}

function putU32(bytes: Uint8Array, p: number, value: number): void {
  bytes[p] = value & 0xff;
  bytes[p + 1] = (value >>> 8) & 0xff;
  bytes[p + 2] = (value >>> 16) & 0xff;
  bytes[p + 3] = (value >>> 24) & 0xff;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function need(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`${label} 越界: offset=0x${offset.toString(16)} length=0x${length.toString(16)}`);
  }
}
