/**
 * Win32Shim message-queue unit tests with fake guest memory, without v86: postMessage/GetMessageA/PeekMessageA dequeue semantics, WM_MOUSEMOVE coalescing, initial window-message injection at the first message API, and DispatchMessageA/SendMessageA callback trampoline rewriting.
 */
import { describe, expect, it } from 'vitest';
import {
  GUEST_CALLBACK_OWNERS,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
  HYPERCALL_PEEK_BUDGET,
} from '../../src/vm86/pe';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeAsciiZ,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';
import type { Win32Shim } from '../../src/games/win32Shim';

const WNDCLASS = 0x0010_0000;
const CLASS_NAME = 0x0010_0100;
const MSG = 0x0010_0200;
const DIALOG_TEMPLATE = 0x0010_1000;
const STACK = 0x006f_ff00; // Near the fake stack top
const WNDPROC = 0x0040_1000; // Fake WndProc address (this test does not execute guest code)

const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
const WM_ACTIVATEAPP = 0x001c;
const WM_PAINT = 0x000f;
const WM_QUIT = 0x0012;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_USER = 0x0400;

/** Register a window class, create a window, and return its hwnd. */
function createWindow(shim: Win32Shim, memory: FakeGuestMemory, classStyle = 0): number {
  writeAsciiZ(memory, CLASS_NAME, 'TESTCLS');
  memory.write_memory(new Uint8Array(40), WNDCLASS);
  writeU32(memory, WNDCLASS, classStyle);
  writeU32(memory, WNDCLASS + 4, WNDPROC);
  writeU32(memory, WNDCLASS + 36, CLASS_NAME);
  expect(callShim(shim, 'USER32.DLL!RegisterClassA', [WNDCLASS]).eax).toBe(1);
  const hwnd = callShim(shim, 'USER32.DLL!CreateWindowExA', [
    0,
    CLASS_NAME,
    CLASS_NAME,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    0,
    0,
  ]).eax;
  expect(hwnd).not.toBe(0);
  return hwnd;
}

function getMessage(shim: Win32Shim): { eax: number; delayMs?: number } {
  return callShim(shim, 'USER32.DLL!GetMessageA', [MSG, 0, 0, 0]);
}

describe('消息队列', () => {
  it('exposes visible control text and list items without hidden ancestors or mutable state', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    writeAsciiZ(memory, CLASS_NAME, 'ListBox');
    writeAsciiZ(memory, CLASS_NAME + 64, 'Results');
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME,
      CLASS_NAME + 64,
      0x50000000,
      0,
      0,
      100,
      100,
      parent,
      42,
      0,
      0,
    ]).eax;
    writeAsciiZ(memory, CLASS_NAME + 128, 'Player 1');
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x180, 0, CLASS_NAME + 128]);
    expect(shim.inspectVisibleControlContent()).toEqual([]);
    callShim(shim, 'USER32.DLL!ShowWindow', [parent, 5]);
    const content = shim.inspectVisibleControlContent();
    expect(content).toContainEqual({ id: 42, className: 'listbox', text: 'Results', items: ['Player 1'] });
    content.find((control) => control.id === 42)!.items.push('not native');
    expect(shim.inspectVisibleControlContent().find((control) => control.id === 42)!.items).toEqual(['Player 1']);
    callShim(shim, 'USER32.DLL!ShowWindow', [child, 0]);
    expect(shim.inspectVisibleControlContent().some((control) => control.id === 42)).toBe(false);
  });

  it.each(['ra2', 'yr', undefined] as const)(
    'copies registered native display labels for %s without replacing template text',
    (gameId) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory, { gameId });
      writeAsciiZ(memory, CLASS_NAME, 'Static');
      writeAsciiZ(memory, CLASS_NAME + 64, 'GUI:Blank');
      const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME,
        CLASS_NAME + 64,
        0x50000000,
        0,
        0,
        100,
        20,
        0,
        1041,
        0,
        0,
      ]).eax;
      const defaultProc = callShim(shim, 'USER32.DLL!SetWindowLongA', [child, -4, WNDPROC]).eax;
      const label = '玩家 🏆 0';
      const pointer = CLASS_NAME + 128;
      for (let i = 0; i <= label.length; i++) {
        const unit = i === label.length ? 0 : label.charCodeAt(i);
        memory.write_memory([unit & 255, unit >>> 8], pointer + i * 2);
      }
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x4b2, 0, pointer], STACK);
      const content = () => shim.inspectVisibleControlContent().find((item) => item.id === 1041)!;
      expect(content().text).toBe('GUI:Blank');
      expect(content().displayText).toBe(gameId ? label : undefined);
      memory.write_memory([0, 0], pointer);
      expect(content().displayText).toBe(gameId ? label : undefined);
      callShim(shim, 'USER32.DLL!ShowWindow', [child, 0]);
      expect(shim.inspectVisibleControlContent()).toEqual([]);
      callShim(shim, 'USER32.DLL!ShowWindow', [child, 5]);
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x4b2, 0, 0], STACK);
      expect(content().displayText).toBe(gameId ? '' : undefined);
      memory.write_memory(new Uint8Array(8192).fill(65), pointer);
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x4b2, 0, pointer], STACK);
      expect(content().displayText).toBeUndefined();
      callShim(shim, 'USER32.DLL!SetWindowLongA', [child, -4, defaultProc]);
      callShim(shim, 'USER32.DLL!DestroyWindow', [child]);
      expect(shim.inspectVisibleControlContent()).toEqual([]);
    },
  );

  it('内置控件 subclass 可取得并恢复非零默认 WndProc', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeAsciiZ(memory, CLASS_NAME, 'Button');
    const button = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME,
      0,
      0x5000_0000,
      0,
      0,
      80,
      20,
      0,
      0,
      0,
      0,
    ]).eax;
    const defaultProc = callShim(shim, 'USER32.DLL!GetWindowLongA', [button, -4]).eax;
    expect(defaultProc).not.toBe(0);
    expect(callShim(shim, 'USER32.DLL!SetWindowLongA', [button, -4, WNDPROC]).eax).toBe(defaultProc);
    expect(callShim(shim, 'USER32.DLL!SetWindowLongA', [button, -4, defaultProc]).eax).toBe(WNDPROC);
    expect(callShim(shim, 'USER32.DLL!GetWindowLongA', [button, -4]).eax).toBe(defaultProc);
  });

  it('CreateDialogIndirectParamA 解析标准 DLGTEMPLATE 子控件', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const bytes = new Uint8Array(96);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x1000_0000, true); // WS_VISIBLE
    view.setUint32(4, 0, true); // exStyle
    view.setUint16(8, 1, true); // cdit
    view.setInt16(10, 0, true);
    view.setInt16(12, 0, true);
    view.setInt16(14, 100, true);
    view.setInt16(16, 100, true);
    // Three empty UTF-16 strings for menu/class/title; the item starts at DWORD-aligned offset 24.
    view.setUint32(24, 0x5000_0000, true); // WS_CHILD | WS_VISIBLE
    view.setUint32(28, 0, true);
    view.setInt16(32, 10, true);
    view.setInt16(34, 10, true);
    view.setInt16(36, 50, true);
    view.setInt16(38, 14, true);
    view.setUint16(40, 0x06d1, true);
    view.setUint16(42, 0xffff, true);
    view.setUint16(44, 0x0080, true); // Button
    const title = 'Continue';
    for (let i = 0; i < title.length; i++) view.setUint16(46 + i * 2, title.charCodeAt(i), true);
    view.setUint16(46 + title.length * 2, 0, true);
    view.setUint16(48 + title.length * 2, 0, true); // creationDataSize
    memory.write_memory(bytes, DIALOG_TEMPLATE);

    const parent = callShim(shim, 'USER32.DLL!CreateDialogIndirectParamA', [0, DIALOG_TEMPLATE, 0, 0, 0]).eax;
    const child = shim.inspectWindowState().find((window) => window.parent === parent && window.id === 0x06d1);
    expect(child).toMatchObject({ className: 'Button', text: 'Continue' });
  });

  it('BS_AUTORADIOBUTTON 点击时选中自身并清除同组按钮', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const createRadio = (id: number, style: number) =>
      callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x40,
        0,
        0x5000_0009 | style,
        0,
        0,
        40,
        20,
        parent,
        id,
        0,
        0,
      ]).eax;
    const first = createRadio(101, 0x0002_0000); // WS_GROUP | BS_AUTORADIOBUTTON
    const second = createRadio(102, 0);

    callShim(shim, 'USER32.DLL!SendMessageA', [first, 0x00f1, 1, 0]); // BM_SETCHECK
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [first, 0x00f0, 0, 0]).eax).toBe(1);
    callShim(shim, 'USER32.DLL!SendMessageA', [second, 0x00f5, 0, 0]); // BM_CLICK
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [first, 0x00f0, 0, 0]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [second, 0x00f0, 0, 0]).eax).toBe(1);
  });

  it('Button 按下后捕获鼠标，抬起时释放', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const createButton = (x: number, id: number) =>
      callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x40,
        0,
        0x5000_0000,
        x,
        0,
        40,
        20,
        parent,
        id,
        0,
        0,
      ]).eax;
    const first = createButton(0, 101);
    callShim(shim, 'USER32.DLL!SendMessageA', [first, WM_LBUTTONDOWN, 1, (10 << 16) | 10]);
    expect(callShim(shim, 'USER32.DLL!GetCapture', []).eax).toBe(first);
    callShim(shim, 'USER32.DLL!SendMessageA', [first, 0x0202, 0, (10 << 16) | 60]);
    expect(callShim(shim, 'USER32.DLL!GetCapture', []).eax).toBe(0);
  });

  it('首个消息 API 注入 WM_MOVE/WM_SIZE/WM_ACTIVATEAPP 初始三连', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    for (const expected of [WM_MOVE, WM_SIZE, WM_ACTIVATEAPP]) {
      expect(getMessage(shim).eax).toBe(1);
      expect(readU32(memory, MSG)).toBe(hwnd);
      expect(readU32(memory, MSG + 4)).toBe(expected);
    }
  });

  it('WM_SIZE 携带 800×600 客户区尺寸', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    createWindow(shim, memory);
    getMessage(shim); // WM_MOVE
    getMessage(shim); // WM_SIZE
    expect(readU32(memory, MSG + 12)).toBe((600 << 16) | 800);
  });

  it('host postMessage 在主泵就绪前缓存、就绪后按序投递', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    shim.postMessage(WM_USER, 0x11, 0); // Before readiness -> pendingHostMessages
    getMessage(shim); // WM_MOVE (flush the cache now)
    getMessage(shim); // WM_SIZE
    getMessage(shim); // WM_ACTIVATEAPP
    expect(getMessage(shim).eax).toBe(1);
    expect(readU32(memory, MSG + 4)).toBe(WM_USER);
    expect(readU32(memory, MSG + 8)).toBe(0x11);
    expect(readU32(memory, MSG)).toBe(hwnd);
  });

  it('WM_QUIT 让 GetMessageA 返回 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    createWindow(shim, memory);
    // PostQuitMessage queues directly, before the initial three messages injected only by the first GetMessageA.
    callShim(shim, 'USER32.DLL!PostQuitMessage', [7]);
    expect(getMessage(shim).eax).toBe(0);
    expect(readU32(memory, MSG + 4)).toBe(WM_QUIT);
    expect(readU32(memory, MSG + 8)).toBe(7); // nExitCode
  });

  it('连续 WM_MOUSEMOVE 只保留最新一条', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    createWindow(shim, memory);
    // Posting before the main pump is ready goes to pendingHostMessages; once ready, merge into the main queue for GetMessage dequeue.
    // After readiness, mouse messages dispatch synchronously at PeekMessage boundaries instead of passing through MSG dequeue.
    shim.postMessage(WM_MOUSEMOVE, 0, 1);
    shim.postMessage(WM_MOUSEMOVE, 0, 2);
    getMessage(shim);
    getMessage(shim);
    getMessage(shim); // Drain the initial three messages
    expect(getMessage(shim).eax).toBe(1);
    expect(readU32(memory, MSG + 12)).toBe(2); // Latest lParam
    // The queue is empty; without timers, GetMessageA suspends through delayMs
    const empty = getMessage(shim);
    expect(empty.eax).toBe(1);
    expect(empty.delayMs).toBeGreaterThan(0);
  });

  it('仅为声明 CS_DBLCLKS 的窗口类生成双击消息', () => {
    const run = (classStyle: number) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory, { gameId: 'ra2' });
      createWindow(shim, memory, classStyle);
      for (let i = 0; i < 3; i++) getMessage(shim);
      shim.postMessage(WM_LBUTTONDOWN, 1, 0x000a_000a);
      shim.postMessage(WM_LBUTTONUP, 0, 0x000a_000a);
      shim.postMessage(WM_LBUTTONDOWN, 1, 0x000a_000a);
      getMessage(shim);
      getMessage(shim);
      getMessage(shim);
      return readU32(memory, MSG + 4);
    };
    expect(run(0)).toBe(WM_LBUTTONDOWN);
    expect(run(0x0008)).toBe(WM_LBUTTONDBLCLK);
  });

  it('PeekMessageA：PM_NOREMOVE 保留、PM_REMOVE 出队', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    createWindow(shim, memory);
    // The first Peek injects the initial three messages; drain them with PM_REMOVE.
    for (let i = 0; i < 3; i++) {
      expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(1);
    }
    shim.postMessage(WM_USER, 5, 0);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 0]).eax).toBe(1); // Do not remove
    expect(readU32(memory, MSG + 4)).toBe(WM_USER);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(1); // Remove
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(0); // Already empty
    expect(readU32(memory, HYPERCALL_PEEK_BUDGET)).toBeGreaterThan(0);
    shim.postMessage(WM_USER, 6, 0);
    expect(readU32(memory, HYPERCALL_PEEK_BUDGET)).toBe(0); // A new message forces the next call back to the host
  });

  it('鼠标消息出队时恢复按键与 Ctrl 键态，后续消息再清除', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    createWindow(shim, memory);
    for (let i = 0; i < 3; i++) getMessage(shim); // Drain the initial three messages

    shim.setKeyState(0x11, true);
    shim.setKeyState(0xa2, true);
    shim.setKeyState(0x01, true);
    shim.postMessage(WM_LBUTTONDOWN, 0x0008 | 0x0001, 0); // MK_CONTROL | MK_LBUTTON
    // The Worker may receive physical mouse/Ctrl releases before the guest retrieves messages; the queued timeline must retain the pressed state.
    shim.setKeyState(0x11, false);
    shim.setKeyState(0xa2, false);
    shim.setKeyState(0x01, false);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0x01]).eax).toBe(0x8000);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0x11]).eax).toBe(0x8000);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0xa2]).eax).toBe(0x8000);
    const mouseMessage = MSG + 0x40;
    memory.write_memory(memory.read_memory(MSG, 28).slice(), mouseMessage);

    shim.postMessage(WM_LBUTTONUP, 0, 0);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0x01]).eax).toBe(0);
    shim.postMessage(WM_KEYUP, 0x11, 0);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0x11]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [0xa2]).eax).toBe(0);
    // Even if the pump has already peeked at a later keyup, dispatching an earlier Ctrl+mouse message must restore Ctrl.
    callShim(shim, 'USER32.DLL!DispatchMessageA', [mouseMessage], STACK);
    expect(callShim(shim, 'USER32.DLL!GetKeyState', [0x11]).eax).toBe(0x8000);
    expect(callShim(shim, 'USER32.DLL!GetKeyState', [0xa2]).eax).toBe(0x8000);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG], STACK);
    expect(callShim(shim, 'USER32.DLL!GetKeyState', [0x11]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!GetKeyState', [0xa2]).eax).toBe(0);
  });

  it('隐藏的焦点控件不截获战场键盘消息', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const parent = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_0000,
      0,
      0,
      40,
      20,
      parent,
      101,
      0,
      0,
    ]).eax;
    const inputState = shim as unknown as { captureWindow: number; pressedButton: number };
    inputState.captureWindow = child;
    inputState.pressedButton = child;
    expect(callShim(shim, 'USER32.DLL!SetFocus', [child]).eax).toBe(0);
    for (let i = 0; i < 3; i++) getMessage(shim); // Drain the initial three messages

    callShim(shim, 'USER32.DLL!ShowWindow', [child, 0]); // Hide the old focused control during a shell-page switch
    expect(inputState.captureWindow).toBe(0);
    expect(inputState.pressedButton).toBe(0);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [child, -16, 0x5000_0000]);
    inputState.captureWindow = child;
    inputState.pressedButton = child;
    callShim(shim, 'USER32.DLL!SetWindowLongA', [child, -16, 0x4000_0000]);
    expect(inputState.captureWindow).toBe(0);
    expect(inputState.pressedButton).toBe(0);
    shim.postMessage(WM_KEYDOWN, 0x11, 0x001d_0001);
    do {
      expect(getMessage(shim).eax).toBe(1);
    } while (readU32(memory, MSG + 4) !== WM_KEYDOWN);
    expect(readU32(memory, MSG)).toBe(parent);
    expect(readU32(memory, MSG + 4)).toBe(WM_KEYDOWN);
    expect(readU32(memory, MSG + 8)).toBe(0x11);
  });

  it('RA2 Ctrl 消息始终进入顶层输入窗口而不被可见焦点控件截获', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const parent = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_0000,
      0,
      0,
      40,
      20,
      parent,
      101,
      0,
      0,
    ]).eax;
    callShim(shim, 'USER32.DLL!SetFocus', [child]);
    for (let i = 0; i < 3; i++) getMessage(shim);

    shim.postMessage(WM_KEYDOWN, 0x11, 0x001d_0001);
    do {
      expect(getMessage(shim).eax).toBe(1);
    } while (readU32(memory, MSG + 4) !== WM_KEYDOWN);
    expect(readU32(memory, MSG)).toBe(parent);
    expect(readU32(memory, MSG + 8)).toBe(0x11);
  });

  it('关闭地图选择页后恢复底层遭遇战页标题', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      gameId: 'ra2',
    });
    const root = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [root, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, '#32770');
    writeAsciiZ(memory, CLASS_NAME + 0x80, 'Static');
    const shellState = shim as unknown as {
      shellPageTitle: string;
      invalidatedWindows: Set<number>;
    };
    const makePage = (title: string, address: number) => {
      writeAsciiZ(memory, address, title);
      const page = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x40,
        0,
        0x5000_0000,
        0,
        0,
        800,
        600,
        root,
        0,
        0,
        0,
      ]).eax;
      const titleWindow = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x80,
        address,
        0x5000_0000,
        635,
        3,
        163,
        17,
        page,
        1684,
        0,
        0,
      ]).eax;
      // CreateDialogIndirectParamA writes this state when parsing title control id=1684.
      shellState.shellPageTitle = title;
      return { page, titleWindow };
    };

    const skirmish = makePage('GUI:SkirmishGame', CLASS_NAME + 0xc0);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');
    callShim(shim, 'USER32.DLL!ShowWindow', [skirmish.page, 0]);
    const chooseMap = makePage('GUI:ChooseMap', CLASS_NAME + 0x100);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    callShim(shim, 'USER32.DLL!DestroyWindow', [chooseMap.page]);
    callShim(shim, 'USER32.DLL!ShowWindow', [skirmish.page, 1]);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');
    expect(shellState.invalidatedWindows.has(skirmish.page)).toBe(true);
    expect(shellState.invalidatedWindows.has(skirmish.titleWindow)).toBe(true);
  });

  it('RA2 同时存在 shell 页时只允许最上层页面绘制', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [root, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, '#32770');
    writeAsciiZ(memory, CLASS_NAME + 0x80, 'Static');
    const shellState = shim as unknown as {
      activeShellPage: number;
      invalidatedWindows: Set<number>;
      messages: Array<{ hwnd: number; message: number }>;
      isActiveShellWindow(hwnd: number): boolean;
    };
    const makePage = (title: string, address: number) => {
      writeAsciiZ(memory, address, title);
      const page = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x40,
        0,
        0x5000_0000,
        0,
        0,
        800,
        600,
        root,
        0,
        0,
        0,
      ]).eax;
      const titleWindow = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME + 0x80,
        address,
        0x5000_0000,
        635,
        3,
        163,
        17,
        page,
        1684,
        0,
        0,
      ]).eax;
      return { page, titleWindow };
    };

    const skirmish = makePage('GUI:SkirmishGame', CLASS_NAME + 0xc0);
    callShim(shim, 'USER32.DLL!InvalidateRect', [skirmish.page, 0, 0]);
    expect(shellState.invalidatedWindows.has(skirmish.page)).toBe(true);

    const chooseMap = makePage('GUI:ChooseMap', CLASS_NAME + 0x100);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');
    expect(shellState.isActiveShellWindow(skirmish.page)).toBe(false);
    expect(shellState.isActiveShellWindow(skirmish.titleWindow)).toBe(false);
    expect(shellState.isActiveShellWindow(chooseMap.page)).toBe(true);
    expect(shellState.invalidatedWindows.has(skirmish.page)).toBe(false);
    expect(
      shellState.messages.some(
        (message) =>
          message.message === WM_PAINT && (message.hwnd === skirmish.page || message.hwnd === skirmish.titleWindow),
      ),
    ).toBe(false);

    // Hiding the title control must not deactivate a visible topmost page; reread the title when it becomes visible again.
    callShim(shim, 'USER32.DLL!ShowWindow', [chooseMap.titleWindow, 0]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('');
    callShim(shim, 'USER32.DLL!ShowWindow', [chooseMap.titleWindow, 1]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    // The page-root caption is not the shell title control and must not overwrite shellPageTitle.
    writeAsciiZ(memory, CLASS_NAME + 0x180, 'DialogCaption');
    callShim(shim, 'USER32.DLL!SetWindowTextA', [chooseMap.page, CLASS_NAME + 0x180]);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    callShim(shim, 'USER32.DLL!DestroyWindow', [chooseMap.titleWindow]);
    expect(shellState.activeShellPage).toBe(skirmish.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');

    const rebuiltTitle = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x80,
      CLASS_NAME + 0x100,
      0x5000_0000,
      635,
      3,
      163,
      17,
      chooseMap.page,
      1684,
      0,
      0,
    ]).eax;
    expect(rebuiltTitle).not.toBe(0);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    // Showing a page in the middle of the z-order must not overtake ChooseMap while it remains on top.
    callShim(shim, 'USER32.DLL!SetWindowLongA', [skirmish.page, -16, 0x4000_0000]);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [skirmish.page, -16, 0x5000_0000]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');
    callShim(shim, 'USER32.DLL!SetWindowLongA', [skirmish.page, -16, 0x4000_0000]);
    callShim(shim, 'USER32.DLL!SetWindowPos', [skirmish.page, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0040]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    callShim(shim, 'USER32.DLL!BringWindowToTop', [skirmish.page]);
    expect(shellState.activeShellPage).toBe(skirmish.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');

    // Raising an existing visible page must also update activeShellPage.
    callShim(shim, 'USER32.DLL!SetWindowPos', [chooseMap.page, 0, 0, 0, 0, 0, 0x0001 | 0x0002]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    // SWP_HIDEWINDOW/SWP_SHOWWINDOW must synchronize local WS_VISIBLE and page fallback.
    callShim(shim, 'USER32.DLL!SetWindowPos', [chooseMap.page, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0080]);
    expect(shellState.activeShellPage).toBe(skirmish.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');
    callShim(shim, 'USER32.DLL!SetWindowPos', [chooseMap.page, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    // Directly changing WS_VISIBLE through GWL_STYLE uses the same page synchronization path.
    callShim(shim, 'USER32.DLL!SetWindowLongA', [chooseMap.page, -16, 0x4000_0000]);
    expect(shellState.activeShellPage).toBe(skirmish.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');
    callShim(shim, 'USER32.DLL!SetWindowLongA', [chooseMap.page, -16, 0x5000_0000]);
    expect(shellState.activeShellPage).toBe(chooseMap.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:ChooseMap');

    callShim(shim, 'USER32.DLL!DestroyWindow', [chooseMap.page]);
    expect(shellState.activeShellPage).toBe(skirmish.page);
    expect(shim.inspectShellPageTitle()).toBe('GUI:SkirmishGame');
    expect(shellState.isActiveShellWindow(skirmish.page)).toBe(true);
    expect(shellState.invalidatedWindows.has(skirmish.page)).toBe(true);
    expect(shellState.invalidatedWindows.has(skirmish.titleWindow)).toBe(true);
  });

  it('战场期销毁普通控件不触发 shell 页全量同步', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [root, -16, 0x1000_0000]);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const button = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_0000,
      0,
      0,
      40,
      20,
      root,
      101,
      0,
      0,
    ]).eax;
    writeAsciiZ(memory, CLASS_NAME + 0x40, '#32770');
    writeAsciiZ(memory, CLASS_NAME + 0x80, 'Static');
    writeAsciiZ(memory, CLASS_NAME + 0x1c0, 'GUI:HiddenPage');
    const hiddenPage = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x4000_0000,
      0,
      0,
      800,
      600,
      root,
      0,
      0,
      0,
    ]).eax;
    const hiddenTitle = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x80,
      CLASS_NAME + 0x1c0,
      0x5000_0000,
      635,
      3,
      163,
      17,
      hiddenPage,
      1684,
      0,
      0,
    ]).eax;
    expect(hiddenPage).not.toBe(0);
    expect(hiddenTitle).not.toBe(0);
    const shellState = shim as unknown as {
      activeShellPage: number;
      synchronizeShellPage: (refreshTitle?: boolean) => void;
    };
    let synchronizeCalls = 0;
    const originalSynchronize = shellState.synchronizeShellPage.bind(shim);
    shellState.synchronizeShellPage = (refreshTitle = false) => {
      synchronizeCalls++;
      originalSynchronize(refreshTitle);
    };

    callShim(shim, 'USER32.DLL!DestroyWindow', [button]);
    expect(synchronizeCalls).toBe(0);
    expect(shellState.activeShellPage).toBe(0);
    callShim(shim, 'USER32.DLL!DestroyWindow', [hiddenPage]);
    expect(synchronizeCalls).toBe(0);
    expect(shellState.activeShellPage).toBe(0);
  });

  it('GetCursorPos 共享镜像随 host 坐标更新', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(readU32(memory, HYPERCALL_CURSOR_X)).toBe(400);
    expect(readU32(memory, HYPERCALL_CURSOR_Y)).toBe(300);
    shim.setCursorPosition(123, 456);
    expect(readU32(memory, HYPERCALL_CURSOR_X)).toBe(123);
    expect(readU32(memory, HYPERCALL_CURSOR_Y)).toBe(456);
  });
});

describe('回调跳板（DispatchMessageA / SendMessageA）', () => {
  it('ListBox 按下改变选择并通知一次，仅转发抬起时不重复通知', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'ListBox');
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_0151,
      0,
      0,
      100,
      48,
      parent,
      42,
      0,
      0,
    ]).eax;
    for (let index = 0; index < 3; index++) {
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0180, 0, 0]);
    }
    callShim(shim, 'USER32.DLL!SendMessageA', [child, WM_LBUTTONDOWN, 1, (20 << 16) | 5], STACK);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0188, 0, 0]).eax).toBe(1);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: parent, message: 0x0111 });

    const defaultProc = callShim(shim, 'USER32.DLL!GetWindowLongA', [child, -4]).eax;
    // NewListBox handles presses itself and delegates only releases to the default procedure; mouse position must not change selection again.
    writeU32(memory, STACK, 0x1234_5678);
    callShim(shim, 'USER32.DLL!CallWindowProcA', [defaultProc, child, WM_LBUTTONUP, 0, 5], STACK);
    expect(readU32(memory, STACK)).toBe(0x1234_5678);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0188, 0, 0]).eax).toBe(1);
  });

  it('ListBox 滚动：WM_VSCROLL/LB_SETTOPINDEX 移动顶部条目并保持 GETITEMRECT 偏移', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'ListBox');
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_0151,
      0,
      0,
      100,
      64,
      parent,
      42,
      0,
      0,
    ]).eax;
    const itemText = CLASS_NAME + 0x80;
    for (let index = 0; index < 20; index++) {
      writeAsciiZ(memory, itemText, `map-${index}`);
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0180, 0, itemText]);
    }
    const getTop = () => callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x018e, 0, 0]).eax;
    expect(getTop()).toBe(0);

    // LB_SETTOPINDEX: GETTOPINDEX returns the same value, and item rectangles reflect the scroll offset (visible row y=0).
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0197, 7, 0]);
    expect(getTop()).toBe(7);
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0198, 7, STACK]);
    expect(readU32(memory, STACK)).toBe(0);
    expect(readU32(memory, STACK + 12)).toBe(16);

    // Out-of-range settings return LB_ERR without changing the top index.
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0197, 20, 0]).eax).toBe(-1);
    expect(getTop()).toBe(7);

    // WM_VSCROLL: one line, one page (64/16 = 4 rows), bottom, then wheel back three rows.
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0115, 1, 0]);
    expect(getTop()).toBe(8);
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0115, 3, 0]);
    expect(getTop()).toBe(12);
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0115, 7, 0]);
    expect(getTop()).toBe(19);
    callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x020a, (120 << 16) >>> 0, 0]);
    expect(getTop()).toBe(16);

    // After deleting items, clamp the top index to the valid range.
    for (let index = 0; index < 18; index++) {
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x0182, 0, 0]);
    }
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x018b, 0, 0]).eax).toBe(2);
    expect(getTop()).toBe(1);
  });

  it('嵌套菜单中 DestroyWindow 在自身回调返回后立即回收窗口', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    callShim(shim, 'USER32.DLL!SendMessageA', [parent, WM_USER, 0, 0], STACK);
    const outer = shim.inspectCallbackState()!;
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(1);

    for (let cycle = 0; cycle < 3; cycle++) {
      const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        CLASS_NAME,
        0,
        0x5000_0000,
        0,
        0,
        20,
        100,
        parent,
        42,
        0,
        0,
      ]).eax;
      callShim(shim, 'USER32.DLL!DestroyWindow', [child], STACK + 0x80);
      const destroy = shim.inspectCallbackState()!;
      expect(destroy.message).toBe(0x0002); // WM_DESTROY
      expect(callShim(shim, 'USER32.DLL!GetWindowLongA', [child, -16]).eax).toBe(0x5000_0000);

      // Fake memory does not execute trampolines: release only the destruction callback slot; the outer modal menu remains active.
      writeU32(memory, GUEST_CALLBACK_OWNERS + destroy.depth * 4, 0);
      writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 1);
      expect(callShim(shim, 'USER32.DLL!GetWindowLongA', [child, -16]).eax).toBe(0);
      expect(readU32(memory, GUEST_CALLBACK_OWNERS + outer.depth * 4)).not.toBe(0);
      expect(shim.inspectWindowState().filter((window) => window.parent === parent)).toHaveLength(0);
    }
  });

  it('owner-draw Button 的默认过程向父窗口发送 WM_DRAWITEM', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const parent = createWindow(shim, memory);
    writeAsciiZ(memory, CLASS_NAME + 0x40, 'Button');
    const button = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME + 0x40,
      0,
      0x5000_000b,
      0,
      0,
      80,
      20,
      parent,
      1733,
      0,
      0,
    ]).eax;
    writeU32(memory, STACK, 0x1234_5678);
    callShim(shim, 'USER32.DLL!DefWindowProcA', [button, WM_PAINT, 0, 0], STACK);

    expect(readU32(memory, STACK)).toBe(0x0022_0000);
    const drawItem = 0x0022_0000 + 4096 - 48;
    expect(readU32(memory, drawItem)).toBe(4); // ODT_BUTTON
    expect(readU32(memory, drawItem + 4)).toBe(1733);
    expect(readU32(memory, drawItem + 12)).toBe(1); // ODA_DRAWENTIRE
    expect(readU32(memory, drawItem + 20)).toBe(button);
    expect(readU32(memory, drawItem + 32)).toBe(0);
    expect(readU32(memory, drawItem + 40)).toBe(20);
  });

  it('DispatchMessageA 把栈上返回地址改写为 trampoline 并生成桥代码', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    getMessage(shim); // WM_MOVE dequeued (MSG filled)
    writeU32(memory, STACK, 0x0040_2000); // Fake return address
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(0);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG], STACK);
    // The return address points to a separate bridge; the callback is counted as active before the bridge executes.
    expect(readU32(memory, STACK)).toBe(0x0022_0000);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(1);
    const state = shim.inspectCallbackState();
    expect(state).not.toBeNull();
    expect(state!.hwnd).toBe(hwnd);
    expect(state!.message).toBe(WM_MOVE);
    expect(state!.callback).toBe(WNDPROC);
    expect(state!.originalReturn).toBe(0x0040_2000);
  });

  it('SendMessageA 走同一跳板路径', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    writeU32(memory, STACK, 0x0040_3000);
    callShim(shim, 'USER32.DLL!SendMessageA', [hwnd, WM_USER, 1, 2], STACK);
    expect(readU32(memory, STACK)).toBe(0x0022_0000);
    const state = shim.inspectCallbackState();
    expect(state!.message).toBe(WM_USER);
    expect(state!.originalReturn).toBe(0x0040_3000);
  });
});

describe('SetTimer / KillTimer', () => {
  it('keeps empty PeekMessage nonblocking while a tooltip timer is far from expiry', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    for (let i = 0; i < 3; i++) callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]);

    callShim(shim, 'USER32.DLL!SetTimer', [hwnd, 7, 1000, 0]);
    const longTimerPeek = callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]);
    expect(longTimerPeek.eax).toBe(0);
    expect(longTimerPeek.delayMs).toBeUndefined();

    callShim(shim, 'USER32.DLL!KillTimer', [hwnd, 7]);
    callShim(shim, 'USER32.DLL!SetTimer', [hwnd, 8, 10, 0]);
    const imminentTimerPeek = callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]);
    expect(imminentTimerPeek.eax).toBe(0);
    expect(imminentTimerPeek.delayMs).toBeGreaterThan(0);
    expect(imminentTimerPeek.delayMs).toBeLessThanOrEqual(10);
  });

  it('登记与注销', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const hwnd = createWindow(shim, memory);
    expect(callShim(shim, 'USER32.DLL!SetTimer', [hwnd, 7, 100, 0]).eax).toBe(7);
    expect(callShim(shim, 'USER32.DLL!KillTimer', [hwnd, 7]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!KillTimer', [hwnd, 7]).eax).toBe(0);
  });
});
