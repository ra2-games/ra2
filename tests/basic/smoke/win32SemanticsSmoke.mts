import assert from 'node:assert/strict';
import type { PeImport } from '../../../src/vm86/pe';
import type { GuestMemory, Win32Call } from '../../../src/vm86/win32';
import { Win32Shim } from '../../../src/games/win32Shim';

class TestMemory implements GuestMemory {
  private readonly bytes = new Uint8Array(32 * 1024 * 1024);

  read_memory(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }

  write_memory(bytes: Uint8Array | number[], offset: number): void {
    this.bytes.set(bytes, offset);
  }
}

const memory = new TestMemory();
const shim = new Win32Shim(memory, { moduleName: 'game.exe' });
let stringTop = 0x20_000;
const cstr = (value: string): number => {
  const bytes = new TextEncoder().encode(`${value}\0`);
  const pointer = stringTop;
  stringTop += bytes.length;
  memory.write_memory(bytes, pointer);
  return pointer;
};
const call = (key: string, args: number[]): Win32Call => {
  const [dll, name] = key.split('!');
  const imported: PeImport = { id: 1, dll: dll!, name: name!, key, slot: 0, stub: 0, argBytes: 0 };
  return { imported, stack: 0x1000, args };
};
const dispatch = (key: string, args: number[]): number => {
  const result = shim.dispatch(call(key, args));
  assert.ok(result, `${key} 应已实现`);
  return result.eax >>> 0;
};
const createWindow = (
  className: string,
  style: number,
  x: number,
  y: number,
  width: number,
  height: number,
  parent = 0,
  id = 0,
  exStyle = 0,
): number =>
  dispatch('USER32.DLL!CreateWindowExA', [
    exStyle,
    cstr(className),
    cstr(''),
    style >>> 0,
    x,
    y,
    width,
    height,
    parent,
    id,
    0,
    0,
  ]);

const WS_VISIBLE = 0x1000_0000;
const WS_CHILD = 0x4000_0000;
const WS_DISABLED = 0x0800_0000;
const parent = createWindow('TestParent', WS_VISIBLE, 0, 0, 100, 100);
assert.equal(dispatch('USER32.DLL!GetFocus', []), parent, '首个可见顶层窗口应取得初始 focus');

const disabled = createWindow('Button', WS_CHILD | WS_VISIBLE | WS_DISABLED, 10, 10, 40, 40, parent, 100);
const hidden = createWindow('Static', WS_CHILD, 10, 10, 40, 40, parent, 101);
createWindow('Button', WS_CHILD | WS_VISIBLE, 0, 0, 10, 10, disabled, 102);

assert.equal(
  dispatch('USER32.DLL!GetDlgItem', [parent, 100]),
  disabled,
  'CreateWindow child id 应可由 GetDlgItem 找回',
);
assert.equal(dispatch('USER32.DLL!GetDlgItem', [parent, 999]), 0, '不存在的 child 不得伪造 HWND');
assert.equal(
  dispatch('USER32.DLL!ChildWindowFromPoint', [parent, 15, 15]),
  hidden,
  'ChildWindowFromPoint 不应自行跳过隐藏 child',
);
assert.equal(
  dispatch('USER32.DLL!ChildWindowFromPointEx', [parent, 15, 15, 0x0001]),
  disabled,
  'CWP_SKIPINVISIBLE 只跳过隐藏 child，仍可返回 disabled child',
);
assert.equal(
  dispatch('USER32.DLL!ChildWindowFromPointEx', [parent, 15, 15, 0x0003]),
  parent,
  '同时跳过隐藏和 disabled 后应返回 parent，且不得递归返回 grandchild',
);

assert.equal(dispatch('USER32.DLL!SetFocus', [disabled]), 0, 'disabled window 不得取得 focus');
const previousFocus = dispatch('USER32.DLL!SetFocus', [hidden]);
assert.equal(previousFocus, parent);
assert.equal(dispatch('USER32.DLL!GetFocus', []), hidden);
assert.equal(dispatch('USER32.DLL!SetFocus', [0]), hidden, 'SetFocus(NULL) 返回旧 focus');
assert.equal(dispatch('USER32.DLL!GetFocus', []), 0, 'SetFocus(NULL) 必须真正清除 focus');

const combo = createWindow('ComboBox', WS_CHILD | WS_VISIBLE | 0x0003, 50, 10, 45, 80, parent, 200);
const first = cstr('Allied');
const second = cstr('Soviet');
assert.equal(dispatch('USER32.DLL!SendMessageA', [combo, 0x0143, 0, first]), 0, 'CB_ADDSTRING #0');
assert.equal(dispatch('USER32.DLL!SendDlgItemMessageA', [parent, 200, 0x0143, 0, second]), 1, 'CB_ADDSTRING #1');
assert.equal(dispatch('USER32.DLL!SendMessageA', [combo, 0x0146, 0, 0]), 2, 'CB_GETCOUNT');
assert.equal(dispatch('USER32.DLL!SendMessageA', [combo, 0x014e, 1, 0]), 1, 'CB_SETCURSEL');
assert.equal(dispatch('USER32.DLL!SendMessageA', [combo, 0x0147, 0, 0]), 1, 'CB_GETCURSEL');

const edit = createWindow('Edit', WS_CHILD | WS_VISIBLE, 10, 60, 50, 20, parent, 201);
dispatch('USER32.DLL!SetFocus', [edit]);
dispatch('USER32.DLL!SendMessageA', [edit, 0x0102, 0x41, 0]); // WM_CHAR 'A'
const textBuffer = 0x21_000;
assert.equal(dispatch('USER32.DLL!GetWindowTextA', [edit, textBuffer, 8]), 1);
assert.equal(memory.read_memory(textBuffer, 2)[0], 0x41, 'Edit 默认过程应接收 WM_CHAR');

const dc = dispatch('USER32.DLL!GetDC', [parent]);
const whiteBrush = dispatch('GDI32.DLL!GetStockObject', [0]);
const brush = dispatch('GDI32.DLL!CreateSolidBrush', [0x0012_3456]);
assert.equal(dispatch('GDI32.DLL!SelectObject', [dc, brush]), whiteBrush, '选择 HBRUSH 返回同类型旧对象');
assert.equal(dispatch('GDI32.DLL!DeleteObject', [brush]), 0, '选入 DC 的对象不可删除');
assert.equal(dispatch('GDI32.DLL!SelectObject', [dc, whiteBrush]), brush);
assert.equal(dispatch('GDI32.DLL!DeleteObject', [brush]), 1, '换出 DC 后可以删除 HBRUSH');
assert.equal(dispatch('GDI32.DLL!DeleteObject', [whiteBrush]), 0, 'stock brush 不可删除');
assert.equal(dispatch('GDI32.DLL!SetTextColor', [dc, 0x0001_0203]), 0);
assert.equal(dispatch('GDI32.DLL!GetTextColor', [dc]), 0x0001_0203);
assert.equal(dispatch('GDI32.DLL!SetBkMode', [dc, 1]), 2);
assert.equal(dispatch('GDI32.DLL!GetBkMode', [dc]), 1);
assert.equal(dispatch('USER32.DLL!ReleaseDC', [parent, dc]), 1);

console.log('Win32 semantics smoke: child lookup/hit-test + focus + default controls + GDI objects OK');
