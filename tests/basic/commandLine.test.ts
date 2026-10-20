import { describe, expect, it } from 'vitest';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { callShim, createGuestMemory, createTestShim } from '../helpers/guestMemory';

describe('客体启动命令行', () => {
  it.each(SUPPORTED_GAMES)('$id 开放原版速度控制且不污染模块路径', (game) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      moduleName: game.executable,
      commandLineArguments: game.commandLineArguments,
    });
    const readString = (address: number) => {
      const bytes = memory.read_memory(address, 256);
      return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
    };
    const pointer = callShim(shim, 'KERNEL32.DLL!GetCommandLineA').eax;
    expect(readString(pointer)).toBe(
      `${game.executable}${game.commandLineArguments ? ` ${game.commandLineArguments}` : ''}`,
    );
    expect(callShim(shim, 'KERNEL32.DLL!GetCommandLineA').eax).toBe(pointer);
    callShim(shim, 'KERNEL32.DLL!GetModuleFileNameA', [0, 0x2000, 256]);
    expect(readString(0x2000)).toBe(`C:\\GAME\\${game.executable}`);
    shim.dispose();
  });

  it('通用 shim 不自动注入游戏参数', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { moduleName: 'fixture.exe' });
    const pointer = callShim(shim, 'KERNEL32.DLL!GetCommandLineA').eax;
    expect(new TextDecoder().decode(memory.read_memory(pointer, 12))).toBe('fixture.exe\0');
    shim.dispose();
  });

  it.each(['x'.repeat(256), 'foo\0bar'])('拒绝越界或 NUL 参数', (args) => {
    expect(() => createTestShim(createGuestMemory(), { commandLineArguments: args })).toThrow('客体命令行');
  });
});
