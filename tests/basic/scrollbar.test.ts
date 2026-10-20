import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';
import { scrollbarGeometry } from '../../src/vm86/shim/scrollbar';

function setup() {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId: 'ra2' });
  writeAsciiZ(memory, 0x20000, '#32770');
  const parent = callShim(
    shim,
    'USER32.DLL!CreateWindowExA',
    [0, 0x20000, 0, 0x10000000, 0, 0, 800, 600, 0, 0, 0, 0],
  ).eax;
  writeAsciiZ(memory, 0x20100, 'ScrollBar');
  const hwnd = callShim(shim, 'USER32.DLL!CreateWindowExA', [
    0,
    0x20100,
    0,
    0x50000001,
    100,
    100,
    20,
    160,
    parent,
    3,
    0,
    0,
  ]).eax;
  const send = (msg: number, w = 0, l = 0) => callShim(shim, 'USER32.DLL!SendMessageA', [hwnd, msg, w, l]).eax;
  const info = 0x20200;
  const setInfo = (mask: number, min: number, max: number, page: number, pos: number) => {
    [28, mask, min, max, page, pos, 0].forEach((v, i) => writeU32(memory, info + i * 4, v));
    return send(0xe9, 1, info);
  };
  return { memory, shim, parent, hwnd, info, send, setInfo };
}

describe('原生滚动条', () => {
  it('范围含末项，页长限制最大位置，GET 按掩码写回并保留其他字段', () => {
    const { memory, info, send, setInfo } = setup();
    expect(setInfo(7, 0, 9, 7, 99)).toBe(3);
    writeU32(memory, info + 4, 4);
    writeU32(memory, info + 8, 1234);
    expect(send(0xea, 0, info)).toBe(1);
    expect(readU32(memory, info + 20)).toBe(3);
    expect(readU32(memory, info + 8)).toBe(1234);
    expect(setInfo(2, 0, 0, 100, 0)).toBe(0);
    writeU32(memory, info + 4, 7);
    send(0xea, 0, info);
    expect(readU32(memory, info + 12)).toBe(9);
    expect(readU32(memory, info + 16)).toBe(10);
  });

  it('支持负范围与旧式 SBM_SETPOS，并拒绝无效结构大小', () => {
    const { memory, info, send, setInfo } = setup();
    setInfo(7, -10, 10, 2, 5);
    expect(send(0xe0, -20, 1)).toBe(5);
    expect(send(0xe1) | 0).toBe(-10);
    writeU32(memory, info, 16);
    expect(send(0xe9, 0, info)).toBe(0);
    expect(send(0xe1) | 0).toBe(-10);
  });

  it('箭头向父窗口发 WM_VSCROLL，携带滚动条 HWND', () => {
    const { memory, shim, parent, hwnd, send, setInfo } = setup();
    setInfo(7, 0, 9, 7, 0);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -4, 0x401000]);
    send(0x201, 1, (150 << 16) | 10);
    const callback = shim.inspectCallbackState()!;
    expect(callback).toMatchObject({ hwnd: parent, message: 0x115, callback: 0x401000 });
    const code = memory.read_memory(callback.trampoline, 23);
    const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
    expect(view.getUint32(4, true)).toBe(hwnd);
    expect(view.getUint32(9, true)).toBe(1); // SB_LINEDOWN
  });

  it('拇指随页长缩放，末位置到达轨道末端', () => {
    const state = { min: 0, max: 9, page: 7, pos: 3, trackPos: 3, disabled: 0 };
    const g = scrollbarGeometry(state, 160, 20);
    expect(g.thumb).toBe(84);
    expect(g.start + g.thumb).toBe(140);
  });

  it('壳页兄弟列表收到通知前即可读到更新位置，翻页使用可见行数', () => {
    const { memory, shim, parent, hwnd, send, setInfo } = setup();
    writeAsciiZ(memory, 0x20300, 'ListBox');
    const list = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      0x20300,
      0,
      0x50000000,
      20,
      100,
      80,
      160,
      parent,
      4,
      0,
      0,
    ]).eax;
    callShim(shim, 'USER32.DLL!SendMessageA', [list, 0x1a0, 0, 20]);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [list, -4, 0x402000]);
    setInfo(5, 0, 30, 0, 0);
    send(0x201, 1, (130 << 16) | 10);
    expect(send(0xe1)).toBe(8);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: list, message: 0x115 });
    send(0x201, 1, (150 << 16) | 10);
    expect(send(0xe1)).toBe(9);
    expect(shim.inspectCallbackState()).toMatchObject({ hwnd: list, message: 0x115 });
    expect(hwnd).not.toBe(list);
  });

  it('拖动拇指发送 32 位跟踪位置，松开后恢复原捕获窗口', () => {
    const { memory, shim, parent, hwnd, info, send, setInfo } = setup();
    setInfo(7, 0, 9, 7, 0);
    callShim(shim, 'USER32.DLL!SetCapture', [parent]);
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -4, 0x401000]);
    send(0x201, 1, (25 << 16) | 10);
    expect(callShim(shim, 'USER32.DLL!GetCapture', []).eax).toBe(hwnd);
    send(0x200, 1, (140 << 16) | 10);
    let callback = shim.inspectCallbackState()!;
    expect(readU32(memory, callback.trampoline + 9)).toBe((3 << 16) | 5);
    writeU32(memory, info + 4, 16);
    send(0xea, 0, info);
    expect(readU32(memory, info + 24)).toBe(3);
    send(0x202, 0, (140 << 16) | 10);
    callback = shim.inspectCallbackState()!;
    expect(readU32(memory, callback.trampoline + 9)).toBe((3 << 16) | 4);
    expect(callShim(shim, 'USER32.DLL!GetCapture', []).eax).toBe(parent);
  });
});
