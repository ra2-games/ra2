import { describe, expect, it } from 'vitest';
import { HYPERCALL_CALLBACK_DEPTH } from '../../src/vm86/pe';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

const CLASS_NAME = 0x100000;
const MSG = 0x100100;
const PAINT = 0x100200;
const WM_PAINT = 0x000f;

function setup() {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  writeAsciiZ(memory, CLASS_NAME, 'ListBox');
  const hwnd = callShim(shim, 'USER32.DLL!CreateWindowExA', [
    0,
    CLASS_NAME,
    0,
    0x50000151,
    0,
    0,
    197,
    262,
    0,
    0,
    0,
    0,
  ]).eax;
  const peekPaint = () => callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, hwnd, WM_PAINT, WM_PAINT, 1]).eax;
  return { memory, shim, hwnd, peekPaint };
}

describe('绘制更新区与消息队列', () => {
  it('父窗口隐藏时 ShowWindow 仍返回子控件自己的旧可见状态', () => {
    const { shim, hwnd: parent } = setup();
    callShim(shim, 'USER32.DLL!ShowWindow', [parent, 0]);
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME,
      0,
      0x50000151,
      0,
      0,
      100,
      20,
      parent,
      42,
      0,
      0,
    ]).eax;
    expect(callShim(shim, 'USER32.DLL!IsWindowVisible', [child]).eax).toBe(0);

    // Temporarily hide the control during initialization; callers restore it based on prior state. Hidden ancestors must not change the return value.
    expect(callShim(shim, 'USER32.DLL!ShowWindow', [child, 0]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!ShowWindow', [child, 0]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!ShowWindow', [child, 5]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!ShowWindow', [child, 5]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!IsWindowVisible', [child]).eax).toBe(0);

    callShim(shim, 'USER32.DLL!ShowWindow', [parent, 5]);
    expect(callShim(shim, 'USER32.DLL!IsWindowVisible', [child]).eax).toBe(1);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, child, WM_PAINT, WM_PAINT, 1]).eax).toBe(1);
  });

  it.each(['自身', '父窗口'])('%s 隐藏期间修改控件不产生绘制消息，重新显示后才重绘', (hidden) => {
    const { shim, hwnd: parent } = setup();
    const child = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      CLASS_NAME,
      0,
      0x50000151,
      0,
      0,
      100,
      20,
      parent,
      42,
      0,
      0,
    ]).eax;
    const target = hidden === '自身' ? child : parent;
    const peek = () => callShim(shim, 'USER32.DLL!PeekMessageA', [MSG, child, WM_PAINT, WM_PAINT, 1]).eax;
    for (let cycle = 0; cycle < 2; cycle++) {
      callShim(shim, 'USER32.DLL!InvalidateRect', [child, 0, 0]);
      callShim(shim, 'USER32.DLL!ShowWindow', [target, 0]);
      callShim(shim, 'USER32.DLL!SendMessageA', [child, 0x180, 0, 0]); // LB_ADDSTRING
      callShim(shim, 'USER32.DLL!InvalidateRect', [child, 0, 0]);
      callShim(shim, 'USER32.DLL!UpdateWindow', [child]);
      expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [child, 0, 0]).eax).toBe(0);
      expect(peek()).toBe(0);

      callShim(shim, 'USER32.DLL!ShowWindow', [target, 5]);
      expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [child, 0, 0]).eax).toBe(1);
      expect(peek()).toBe(1);
      expect(peek()).toBe(0);
    }
  });

  it.each(['ValidateRect', 'BeginPaint'])('%s 完成同步绘制后取消旧的系统 WM_PAINT', (api) => {
    const { shim, hwnd, peekPaint } = setup();
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(1);
    callShim(shim, `USER32.DLL!${api}`, [hwnd, api === 'BeginPaint' ? PAINT : 0]);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(0);
    expect(peekPaint()).toBe(0);
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    expect(peekPaint()).toBe(1);
    expect(peekPaint()).toBe(0);
    if (api === 'BeginPaint') callShim(shim, 'USER32.DLL!EndPaint', [hwnd, PAINT]);
  });

  it('验证更新区不删除程序主动 PostMessage 的 WM_PAINT', () => {
    const { memory, shim, hwnd, peekPaint } = setup();
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    callShim(shim, 'USER32.DLL!PostMessageA', [hwnd, WM_PAINT, 123, 456]);
    callShim(shim, 'USER32.DLL!ValidateRect', [hwnd, 0]);
    expect(peekPaint()).toBe(1);
    expect(readU32(memory, MSG + 8)).toBe(123);
    expect(readU32(memory, MSG + 12)).toBe(456);
    expect(peekPaint()).toBe(0);
  });

  it('客体回调可查询更新区，验证后再次失效不会被旧回调清掉', () => {
    const { memory, shim, hwnd, peekPaint } = setup();
    callShim(shim, 'USER32.DLL!SetWindowLongA', [hwnd, -4, 0x401000]);
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    callShim(shim, 'USER32.DLL!UpdateWindow', [hwnd], 0x6fff00);
    // Fake memory does not execute trampolines; explicitly simulate callback entry and exit.
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 1);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(1);
    callShim(shim, 'USER32.DLL!ValidateRect', [hwnd, 0]);
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 0);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(1);
    expect(peekPaint()).toBe(1);
    expect(peekPaint()).toBe(0);
  });

  it('自绘回调尚未退出时的重复失效会保留下一轮 WM_PAINT', () => {
    const { memory, shim, hwnd, peekPaint } = setup();
    callShim(shim, 'USER32.DLL!SetWindowLongA', [hwnd, -4, 0x401000]);
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    expect(peekPaint()).toBe(1);
    callShim(shim, 'USER32.DLL!DispatchMessageA', [MSG]);

    // Fake memory does not execute guest trampolines; explicitly represent continued execution inside the preceding WM_PAINT callback.
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 1);
    callShim(shim, 'USER32.DLL!InvalidateRect', [hwnd, 0, 0]);
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 0);

    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(1);
    expect(peekPaint()).toBe(1);
  });

  it('默认 ListBox 返回各行矩形及选中状态', () => {
    const { memory, shim, hwnd } = setup();
    const send = (message: number, w = 0, l = 0) =>
      callShim(shim, 'USER32.DLL!SendMessageA', [hwnd, message, w, l]).eax;
    send(0x180);
    send(0x180); // LB_ADDSTRING
    send(0x1a0, 0, 19); // LB_SETITEMHEIGHT
    send(0x186, 1); // LB_SETCURSEL
    expect(send(0x187, 0)).toBe(0);
    expect(send(0x187, 1)).toBe(1);
    expect(send(0x18e)).toBe(0);
    expect(send(0x198, 1, PAINT)).not.toBe(-1);
    expect([0, 4, 8, 12].map((offset) => readU32(memory, PAINT + offset))).toEqual([0, 19, 197, 38]);
  });

  it('ListBox 自定义窗口过程的选中消息同步到宿主状态', () => {
    const { shim, hwnd } = setup();
    const send = (message: number, w = 0, l = 0) =>
      callShim(shim, 'USER32.DLL!SendMessageA', [hwnd, message, w, l]).eax;
    send(0x180);
    send(0x180); // LB_ADDSTRING
    expect(callShim(shim, 'USER32.DLL!SetWindowLongA', [hwnd, -4, 0x0040_1000]).eax).not.toBe(0);
    callShim(shim, 'USER32.DLL!ValidateRect', [hwnd, 0]);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(0);

    send(0x186, 1); // LB_SETCURSEL
    send(0x185, 0, 0); // LB_SETSEL(FALSE, 0)
    send(0x185, 1, 1); // LB_SETSEL(TRUE, 1)

    expect(shim.inspectControlItems().find((control) => control.hwnd === hwnd)?.selection).toBe(1);
    expect(callShim(shim, 'USER32.DLL!GetUpdateRect', [hwnd, 0, 0]).eax).toBe(1);
  });
});
