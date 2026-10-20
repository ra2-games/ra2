/** shim/text.ts pure-function unit tests: narrow-string decoding, path normalization, default MessageBox buttons, etc. */
import { describe, expect, it } from 'vitest';
import {
  decodeAnsi,
  decodeGuestNarrow,
  defaultMessageBoxResult,
  fourCc,
  readBytesU32,
  win32ModuleOf,
  WIN32_DDRAW,
  WIN32_DDRAW_COM,
  WIN32_DPLAYX,
  WIN32_DPLAYX_COM,
  WIN32_DSOUND,
  WIN32_DSOUND_COM,
  WIN32_KERNEL32,
  WIN32_OLE32,
  WIN32_USER32,
} from '../../src/vm86/shim/text';
import { normalizeGuestPath } from '../../src/vm86/paths';

describe('decodeGuestNarrow', () => {
  it('ASCII 无损', () => {
    expect(decodeGuestNarrow(new Uint8Array([0x48, 0x69]))).toBe('Hi');
  });
  it('GBK 双字节解码（客体窄字符串环境）', () => {
    expect(decodeGuestNarrow(new Uint8Array([0xd6, 0xd0]))).toBe('中');
  });
});

describe('decodeAnsi', () => {
  it('Big5 双字节解码（繁体游戏 ANSI）', () => {
    expect(decodeAnsi(new Uint8Array([0xa4, 0xa4]))).toBe('中');
  });
});

describe('normalizeGuestPath', () => {
  it('折叠盘符/反斜杠/大小写', () => {
    expect(normalizeGuestPath('C:\\GAME\\Save\\LABEL.SAV')).toBe('game/save/label.sav');
    expect(normalizeGuestPath('D:\\king01.bmp')).toBe('king01.bmp');
    expect(normalizeGuestPath('\\GAME\\')).toBe('game');
  });
  it('处理 . 与 .. 段', () => {
    expect(normalizeGuestPath('C:\\GAME\\..\\x.txt')).toBe('x.txt');
    expect(normalizeGuestPath('C:\\.\\GAME\\.\\y.bin')).toBe('game/y.bin');
  });
  it('空路径归一空串', () => {
    expect(normalizeGuestPath('C:\\')).toBe('');
    expect(normalizeGuestPath('')).toBe('');
  });
});

describe('defaultMessageBoxResult', () => {
  it('按按钮组与 DEFBUTTON 位选默认按钮', () => {
    expect(defaultMessageBoxResult(0)).toBe(1); // MB_OK → IDOK
    expect(defaultMessageBoxResult(1)).toBe(1); // MB_OKCANCEL defaults to IDOK
    expect(defaultMessageBoxResult(1 | 0x100)).toBe(2); // DEFBUTTON2 → IDCANCEL
    expect(defaultMessageBoxResult(3)).toBe(6); // MB_YESNOCANCEL defaults to IDYES
    expect(defaultMessageBoxResult(3 | 0x200)).toBe(2); // DEFBUTTON3 → IDCANCEL
    expect(defaultMessageBoxResult(4)).toBe(6); // MB_YESNO → IDYES
    expect(defaultMessageBoxResult(5)).toBe(4); // MB_RETRYCANCEL → IDRETRY
  });
});

describe('fourCc / readBytesU32', () => {
  it('小端四字节标签', () => {
    expect(fourCc('RIFF')).toBe(0x4646_4952);
    expect(fourCc('WAVE')).toBe(0x4556_4157);
  });
  it('小端 u32 读取', () => {
    expect(readBytesU32(new Uint8Array([0x78, 0x56, 0x34, 0x12]), 0)).toBe(0x1234_5678);
  });
});

describe('win32ModuleOf', () => {
  it('DLL 名映射到数值标签（COM 命名空间优先）', () => {
    expect(win32ModuleOf('KERNEL32.DLL')).toBe(WIN32_KERNEL32);
    expect(win32ModuleOf('user32.dll')).toBe(WIN32_USER32);
    expect(win32ModuleOf('DDRAW.COM')).toBe(WIN32_DDRAW_COM);
    expect(win32ModuleOf('DDRAW.DLL')).toBe(WIN32_DDRAW);
    expect(win32ModuleOf('DSOUND.COM')).toBe(WIN32_DSOUND_COM);
    expect(win32ModuleOf('DSOUND.DLL')).toBe(WIN32_DSOUND);
    expect(win32ModuleOf('DPLAYX.COM')).toBe(WIN32_DPLAYX_COM);
    expect(win32ModuleOf('DPLAYX.DLL')).toBe(WIN32_DPLAYX);
    expect(win32ModuleOf('OLE32.DLL')).toBe(WIN32_OLE32);
    expect(win32ModuleOf('COMDLG32.DLL')).toBe(-1);
  });
});
