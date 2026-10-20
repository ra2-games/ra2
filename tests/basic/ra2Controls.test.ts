import { describe, expect, it } from 'vitest';
import type { Win32Shim } from '../../src/games/win32Shim';
import type { VmFrame } from '../../src/vm86/win32';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeAsciiZ,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';

const MSG = 0x30_000;
let nextString = 0x20_000;

function createWindow(
  shim: Win32Shim,
  memory: FakeGuestMemory,
  className: string,
  style: number,
  rect: [number, number, number, number],
  parent = 0,
  id = 0,
): number {
  const classPointer = nextString;
  nextString += 0x100;
  writeAsciiZ(memory, classPointer, className);
  return callShim(shim, 'USER32.DLL!CreateWindowExA', [
    0,
    classPointer,
    0,
    style,
    rect[0],
    rect[1],
    rect[2],
    rect[3],
    parent,
    id,
    0,
    0,
  ]).eax;
}

function peek(shim: Win32Shim): number {
  return callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0, 0, 1]).eax;
}

describe('RA2 Westwood Gadget 消息路径', () => {
  it('pointer probes retain tap message coordinates when the cursor has moved before release', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const app = createWindow(shim, memory, 'Red Alert 2', 0x1000_0000, [0, 0, 800, 600]);
    const button = createWindow(shim, memory, 'Button', 0x5000_0000, [90, 90, 40, 40], app, 1684);
    const title = 0x35_000;
    writeAsciiZ(memory, title, 'GUI:SinglePlayer');
    callShim(shim, 'USER32.DLL!SetWindowTextA', [button, title]);
    shim.setCursorPosition(100, 100);
    shim.postMessage(0x0201, 1, (100 << 16) | 100);
    shim.setCursorPosition(105, 108);
    shim.postMessage(0x0202, 0, (100 << 16) | 100);
    expect(shim.inspectPointerState()).toMatchObject({
      x: 105,
      y: 108,
      lastMouseInputX: 100,
      lastMouseInputY: 100,
      lastMouseInputMessage: 0x0202,
      lastMouseHitControlId: 1684,
      lastMouseHitText: 'GUI:SinglePlayer',
    });
  });

  it('CharToOemBuffA 按显式长度复制 DBCS 字节并允许重叠缓冲区', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const source = 0x34_000;
    memory.write_memory(new Uint8Array([0x41, 0xa4, 0x40, 0x42, 0]), source);
    expect(callShim(shim, 'USER32.DLL!CharToOemBuffA', [source, source + 1, 4]).eax).toBe(1);
    expect(memory.read_memory(source + 1, 4)).toEqual(new Uint8Array([0x41, 0xa4, 0x40, 0x42]));
    expect(callShim(shim, 'USER32.DLL!CharToOemBuffA', [0, source, 4]).eax).toBe(0);
  });

  it('Skirmish 模板中的八套标准控件不产生宿主合成槽位', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, { gameId: 'ra2', onFrame: (frame) => frames.push(frame) });
    callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 320, 200, 16]);
    const desc = 0x32_000;
    const out = 0x32_100;
    writeU32(memory, desc, 108);
    writeU32(memory, desc + 4, 6);
    writeU32(memory, desc + 8, 200);
    writeU32(memory, desc + 12, 320);
    writeU32(memory, desc + 104, 0x200);
    callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);

    const root = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 320, 200]);
    for (let slot = 0; slot < 8; slot++) {
      const list = createWindow(shim, memory, 'ListBox', 0x5000_0151, [5, 5 + slot * 20, 100, 18], root, 1700 + slot);
      callShim(shim, 'USER32.DLL!SendMessageA', [list, 0x000f, 0, 0]);
    }
    expect(frames).toHaveLength(0);
  });

  it('Campaign 阵营 hover 先同步送对话框 WM_NCHITTEST，父 Gadget 仍保留普通 move/点按', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const app = createWindow(shim, memory, 'Red Alert 2', 0x1000_0000, [0, 0, 800, 600]);
    const dialog = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600], app);
    createWindow(shim, memory, 'Static', 0x5000_0007, [30, 20, 300, 100], dialog, 1770);
    // Attach a guest WndProc to the dialog to observe synchronously dispatched WM_NCHITTEST.
    callShim(shim, 'USER32.DLL!SetWindowLongA', [dialog, -4, 0x40_0000]);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'GUI:CampaignMenu';
    while (peek(shim)) {
      /* Drain initial window messages */
    }

    // Enter the insignia: synchronously dispatch WM_NCHITTEST (screen coordinates), then deliver a normal move to the parent Gadget on the next tick.
    shim.setCursorPosition(100, 50);
    shim.postMessage(0x0200, 0, (50 << 16) | 100);
    expect(peek(shim)).toBe(0);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: dialog, message: 0x0084 });
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(dialog);
    expect(readU32(memory, MSG + 4)).toBe(0x0200);
    expect(readU32(memory, MSG + 12)).toBe((50 << 16) | 100);
    expect(shim.inspectPointerState().campaignHoverDispatches).toBe(1);

    // Further movement within the same faction no longer synthesizes NCHITTEST; it only reaches the parent Gadget.
    shim.setCursorPosition(110, 55);
    shim.postMessage(0x0200, 0, (55 << 16) | 110);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(dialog);

    // Leave the insignia: the child-window boundary changes, synthesizing another NCHITTEST so the dialog stops the animation.
    shim.setCursorPosition(700, 500);
    shim.postMessage(0x0200, 0, (500 << 16) | 700);
    expect(peek(shim)).toBe(0);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: dialog, message: 0x0084 });
    expect(peek(shim)).toBe(1);
    expect(shim.inspectPointerState().campaignHoverDispatches).toBe(1);

    // Only re-entry produces the next insignia enter edge.
    shim.setCursorPosition(100, 50);
    shim.postMessage(0x0200, 0, (50 << 16) | 100);
    expect(peek(shim)).toBe(0);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: dialog, message: 0x0084 });
    expect(peek(shim)).toBe(1);
    expect(shim.inspectPointerState().campaignHoverDispatches).toBe(2);

    shim.postMessage(0x0201, 1, (50 << 16) | 100);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(dialog);
    expect(readU32(memory, MSG + 4)).toBe(0x0201);
  });

  it('ComboBox 闭合布局不覆盖已保存的 dropped rectangle', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0213, [53, 44, 151, 121], root, 0x4321);
    const droppedRect = 0x31_000;
    const windowRect = 0x31_100;

    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0153, -1, 19]); // selection = 19px
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0153, 0, 23]); // item = 23px
    callShim(shim, 'USER32.DLL!MoveWindow', [combo, 53, 44, 151, 121, 0]);
    // The second layout only aligns the control to its collapsed row; expanded height should remain 121.
    callShim(shim, 'USER32.DLL!MoveWindow', [combo, 133, 104, 151, 23, 0]);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0152, 0, droppedRect]).eax).toBe(1);
    expect([
      readU32(memory, droppedRect),
      readU32(memory, droppedRect + 4),
      readU32(memory, droppedRect + 8),
      readU32(memory, droppedRect + 12),
    ]).toEqual([133, 104, 284, 225]);

    // The persistent HWND still occupies one row, so hit testing must not obscure controls below.
    expect(callShim(shim, 'USER32.DLL!GetWindowRect', [combo, windowRect]).eax).toBe(1);
    expect(readU32(memory, windowRect + 12) - readU32(memory, windowRect + 4)).toBe(23);

    // A new full height updates the extent; subsequent collapsed SetWindowPos calls must not clear it.
    callShim(shim, 'USER32.DLL!SetWindowPos', [combo, 0, 140, 120, 151, 92, 0]);
    callShim(shim, 'USER32.DLL!SetWindowPos', [combo, 0, 140, 120, 151, 23, 0]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0152, 0, droppedRect]);
    expect(readU32(memory, droppedRect + 12) - readU32(memory, droppedRect + 4)).toBe(92);

    // Even if the layout requests less than the collapsed-row height, the window retains the selection-box height
    // and preserves the established expanded height (Wine/Win32 test_changesize semantics).
    callShim(shim, 'USER32.DLL!MoveWindow', [combo, 160, 130, 151, 10, 0]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0152, 0, droppedRect]);
    expect(readU32(memory, droppedRect + 12) - readU32(memory, droppedRect + 4)).toBe(92);
    callShim(shim, 'USER32.DLL!GetWindowRect', [combo, windowRect]);
    expect(readU32(memory, windowRect + 12) - readU32(memory, windowRect + 4)).toBe(23);

    // SWP_NOSIZE changes neither height.
    callShim(shim, 'USER32.DLL!SetWindowPos', [combo, 0, 160, 130, 0, 1, 0x0001]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0152, 0, droppedRect]);
    expect(readU32(memory, droppedRect + 12) - readU32(memory, droppedRect + 4)).toBe(92);
  });

  it('ComboBox 展开期间捕获鼠标，选择后释放并保持原目标', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0213, [133, 104, 151, 69], root, 0x4321);
    const none = nextString;
    nextString += 0x100;
    const easy = nextString;
    nextString += 0x100;
    writeAsciiZ(memory, none, 'None');
    writeAsciiZ(memory, easy, 'Easy Enemy');
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0143, 0, none]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0143, 0, easy]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0153, -1, 19]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0153, 0, 23]);

    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0202, 0, (5 << 16) | 145]);
    expect(callShim(shim, 'USER32.DLL!GetCapture').eax).toBe(combo);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0202, 0, (50 << 16) | 5]);
    expect(callShim(shim, 'USER32.DLL!GetCapture').eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0147, 0, 0]).eax).toBe(1);
  });

  it('RA2 下拉列表点击文字不展开，点击右侧三角才展开', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0213, [133, 104, 151, 23], root, 0x4321);
    while (peek(shim)) {
      /* 排空初始窗口消息 */
    }

    const click = (x: number, y: number) => {
      const point = (y << 16) | (x & 0xffff);
      shim.setCursorPosition(x, y);
      shim.postMessage(0x0201, 1, point);
      expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0201, 0x0201, 1]).eax).toBe(1);
      callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);
      shim.postMessage(0x0202, 0, point);
      expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0202, 0x0202, 1]).eax).toBe(1);
      callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);
    };

    click(160, 115); // 文字区
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(0);

    click(279, 115); // 右侧三角区
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(1);
  });

  it('ComboBox 再次点击收起时清除下拉高亮残影且不反转选择', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    const desc = 0x32_000;
    const out = 0x32_100;
    writeU32(memory, desc, 108);
    writeU32(memory, desc + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
    writeU32(memory, desc + 8, 600);
    writeU32(memory, desc + 12, 800);
    writeU32(memory, desc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const primary = readU32(memory, out);
    writeU32(memory, desc + 104, 0); // 当前 shell 的静态背景层
    const backgroundOut = 0x32_200;
    callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, backgroundOut, 0]);
    const background = readU32(memory, backgroundOut);

    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0213, [133, 104, 151, 69], root, 0x4321);
    const none = nextString;
    nextString += 0x100;
    const easy = nextString;
    nextString += 0x100;
    writeAsciiZ(memory, none, 'None');
    writeAsciiZ(memory, easy, 'Easy Enemy');
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0143, 0, none]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0143, 0, easy]);
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x014e, 1, 0]);

    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0202, 0, (5 << 16) | 145]);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(1);
    const pitch = readU32(memory, primary + 24);
    const staleHighlight = readU32(memory, primary + 44) + 127 * pitch + 133 * 2;
    const backgroundPixel = readU32(memory, background + 44) + 127 * readU32(memory, background + 24) + 133 * 2;
    memory.write_memory([0x78, 0x56], backgroundPixel);
    memory.write_memory([0x34, 0x12], staleHighlight);

    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0202, 0, (5 << 16) | 145]);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0147, 0, 0]).eax).toBe(1);
    expect(memory.read_memory(staleHighlight, 2)).toEqual(new Uint8Array([0x78, 0x56]));
  });

  it('EnableWindow 同步通知自绘控件并收口禁用子树的 capture/focus', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0213, [350, 78, 118, 23], root, 0x4321);
    const callback = 0x5e_e460;
    callShim(shim, 'USER32.DLL!SetWindowLongA', [root, -4, callback]);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [combo, -4, callback]);
    callShim(shim, 'USER32.DLL!SetCapture', [combo]);
    callShim(shim, 'USER32.DLL!SetFocus', [combo]);

    const stack = 0x31_000;
    writeU32(memory, stack, 0x1234_5678);
    expect(callShim(shim, 'USER32.DLL!EnableWindow', [root, 0], stack).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!GetCapture').eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!GetFocus').eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!IsWindowEnabled', [root]).eax).toBe(0);
    expect(shim.inspectCallbackState()).toMatchObject({
      hwnd: root,
      message: 0x000a,
    });

    // Then disable the ComboBox directly and verify that the custom trampoline contains
    // WM_CANCELMODE followed by WM_ENABLE.
    callShim(shim, 'USER32.DLL!EnableWindow', [root, 1]);
    writeU32(memory, stack, 0x1234_5678);
    callShim(shim, 'USER32.DLL!EnableWindow', [combo, 0], stack);
    const state = shim.inspectCallbackState();
    expect(state).toMatchObject({ hwnd: combo, message: 0x000a, callback });
    const bridge = memory.read_memory(state!.trampoline, 160);
    const hasPush = (value: number) =>
      bridge.some((byte, index) => byte === 0x68 && readU32(memory, state!.trampoline + index + 1) === value);
    expect(hasPush(0x001f)).toBe(true);
    expect(hasPush(0x000a)).toBe(true);
  });

  it.each([
    ['ra2', 'Red Alert 2', 0x73_75a0],
    ['yr', "Yuri's Revenge", 0x00f0_1000],
  ] as const)(
    'delivers %s WM_CREATE to the registered top-level WndProc before CreateWindowExA returns',
    (gameId, name, callback) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory, { gameId });
      const className = nextString;
      nextString += 0x100;
      const windowClass = nextString;
      nextString += 0x100;
      writeAsciiZ(memory, className, name);
      writeU32(memory, windowClass + 4, callback);
      writeU32(memory, windowClass + 36, className);
      callShim(shim, 'USER32.DLL!RegisterClassA', [windowClass]);

      const stack = 0x31_000;
      writeU32(memory, stack, 0x1234_5678);
      const result = callShim(
        shim,
        'USER32.DLL!CreateWindowExA',
        [0, className, 0, 0x1000_0000, 0, 0, 800, 600, 0, 0, 0x400000, 0],
        stack,
      );

      expect(result.eax).toBe(0);
      expect(shim.inspectCallbackState()).toMatchObject({ hwnd: 0x2000, message: 0x0001, callback });
      const createStruct = 0x22_0000 + 4096 - 48;
      expect(readU32(memory, createStruct + 20)).toBe(800);
      expect(readU32(memory, createStruct + 16)).toBe(600);
      expect(readU32(memory, createStruct + 40)).toBe(className);
    },
  );

  it('ComboDropWin 创建前同步投递带 lpCreateParams 的 WM_CREATE', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const className = nextString;
    nextString += 0x100;
    const windowClass = nextString;
    nextString += 0x100;
    writeAsciiZ(memory, className, 'ComboDropWin');
    writeU32(memory, windowClass + 4, 0x5e_ad20); // WNDCLASSA.lpfnWndProc
    writeU32(memory, windowClass + 36, className); // WNDCLASSA.lpszClassName
    callShim(shim, 'USER32.DLL!RegisterClassA', [windowClass]);

    const stack = 0x31_000;
    writeU32(memory, stack, 0x1234_5678);
    const result = callShim(
      shim,
      'USER32.DLL!CreateWindowExA',
      [0, className, 0, 0x4000_0000, 350, 102, 118, 161, 0x2018, 0, 0x400000, 0x201d],
      stack,
    );

    const callback = shim.inspectCallbackState();
    const createStruct = 0x22_0000 + 4096 - 48;
    expect(result.eax).toBe(0); // The trampoline returns the HWND to the API only after the guest callback returns
    expect(callback).toMatchObject({ hwnd: 0x2000, message: 0x0001, callback: 0x5e_ad20 });
    expect(readU32(memory, createStruct)).toBe(0x201d); // lpCreateParams
    expect(readU32(memory, createStruct + 12)).toBe(0x2018); // hwndParent
    expect(readU32(memory, createStruct + 16)).toBe(161); // cy
    expect(readU32(memory, createStruct + 20)).toBe(118); // cx
    expect(readU32(memory, createStruct + 32)).toBe(0x4000_0000); // style
    expect(readU32(memory, createStruct + 40)).toBe(className); // lpszClass
  });

  it('RA2 ComboBox 仅在显示且启用时命中，隐藏文字区不展开且禁用控件交给 Gadget', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const app = createWindow(shim, memory, 'Red Alert 2', 0x1000_0000, [10, 20, 800, 600]);
    const shell = createWindow(shim, memory, '#32770', 0x5000_0040, [5, 7, 800, 600], app);
    const layout = createWindow(shim, memory, '#32770', 0x5000_0040, [3, 4, 800, 600], shell);
    const hiddenCombo = createWindow(shim, memory, 'ComboBox', 0x4000_0213, [133, 104, 151, 23], layout, 0x7abb);
    createWindow(shim, memory, 'ComboBox', 0x5800_0213, [133, 150, 151, 23], layout, 0x7abc);
    while (peek(shim)) {
      /* Drain initial WM_MOVE/WM_SIZE/WM_ACTIVATEAPP */
    }

    expect(callShim(shim, 'USER32.DLL!IsWindowVisible', [hiddenCombo]).eax).toBe(0);
    shim.postMessage(0x0201, 1, (146 << 16) | 218);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(hiddenCombo);

    callShim(shim, 'USER32.DLL!ShowWindow', [hiddenCombo, 5]);
    while (peek(shim)) {
      /* Drain repaint messages generated by showing the window */
    }
    shim.postMessage(0x0201, 1, (146 << 16) | 218);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(hiddenCombo);
    expect(readU32(memory, MSG + 4)).toBe(0x0201);
    expect(readU32(memory, MSG + 8)).toBe(1);
    expect(readU32(memory, MSG + 12)).toBe((11 << 16) | 67);
    expect(shim.getHostInputDispatchCount()).toBe(0);

    shim.postMessage(0x0201, 1, (192 << 16) | 218);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(shell);
    expect(readU32(memory, MSG + 12)).toBe((165 << 16) | 203);
  });

  it('Skirmish 可见玩家名 ListBox 保持原生窗口命中并获得键盘焦点', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const layout = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600], root);
    const playerName = createWindow(shim, memory, 'ListBox', 0x5000_0110, [134, 79, 149, 19], layout, 1696);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'Any Shell Page';
    while (peek(shim)) {
      /* Drain initial messages */
    }

    shim.postMessage(0x0201, 1, (88 << 16) | 208);

    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(playerName);
    expect(readU32(memory, MSG + 4)).toBe(0x0201);
    expect(readU32(memory, MSG + 12)).toBe((9 << 16) | 74);
    expect(shim.getHostInputDispatchCount()).toBe(0);

    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);
    shim.postMessage(0x0102, 'A'.charCodeAt(0), 0x001e_0001);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(playerName);
    expect(readU32(memory, MSG + 4)).toBe(0x0102);
  });

  it('Skirmish 可见下拉弹窗保持原生窗口命中', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const layout = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600], root);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0000, [350, 150, 118, 23], layout);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x5000_0000, [350, 102, 118, 161], layout);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'Any Shell Page';
    while (peek(shim)) {
      /* Drain initial messages */
    }
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!SetCapture', [combo]);
    while (peek(shim)) {
      /* 排空展开组合框产生的 WM_PAINT，下面只检查鼠标消息目标 */
    }

    shim.postMessage(0x0201, 1, (159 << 16) | 409);

    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(popup);
    expect(readU32(memory, MSG + 12)).toBe((57 << 16) | 59);
  });

  it('ComboDropWin 鍦ㄦ寜涓嬪悗闅愯棌鏃朵繚鎸佹姇閫掔洰鏍囷紝涓嶈寮€涓嬫柟 ComboBox', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0000, [350, 150, 118, 23], root);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x5000_0000, [350, 102, 118, 161], root);
    while (peek(shim)) {
      /* Drain initial WM_MOVE/WM_SIZE/WM_ACTIVATEAPP */
    }

    const point = (159 << 16) | 409;
    shim.setCursorPosition(409, 159);
    shim.postMessage(0x0201, 1, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(popup);
    expect(peek(shim)).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);

    callShim(shim, 'USER32.DLL!ShowWindow', [popup, 0]);
    shim.postMessage(0x0202, 0, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(popup);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0202, 0x0202, 1]).eax).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);

    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(0);
  });

  it('顶层 ComboDropWin 使用屏幕坐标并覆盖下方 ComboBox', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const app = createWindow(shim, memory, 'Red Alert 2', 0x1000_0000, [20, 30, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0000, [350, 150, 118, 23], app);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x9000_0000, [350, 102, 118, 161], app);
    while (peek(shim)) {
      /* 排空初始消息 */
    }
    callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!SetCapture', [combo]);
    while (peek(shim)) {
      /* 排空展开组合框产生的 WM_PAINT */
    }

    const windowRect = 0x31_000;
    callShim(shim, 'USER32.DLL!GetWindowRect', [popup, windowRect]);
    expect([
      readU32(memory, windowRect),
      readU32(memory, windowRect + 4),
      readU32(memory, windowRect + 8),
      readU32(memory, windowRect + 12),
    ]).toEqual([350, 102, 468, 263]);

    const point = (159 << 16) | 409;
    shim.setCursorPosition(409, 159);
    shim.postMessage(0x0201, 1, point);

    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(popup);
    expect(peek(shim)).toBe(1);
    expect(readU32(memory, MSG)).toBe(popup);
    expect(readU32(memory, MSG + 12)).toBe((57 << 16) | 59);
  });

  it('ComboBox 按下后弹层出现时，抬起仍投给原 ComboBox', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0000, [350, 150, 118, 23], root);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x4000_0000, [350, 102, 118, 161], root);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'Any Shell Page';
    while (peek(shim)) {
      /* 排空初始消息 */
    }

    const point = (159 << 16) | 409;
    shim.setCursorPosition(409, 159);
    shim.postMessage(0x0201, 1, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(combo);

    // 模拟 ComboBox 按下处理期间游戏显示真实弹层。
    callShim(shim, 'USER32.DLL!ShowWindow', [popup, 1]);
    while (peek(shim)) {
      /* 排空弹层显示产生的 WM_PAINT */
    }
    shim.postMessage(0x0202, 0, point);

    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(combo);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0202, 0x0202, 1]).eax).toBe(1);
    expect(readU32(memory, MSG)).toBe(combo);
    expect(readU32(memory, MSG + 12)).toBe((9 << 16) | 59);
  });

  it('隐藏自绘 ComboBox 按下后弹层出现时，抬起仍投给原 shell 页', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const layout = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600], root);
    createWindow(shim, memory, 'ComboBox', 0x4000_0213, [350, 150, 118, 23], layout);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x4000_0000, [350, 102, 118, 161], root);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'Any Shell Page';
    while (peek(shim)) {
      /* 排空初始消息 */
    }

    // 三角区仍由 shell Gadget 处理；即使按下后弹层马上出现，抬起也不能改投弹层。
    const point = (159 << 16) | 459;
    shim.setCursorPosition(459, 159);
    shim.postMessage(0x0201, 1, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(layout);

    callShim(shim, 'USER32.DLL!ShowWindow', [popup, 1]);
    while (peek(shim)) {
      /* 排空弹层显示产生的 WM_PAINT */
    }
    shim.postMessage(0x0202, 0, point);

    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(layout);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0202, 0x0202, 1]).eax).toBe(1);
    expect(readU32(memory, MSG)).toBe(layout);
    expect(readU32(memory, MSG + 12)).toBe((159 << 16) | 459);
  });

  it('隐藏自绘 ComboBox 点击文字区不交给 Gadget 展开', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x1000_0040, [0, 0, 800, 600]);
    const layout = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600], root);
    const combo = createWindow(shim, memory, 'ComboBox', 0x4000_0213, [350, 150, 118, 23], layout);
    createWindow(shim, memory, 'ComboDropWin', 0x4000_0000, [350, 102, 118, 161], root);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'Any Shell Page';
    while (peek(shim)) {
      /* 排空初始消息 */
    }

    const point = (159 << 16) | 370;
    shim.setCursorPosition(370, 159);
    shim.postMessage(0x0201, 1, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(combo);
    expect(peek(shim)).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);

    shim.postMessage(0x0202, 0, point);
    expect(shim.inspectHostInputTrace().at(-1)?.hwnd).toBe(combo);
    expect(peek(shim)).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(0);
  });

  it('ComboDropWin destruction before mouseup does not fall through', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const root = createWindow(shim, memory, '#32770', 0x5000_0040, [0, 0, 800, 600]);
    const combo = createWindow(shim, memory, 'ComboBox', 0x5000_0000, [350, 150, 118, 23], root);
    const popup = createWindow(shim, memory, 'ComboDropWin', 0x5000_0000, [350, 102, 118, 161], root);
    while (peek(shim)) {
      /* Drain initial WM_MOVE/WM_SIZE/WM_ACTIVATEAPP */
    }

    const point = (159 << 16) | 409;
    shim.setCursorPosition(409, 159);
    shim.postMessage(0x0201, 1, point);
    expect(peek(shim)).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);
    callShim(shim, 'USER32.DLL!DestroyWindow', [popup]);

    shim.postMessage(0x0202, 0, point);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, 0, 0x0202, 0x0202, 1]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!SendMessageA', [combo, 0x0157, 0, 0]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!GetAsyncKeyState', [1]).eax).toBe(0);
  });
});
