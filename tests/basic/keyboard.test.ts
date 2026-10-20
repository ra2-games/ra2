import { describe, expect, it } from 'vitest';
import { keyNameText, mapVirtualKey, toAscii } from '../../src/vm86/shim/keyboard';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

describe('客体键盘转换', () => {
  it('字母、扫描码与左右修饰键按转换方向映射', () => {
    expect(mapVirtualKey(0x48, 0)).toBe(0x23);
    expect(mapVirtualKey(0x23, 1)).toBe(0x48);
    expect(mapVirtualKey(0x48, 2)).toBe(0x48);
    expect(mapVirtualKey(0x11, 0)).toBe(0x1d);
    expect(mapVirtualKey(0xa3, 4)).toBe(0xe01d);
    expect(mapVirtualKey(0xe01d, 1)).toBe(0x11);
    expect(mapVirtualKey(0xe01d, 3)).toBe(0xa3);
    expect(mapVirtualKey(0xff, 0)).toBe(0);
    expect(mapVirtualKey(0x48, 99)).toBe(0);
  });
  it('处理 Shift、CapsLock、Ctrl，功能键不生成字符', () => {
    const state = new Uint8Array(256);
    expect(toAscii(0x48, 0x23, state)).toEqual([0x68]);
    state[0x10] = 0x80;
    expect(toAscii(0x48, 0x23, state)).toEqual([0x48]);
    expect(toAscii(0x31, 0x02, state)).toEqual([0x21]);
    state[0x14] = 1;
    expect(toAscii(0x48, 0x23, state)).toEqual([0x68]);
    state[0x11] = 0x80;
    expect(toAscii(0x48, 0x23, state)).toEqual([8]);
    expect(toAscii(0x70, 0x3b, state)).toEqual([]);
    expect(toAscii(0x48, 0x8023, state)).toEqual([]);
  });
  it('从 GetKeyNameTextA 的 lParam 识别普通与扩展按键', () => {
    expect(keyNameText(0x001e0000)).toBe('A');
    expect(keyNameText(0x003f0000)).toBe('F5');
    expect(keyNameText(0x004b0000)).toBe('Num 4');
    expect(keyNameText(0x014b0000)).toBe('Left');
    expect(keyNameText(0x011d0000)).toBe('Right Ctrl');
    expect(keyNameText(0x00ff0000)).toBe('');
  });
  it('真实 shim 按目标容量写入 GetKeyNameTextA，未知键返回空名称', () => {
    const memory = createGuestMemory(),
      shim = createTestShim(memory);
    memory.write_memory([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa], 0x2000);
    expect(callShim(shim, 'USER32.DLL!GetKeyNameTextA', [0x011d0000, 0x2000, 6]).eax).toBe(5);
    expect([...memory.read_memory(0x2000, 6)]).toEqual([82, 105, 103, 104, 116, 0]);
    expect(callShim(shim, 'USER32.DLL!GetKeyNameTextA', [0x00ff0000, 0x2000, 6]).eax).toBe(0);
    expect([...memory.read_memory(0x2000, 6)]).toEqual([0, 105, 103, 104, 116, 0]);
    expect(callShim(shim, 'USER32.DLL!GetKeyNameTextA', [0x001e0000, 0, 6]).eax).toBe(0);
  });
  it('真实 shim 导入写回 WORD，不覆盖相邻内存', () => {
    const memory = createGuestMemory(),
      shim = createTestShim(memory);
    memory.write_memory([0xaa, 0xaa, 0xaa, 0xaa], 0x2000);
    expect(callShim(shim, 'USER32.DLL!MapVirtualKeyA', [0x48, 0]).eax).toBe(0x23);
    expect(callShim(shim, 'USER32.DLL!ToAscii', [0x48, 0x23, 0x1000, 0x2000, 0]).eax).toBe(1);
    expect([...memory.read_memory(0x2000, 4)]).toEqual([0x68, 0, 0xaa, 0xaa]);
    expect(callShim(shim, 'USER32.DLL!ToAscii', [0x70, 0x3b, 0x1000, 0x2000, 0]).eax).toBe(0);
    expect([...memory.read_memory(0x2000, 4)]).toEqual([0x68, 0, 0xaa, 0xaa]);
  });
  it('Tab 按创建顺序循环，跳过隐藏、禁用和非 TabStop 控件', () => {
    const memory = createGuestMemory(),
      shim = createTestShim(memory);
    writeAsciiZ(memory, 0x1000, 'Button');
    const make = (parent: number, style = 0x50010000, ex = 0) =>
      callShim(shim, 'USER32.DLL!CreateWindowExA', [ex, 0x1000, 0, style, 0, 0, 20, 20, parent, 0, 0, 0]).eax;
    const dialog = make(0),
      first = make(dialog);
    make(dialog, 0x40010000);
    make(dialog, 0x58010000);
    make(dialog, 0x50000000);
    const group = make(dialog, 0x50000000, 0x10000),
      nested = make(group);
    const last = make(dialog);
    const next = (start: number, previous = 0) =>
      callShim(shim, 'USER32.DLL!GetNextDlgTabItem', [dialog, start, previous]).eax;
    expect(next(first)).toBe(nested);
    expect(next(nested)).toBe(last);
    expect(next(last)).toBe(first);
    expect(next(first, 1)).toBe(last);
    expect(next(0)).toBe(0);
    callShim(shim, 'USER32.DLL!ShowWindow', [group, 0]);
    expect(next(first)).toBe(last);
  });
});
