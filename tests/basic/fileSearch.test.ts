import { describe, expect, it, vi } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { OverlayGameFileProvider } from '../../src/resources/providers/overlay';
import { readGuestFileSearch } from '../../src/adapter/fileSearch';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ } from '../helpers/guestMemory';

function setup() {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const data = 0x21000;
  const first = (pattern: string) => {
    writeAsciiZ(memory, 0x20000, pattern);
    return callShim(shim, 'KERNEL32.DLL!FindFirstFileA', [0x20000, data]).eax;
  };
  const next = (handle: number) => callShim(shim, 'KERNEL32.DLL!FindNextFileA', [handle, data]).eax;
  const error = () => callShim(shim, 'KERNEL32.DLL!GetLastError').eax;
  const name = () => new TextDecoder().decode(memory.read_memory(data + 44, 260)).split('\0')[0];
  return { memory, shim, data, first, next, error, name };
}

describe('客体文件枚举', () => {
  it('发现未挂载的 MOD 文件，写入大小和名称，正确结束并关闭搜索', () => {
    const { memory, shim, data, first, next, error, name } = setup();
    shim.setFileSearchResults('ECACHE*.MIX', [
      { path: 'Ecache01.mix', size: 207264 },
      { path: 'ecache02.mix', size: 17 },
      { path: 'sub/ecache03.mix', size: 7 },
    ]);
    const handle = first('ECACHE*.MIX');
    expect(handle).not.toBe(0xffffffff);
    expect(name()).toBe('Ecache01.mix');
    expect(readU32(memory, data)).toBe(0x20);
    expect(readU32(memory, data + 32)).toBe(207264);
    expect(shim.hasMountedFile('ecache01.mix')).toBe(false);
    expect(next(handle)).toBe(1);
    expect(name()).toBe('ecache02.mix');
    expect(next(handle)).toBe(0);
    expect(error()).toBe(18);
    expect(callShim(shim, 'KERNEL32.DLL!FindClose', [handle]).eax).toBe(1);
    expect(next(handle)).toBe(0);
    expect(error()).toBe(6);
    expect(callShim(shim, 'KERNEL32.DLL!FindClose', [handle]).eax).toBe(0);
  });

  it('搜索独立，挂载内容更新覆盖元数据但不改变已经开始的快照', () => {
    const { shim, memory, data, first, next, name } = setup();
    shim.mountFile('ecache01.mix', new Uint8Array(2));
    shim.mountFile('ecache02.mix', new Uint8Array(3));
    shim.setFileSearchResults('ecache*.mix', [{ path: 'ECACHE01.MIX', size: 99 }]);
    const a = first('ecache*.mix');
    expect(readU32(memory, data + 32)).toBe(2);
    shim.mountFile('ecache02.mix', new Uint8Array(7));
    const b = first('ecache*.mix');
    expect(next(a)).toBe(1);
    expect(name()).toBe('ecache02.mix');
    expect(readU32(memory, data + 32)).toBe(3);
    expect(next(b)).toBe(1);
    expect(readU32(memory, data + 32)).toBe(7);
  });

  it('支持大小写、目录、问号与无扩展名，返回 64 位逻辑长度', () => {
    const { shim, memory, data, first, name } = setup();
    shim.mountFile('saves/test1.sav', new Uint8Array(1), false, 0x1_0000_0007);
    expect(first('SAVES\\TEST?.SAV')).not.toBe(0xffffffff);
    expect(readU32(memory, data + 28)).toBe(1);
    expect(readU32(memory, data + 32)).toBe(7);
    shim.mountFile('readme', new Uint8Array(1));
    first('*.*');
    expect(name()).toBe('readme');
    expect(first('*.sav')).toBe(0xffffffff);
  });

  it('无匹配与无效参数不会伪造成功或写坏输出结构', () => {
    const { memory, shim, data, first, error } = setup();
    memory.write_memory(new Uint8Array(320).fill(0xa5), data);
    expect(first('absent*.mix')).toBe(0xffffffff);
    expect(error()).toBe(2);
    expect(memory.read_memory(data, 320).every((value) => value === 0xa5)).toBe(true);
    expect(callShim(shim, 'KERNEL32.DLL!FindFirstFileA', [0, data]).eax).toBe(0xffffffff);
    expect(error()).toBe(87);
  });

  it('provider 合并 overlay，仅查询匹配文件前缀，不把元数据挂载为空文件', async () => {
    const base = new MemoryGameFileProvider(
      new Map([
        ['ecache01.mix', new Uint8Array(2)],
        ['movies01.mix', new Uint8Array(3)],
      ]),
    );
    const files = new OverlayGameFileProvider(
      base,
      new Map([
        ['ECACHE01.MIX', new Uint8Array(7)],
        ['ecache02.mix', new Uint8Array(8)],
      ]),
      'MOD',
    );
    const read = vi.spyOn(files, 'read');
    const prefix = vi.spyOn(files, 'readPrefix');
    const entries = await readGuestFileSearch(files, 'ECACHE*.MIX');
    expect(entries.map((entry) => entry.size).sort()).toEqual([7, 8]);
    expect(read).not.toHaveBeenCalled();
    expect(prefix).toHaveBeenCalledTimes(2);
    expect(prefix.mock.calls.every(([path, size]) => path.startsWith('ecache') && size === 1)).toBe(true);
    const { shim, memory, data, first } = setup();
    shim.setFileSearchResults('ECACHE*.MIX', entries);
    first('ECACHE*.MIX');
    expect(readU32(memory, data + 32)).toBe(7);
    expect(shim.hasMountedFile('ecache01.mix')).toBe(false);
    await files.write('ecache03.mix', new Uint8Array(9));
    expect(await readGuestFileSearch(files, 'ECACHE*.MIX')).toHaveLength(3);
  });
});
