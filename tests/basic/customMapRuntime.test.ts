import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmInitConfig } from '../../src/adapter/vmProtocol';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { ScopedGameFileProvider } from '../../src/resources/providers/scoped';
import { OverlayGameFileProvider } from '../../src/resources/providers/overlay';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';
import { PortGameFileProvider } from '../../src/adapter/fileProviderPort';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { createVmShell } from '../../src/adapter/runtime';

const captured = vi.hoisted(() => ({ config: null as VmInitConfig | null, transfer: [] as Transferable[] }));
vi.mock('v86', () => ({ V86: class {} }));
vi.mock('../../src/adapter/vmClient', () => ({
  WorkerVmClient: class {
    constructor(_callbacks: unknown, config: VmInitConfig, options: { initTransfer: Transferable[] }) {
      captured.config = config;
      captured.transfer = options.initTransfer;
    }
    async waitProbe() {}
    async destroy() {}
  },
}));
afterEach(() => vi.unstubAllGlobals());

describe('附加包启动传输', () => {
  it('两层来源在 Session 分支前识别，端口保留第三方覆盖并能读取后到的文件', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('indexedDB', undefined);
    const base = new ProgressiveGameFileProvider('分层', new Set(['ra2.mix', 'maps01.mix']));
    base.accept('ra2.mix', new Uint8Array([1]));
    const exe = new Uint8Array([0x4d, 0x5a]);
    const source = {
      game: SUPPORTED_GAMES[0]!,
      files: new OverlayGameFileProvider(base, new Map([['game.exe', exe]]), '第三方'),
      executableBytes: exe,
    };
    const vm = await createVmShell({}, source);
    const clone = structuredClone(captured.config!, { transfer: captured.transfer });
    expect(clone.provider.kind).toBe('port');
    if (clone.provider.kind !== 'port') throw new Error('两层来源被错误压平');
    expect(clone.selectedExecutable?.path).toBe('game.exe');
    const remote = new PortGameFileProvider(clone.provider.label, clone.provider.port, clone.provider.names);
    try {
      expect(await remote.read('game.exe')).toEqual(exe);
      expect(await remote.list('')).toContain('maps01.mix');
      const map = remote.read('maps01.mix');
      base.accept('maps01.mix', new Uint8Array([2]));
      expect(await map).toEqual(new Uint8Array([2]));
      expect(base.files.get('ra2.mix')).toEqual(new Uint8Array([1]));
    } finally {
      remote.dispose();
      await vm.destroy();
    }
  });
  it.each(['scoped', 'memory'] as const)('%s 本体单独传递附加包，transfer 不拆走原始缓冲', async (kind) => {
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('Worker', class {});
    const original = new Uint8Array([0, 1, 2, 3, 4]);
    const additionalFiles = new Map([['a.mpr', original.subarray(1, 4)]]);
    const files =
      kind === 'scoped'
        ? new ScopedGameFileProvider(new MemoryGameFileProvider(new Map()), 'ra2')
        : new SessionGameFileProvider('本体', new Map([['game.exe', new Uint8Array([0x4d, 0x5a])]]));
    const vm = await createVmShell(
      {},
      { game: SUPPORTED_GAMES[0]!, files, executableBytes: new Uint8Array([0x4d, 0x5a]), additionalFiles },
    );
    expect(captured.config!.provider.kind).toBe('port');
    if (captured.config!.provider.kind === 'port') {
      expect(captured.config!.provider.names).not.toContain('a.mpr');
    }
    const clone = structuredClone(captured.config!, { transfer: captured.transfer });
    expect(clone.selectedExecutable).toEqual({
      path: 'game.exe',
      bytes: new Uint8Array([0x4d, 0x5a]),
    });
    expect(clone.additionalFiles).toEqual([{ path: 'a.mpr', bytes: new Uint8Array([1, 2, 3]) }]);
    expect(clone.additionalFiles![0]!.bytes.buffer.byteLength).toBe(3);
    expect(original).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    if (clone.provider.kind === 'port') clone.provider.port.close();
    await vm.destroy();
  });

  it('Port 覆盖 EXE 使用选中的独立缓冲，transfer 后主线程仍能回退', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('Worker', class {});
    const executableBytes = new Uint8Array([0, 0x4d, 0x5a, 9, 0]).subarray(1, 4);
    const vm = await createVmShell(
      {},
      { game: SUPPORTED_GAMES[0]!, files: new MemoryGameFileProvider(new Map()), executableBytes },
    );
    const clone = structuredClone(captured.config!, { transfer: captured.transfer });
    expect(clone.selectedExecutable).toEqual({ path: 'game.exe', bytes: new Uint8Array([0x4d, 0x5a, 9]) });
    expect(clone.selectedExecutable!.bytes.buffer.byteLength).toBe(3);
    expect(executableBytes).toEqual(new Uint8Array([0x4d, 0x5a, 9]));
    if (clone.provider.kind === 'port') clone.provider.port.close();
    await vm.destroy();
  });
});
