/**
 * Game file layer unit tests (migrated from scripts/fileProviderSmoke.mts):
 * Memory/Directory provider path normalization and discovery (including fake File System Access handles), plus Win32Shim critical sections, GetDriveTypeA, MCIWndCreateA+MM_MCINOTIFY, coalesced small _lwrite writes, and save -> load reopening.
 */
import { describe, expect, it } from 'vitest';
import { DirectoryGameFileProvider } from '../../src/platform/browser/files/directory';
import { collectDirectoryOverlays, directoryScopeOf } from '../../src/platform/browser/files/directoryAccess';
import { validateGameDirectory } from '../../src/resources/discovery/discoverGameSources';
import { discoverGameSources } from '../../src/resources/discovery/discoverGameSources';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { OverlayGameFileProvider } from '../../src/resources/providers/overlay';
import { ScopedGameFileProvider } from '../../src/resources/providers/scoped';
import { DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR } from '../../src/vm86/win32';
import type { Win32Shim } from '../../src/games/win32Shim';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

/** Dispatch once and read unsigned EAX (equivalent to the original smoke test's local dispatch). */
function dispatch(shim: Win32Shim, key: string, args: number[] = []): number {
  return callShim(shim, key, args).eax >>> 0;
}

describe('MemoryGameFileProvider', () => {
  it('路径大小写/分隔符归一化；写入即快照，不受原数组后续改动影响', async () => {
    const provider = new MemoryGameFileProvider(new Map([['GAME.EXE', new Uint8Array([0x4d, 0x5a, 1, 2])]]));

    expect(await provider.read('C:\\game.exe')).toEqual(new Uint8Array([0x4d, 0x5a, 1, 2]));
    expect(await provider.read('missing.dat')).toBe(null);

    const save = new Uint8Array([9, 8, 7, 6]);
    await provider.write('Save\\slot01.sav', save);
    save[0] = 0;
    expect(await provider.read('save/slot01.sav')).toEqual(new Uint8Array([9, 8, 7, 6]));
    await provider.flush();
  });
});

describe('discoverGameSources', () => {
  it('在共享安装目录中分别发现 RA2 与 YR，并保持 scoped 写回', async () => {
    const developmentRoot = new MemoryGameFileProvider(
      new Map([
        ['ra2/game.exe', new Uint8Array([0x4d, 0x5a, 4])],
        ['ra2/gamemd.exe', new Uint8Array([0x4d, 0x5a, 5])],
      ]),
    );
    const detected = await discoverGameSources(developmentRoot);
    expect(detected.map((source) => source.game.id).sort()).toEqual(['ra2', 'yr']);
    expect((await validateGameDirectory(developmentRoot, 'ra2')).map((source) => source.game.id)).toEqual(['ra2']);
    expect((await validateGameDirectory(developmentRoot, 'yr')).map((source) => source.game.id)).toEqual(['yr']);
    await detected.find((source) => source.game.id === 'ra2')!.files.write('Save\\slot.sav', new Uint8Array([7]));
    expect(await developmentRoot.read('ra2/save/slot.sav')).toEqual(new Uint8Array([7]));
  });

  it('改名的客户端按默认 RA2 兼容层发现', async () => {
    const alternateClient = new MemoryGameFileProvider(new Map([['Game_custom.exe', new Uint8Array([0x4d, 0x5a, 3])]]));
    const alternateSources = await discoverGameSources(alternateClient);
    expect(alternateSources.length).toBe(1);
    expect(alternateSources[0]?.game.id).toBe('ra2');
    expect(alternateSources[0]?.game.executable).toBe('game_custom.exe');
  });

  // Discover arbitrary EXEs; skip uninstallers (uninst*), multiplayer clients, and non-PE files.
  it('任意 EXE 可发现；卸载程序/联机客户端/非 PE 文件跳过', async () => {
    const generic = new MemoryGameFileProvider(
      new Map([
        ['MyGame.exe', new Uint8Array([0x4d, 0x5a, 4])],
        ['uninst.exe', new Uint8Array([0x4d, 0x5a, 5])],
        ['UnInstall.EXE', new Uint8Array([0x4d, 0x5a, 6])],
        ['ListenClient.exe', new Uint8Array([0x4d, 0x5a, 8])],
        ['not-pe.exe', new Uint8Array([1, 2, 3])],
      ]),
    );
    const genericSources = await discoverGameSources(generic);
    expect(genericSources.length).toBe(1);
    expect(genericSources[0]?.game.executable).toBe('mygame.exe');
    expect(genericSources[0]?.game.id, '未知 EXE 按 RA2 兼容层运行').toBe('ra2');
  });
});

describe('directoryScopeOf', () => {
  it('保留 Scoped 和 Overlay 包装下的实际目录作用域', () => {
    const root = new MemoryGameFileProvider();
    const scoped = new ScopedGameFileProvider(root, 'ra2');
    const overlay = new OverlayGameFileProvider(scoped, new Map(), 'test overlay');

    expect(directoryScopeOf(root)).toBe('');
    expect(directoryScopeOf(scoped)).toBe('ra2');
    expect(directoryScopeOf(overlay)).toBe('ra2');
  });
});

describe('OverlayGameFileProvider（战役包叠加语义）', () => {
  it.each([false, true])('keeps independent session writes with parentFirst=%s', async (parentFirst) => {
    const original = new Uint8Array([1, 2]);
    const parent = new MemoryGameFileProvider(new Map([['settings.ini', original]]));
    const overlay = new OverlayGameFileProvider(
      parent,
      new Map([['settings.ini', new Uint8Array([3, 4])]]),
      'session',
      true,
      false,
      parentFirst,
    );
    const written = new Uint8Array([7, 8, 9]);
    await overlay.write('C:\\SETTINGS.INI', written);
    written.fill(0);
    await overlay.flush();
    overlay.invalidateCache();
    const read = (await overlay.read('settings.ini'))!;
    expect(read).toEqual(new Uint8Array([7, 8, 9]));
    read.fill(0);
    expect(await overlay.readPrefix('settings.ini', 2)).toEqual({ bytes: new Uint8Array([7, 8]), totalSize: 3 });
    expect(await overlay.readRange('settings.ini', 1, 2)).toEqual(new Uint8Array([8, 9]));
    expect(overlay.overlays.get('settings.ini')).toEqual(new Uint8Array([7, 8, 9]));
    expect(await parent.read('settings.ini')).toEqual(original);
    await overlay.write('settings.ini', new Uint8Array());
    expect(await overlay.read('settings.ini')).toEqual(new Uint8Array());
    expect(await overlay.readPrefix('settings.ini', 1)).toEqual({ bytes: new Uint8Array(), totalSize: 0 });
    expect(await overlay.readRange('settings.ini', 0, 1)).toEqual(new Uint8Array());
    expect(overlay.hasKnownFile('settings.ini')).toBe(true);
    expect(await overlay.list('')).toContain('settings.ini');
    await overlay.write('slot.sav', new Uint8Array([5]));
    expect(await parent.read('slot.sav')).toEqual(new Uint8Array([5]));
  });

  // Simulate a trimmed multiplayer base package: movies01.mix is a zero-byte placeholder and maps02.mix is absent; overlay the campaign package.
  // Skirmish-only users keep base-package behavior without the campaign package. With it mounted, movies use sparse paged streaming;
  // readPrefix must return the actual totalSize (>= prefix length) before markFileRangeBacked can run.
  it('overlay 文件赢过基包：read/readPrefix/readRange；readPrefix 返回真实 totalSize', async () => {
    const placeholderMovies = new Uint8Array(0);
    const realMovies = new Uint8Array(8 * 1024 * 1024); // Simulate a movie container much larger than the 1 MiB sparse prefix
    realMovies[12345] = 0xab;
    const base = new MemoryGameFileProvider(new Map([['movies01.mix', placeholderMovies]]), true, '联机精简基包');
    const campaign = new OverlayGameFileProvider(
      base,
      new Map([['movies01.mix', realMovies]]),
      '（战役包）',
      false,
      false,
    );

    const full = await campaign.read('movies01.mix');
    expect(full).toBeTruthy();
    expect(full!.length).toBe(realMovies.length);
    expect(full![12345]).toBe(0xab);
    const prefix = await campaign.readPrefix('movies01.mix', 1024 * 1024);
    expect(prefix).toBeTruthy();
    expect(prefix!.bytes.length).toBe(1024 * 1024);
    expect(prefix!.totalSize).toBe(realMovies.length); // Actual logical length -> range-backed
    const range = await campaign.readRange('movies01.mix', 12300, 512);
    expect(range![45]).toBe(0xab);
  });

  it('战役包独有文件可读且 hasKnownFile 命中；都缺失的回落父层', async () => {
    const base = new MemoryGameFileProvider(new Map([['language.mix', new Uint8Array([1, 2, 3])]]));
    const campaign = new OverlayGameFileProvider(
      base,
      new Map([['maps02.mix', new Uint8Array([9, 9, 9])]]),
      '（战役包）',
      false,
      false,
    );

    // maps02.mix exists only in the campaign package: it is readable, and hasKnownFile does not cache it as missing.
    expect(campaign.hasKnownFile('maps02.mix')).toBe(true);
    expect(await campaign.read('maps02.mix')).toEqual(new Uint8Array([9, 9, 9]));
    // Fall through to base-package files (language.mix still comes from the base package).
    expect(campaign.hasKnownFile('language.mix')).toBe(true);
    expect(await campaign.read('language.mix')).toEqual(new Uint8Array([1, 2, 3]));
    // A file absent from both: hasKnownFile is false (the base package's in-memory directory establishes its absence).
    expect(campaign.hasKnownFile('thememd.mix')).toBe(false);
    expect(await campaign.read('thememd.mix')).toBe(null);
    // list merges entries from both.
    const listing = await campaign.list('');
    expect(listing).toContain('maps02.mix');
    expect(listing).toContain('language.mix');
  });

  it('overlay 命中文件的写入穿透到父层，不落在 overlay 内存里', async () => {
    const base = new MemoryGameFileProvider();
    const campaign = new OverlayGameFileProvider(
      base,
      new Map([['subtitle.txt', new Uint8Array([1])]]),
      '（战役包）',
      false,
      false,
    );
    await campaign.write('subtitle.txt', new Uint8Array([7, 8]));
    // Save writes must reach the persistent layer (the parent provider); the overlay intercepts only reads.
    expect(await base.read('subtitle.txt')).toEqual(new Uint8Array([7, 8]));
    expect(await campaign.read('subtitle.txt')).toEqual(new Uint8Array([1]));
  });

  it('parentFirst：本地完整安装优先（中文资源），在线包只补缺', async () => {
    const local = new MemoryGameFileProvider(
      new Map([
        ['language.mix', new Uint8Array([1, 1, 1])], // Local Chinese language pack
        ['ra2.ini', new Uint8Array([2])],
      ]),
    );
    const online = new OverlayGameFileProvider(
      local,
      new Map([
        ['language.mix', new Uint8Array([9, 9, 9])], // The packaged English language pack must not override the local one
        ['game.exe', new Uint8Array([0x4d, 0x5a])], // Files unique to the package fill gaps
      ]),
      '（在线覆盖）',
      false,
      false,
      true,
    );

    expect(await online.read('language.mix')).toEqual(new Uint8Array([1, 1, 1]));
    expect(await online.read('ra2.ini')).toEqual(new Uint8Array([2]));
    expect(await online.read('game.exe')).toEqual(new Uint8Array([0x4d, 0x5a]));
    expect(online.hasKnownFile('language.mix')).toBe(true);
    expect(online.hasKnownFile('missing.mix')).toBe(false);
    // Writes always reach the underlying local directory, regardless of parentFirst.
    await online.write('Save/slot.sav', new Uint8Array([7]));
    expect(await local.read('Save/slot.sav')).toEqual(new Uint8Array([7]));
  });
});

class FakeFile {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    public bytes: Uint8Array<ArrayBuffer>,
  ) {}
  async getFile(): Promise<Blob> {
    return new Blob([this.bytes]);
  }
  async createWritable() {
    return {
      write: async (data: ArrayBuffer) => {
        this.bytes = new Uint8Array(data.slice(0));
      },
      close: async () => {},
    };
  }
}

class FakeDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeFile | FakeDirectory>();
  entriesCalls = 0;
  constructor(readonly name: string) {}
  async *entries() {
    this.entriesCalls++;
    yield* this.children;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeDirectory(name);
    this.children.set(name, created);
    return created;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof FakeFile) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeFile(name, new Uint8Array());
    this.children.set(name, created);
    return created;
  }
}

describe('collectDirectoryOverlays（worker init 消息的叠加层序列化）', () => {
  it('目录后端之上按最内层→最外层收集，穿透 Scoped 包装', () => {
    const root = new FakeDirectory('RA2');
    const directory = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    const base = new OverlayGameFileProvider(
      new ScopedGameFileProvider(directory, 'ra2'),
      new Map([
        ['language.mix', new Uint8Array([1])],
        ['subtitle.txt', new Uint8Array([2])],
      ]),
      '（本体）',
      false,
      false,
    );
    const pack = new OverlayGameFileProvider(
      base,
      new Map([['subtitle.txt', new Uint8Array([3])]]),
      '（战役包）',
      false,
      false,
    );
    const layers = collectDirectoryOverlays(pack);
    expect(layers?.map((layer) => [...layer.keys()])).toEqual([['language.mix', 'subtitle.txt'], ['subtitle.txt']]);
  });

  it('无目录后端（纯会话包）返回 null，由调用方整体序列化', () => {
    const session = new MemoryGameFileProvider(new Map([['game.exe', new Uint8Array([0x4d, 0x5a])]]));
    const overlaid = new OverlayGameFileProvider(
      session,
      new Map([['language.mix', new Uint8Array([1])]]),
      '（在线覆盖）',
      false,
      false,
    );
    expect(collectDirectoryOverlays(overlaid)).toBeNull();
    expect(collectDirectoryOverlays(session)).toBeNull();
  });
});

describe('DirectoryGameFileProvider（假 File System Access 句柄）', () => {
  it('大小写无关读写；根目录只枚举一次；list 保留原始大小写并复用索引', async () => {
    const root = new FakeDirectory('RA2');
    root.children.set('GAME.EXE', new FakeFile('GAME.EXE', new Uint8Array([0x4d, 0x5a])));
    const directory = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    expect(await directory.read('game.exe')).toEqual(new Uint8Array([0x4d, 0x5a]));
    expect(await directory.read('GAME.EXE')).toEqual(new Uint8Array([0x4d, 0x5a]));
    await directory.write('Save\\Slot01.sav', new Uint8Array([1, 3, 3, 7]));
    await directory.flush();
    expect(await directory.read('save/slot01.SAV')).toEqual(new Uint8Array([1, 3, 3, 7]));
    expect(root.entriesCalls, '大型游戏根目录只应枚举一次').toBe(1);
    expect(await directory.list(''), 'list 应保留原始大小写').toEqual(['GAME.EXE', 'save']);
    expect(root.entriesCalls, 'list 应复用条目索引，不再枚举').toBe(1);
  });
});

describe('Win32Shim 系统语义', () => {
  it('临界区：递归进入累计 RecursionCount，完全退出清零', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const criticalSectionPtr = 0x4000;
    expect(dispatch(shim, 'KERNEL32.DLL!InitializeCriticalSection', [criticalSectionPtr])).toBe(0);
    expect(memory.bytes[criticalSectionPtr + 4]! | (memory.bytes[criticalSectionPtr + 5]! << 8)).toBe(0xffff);
    expect(dispatch(shim, 'KERNEL32.DLL!EnterCriticalSection', [criticalSectionPtr])).toBe(0);
    expect(dispatch(shim, 'KERNEL32.DLL!EnterCriticalSection', [criticalSectionPtr])).toBe(0);
    expect(memory.bytes[criticalSectionPtr + 8], '递归进入应更新 RecursionCount').toBe(2);
    expect(dispatch(shim, 'KERNEL32.DLL!LeaveCriticalSection', [criticalSectionPtr])).toBe(0);
    expect(dispatch(shim, 'KERNEL32.DLL!LeaveCriticalSection', [criticalSectionPtr])).toBe(0);
    expect(memory.bytes[criticalSectionPtr + 8], '完全退出应清除 RecursionCount').toBe(0);
  });

  // Only the installation drive exists by default; optical media must be explicitly supplied rather than reported as present.
  it('GetDriveTypeA 默认仅安装盘；MessageBoxA 的 MB_YESNO 默认 IDYES', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const pathPtr = 0x1000;
    writeAsciiZ(memory, pathPtr, 'C:\\');
    expect(dispatch(shim, 'KERNEL32.DLL!GetDriveTypeA', [pathPtr])).toBe(DRIVE_FIXED);
    writeAsciiZ(memory, pathPtr, 'D:\\');
    expect(dispatch(shim, 'KERNEL32.DLL!GetDriveTypeA', [pathPtr])).toBe(DRIVE_NO_ROOT_DIR);
    writeAsciiZ(memory, pathPtr, 'E:\\');
    expect(dispatch(shim, 'KERNEL32.DLL!GetDriveTypeA', [pathPtr])).toBe(DRIVE_NO_ROOT_DIR);
    expect(dispatch(shim, 'USER32.DLL!MessageBoxA', [0, 0, 0, 0x04]), 'MB_YESNO 默认返回 IDYES').toBe(6);
  });

  it('driveTypes 显式挂载的盘符按表返回（光盘 D:）', () => {
    const memory = createGuestMemory();
    const cdShim = createTestShim(memory, { driveTypes: { C: DRIVE_FIXED, D: DRIVE_CDROM } });
    const pathPtr = 0x1000;
    writeAsciiZ(memory, pathPtr, 'E:\\');
    expect(callShim(cdShim, 'KERNEL32.DLL!GetDriveTypeA', [pathPtr]).eax).toBe(DRIVE_NO_ROOT_DIR);
    writeAsciiZ(memory, pathPtr, 'D:\\');
    expect(callShim(cdShim, 'KERNEL32.DLL!GetDriveTypeA', [pathPtr]).eax).toBe(DRIVE_CDROM);
  });

  it('RA2 does not manufacture the installer SysID', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId: 'ra2' });
    const keyName = 0x1000;
    const valueName = 0x1100;
    const handle = 0x1200;
    const type = 0x1204;
    const data = 0x1208;
    const size = 0x120c;
    const readU32 = (pointer: number) =>
      new DataView(memory.bytes.buffer, memory.bytes.byteOffset).getUint32(pointer, true);
    writeAsciiZ(memory, keyName, 'WChat\\SysID');
    writeAsciiZ(memory, valueName, 'ID');

    expect(dispatch(shim, 'ADVAPI32.DLL!RegOpenKeyExA', [0x8000_0000, keyName, 0, 0x20019, handle])).toBe(2);
    expect(readU32(handle)).toBe(0);
    expect(dispatch(shim, 'ADVAPI32.DLL!RegCreateKeyExA', [0x8000_0000, keyName, 0, 0, 0, 0xf003f, 0, handle, 0])).toBe(
      0,
    );
    memory.write_memory([4, 0, 0, 0], size);
    expect(dispatch(shim, 'ADVAPI32.DLL!RegQueryValueExA', [readU32(handle), valueName, 0, type, data, size])).toBe(2);
    expect(readU32(data)).toBe(0);
  });

  it('默认 CD-ROM 磁盘空间只读，并提供中性卷信息', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      driveTypes: { C: DRIVE_FIXED, D: DRIVE_CDROM },
      volumeSerial: 0x1234_5678,
    });
    const path = 0x1000;
    const sectors = 0x1100;
    const bytes = 0x1104;
    const free = 0x1108;
    const total = 0x110c;
    const label = 0x1200;
    const serial = 0x1210;
    const fs = 0x1220;
    const readU32 = (pointer: number) =>
      new DataView(memory.bytes.buffer, memory.bytes.byteOffset).getUint32(pointer, true);
    writeAsciiZ(memory, path, 'D:\\');

    expect(dispatch(shim, 'KERNEL32.DLL!GetDiskFreeSpaceA', [path, sectors, bytes, free, total])).toBe(1);
    expect(readU32(bytes)).toBe(2048);
    expect(readU32(free), '只读光盘不应报告可写簇').toBe(0);
    expect(readU32(total)).toBeGreaterThan(0);

    expect(dispatch(shim, 'KERNEL32.DLL!GetVolumeInformationA', [path, label, 16, serial, 0, 0, fs, 16])).toBe(1);
    expect(readU32(serial)).toBe(0x1234_5678);
    expect(new TextDecoder().decode(memory.bytes.slice(label, label + 6))).toBe('CDROM\0');
    expect(new TextDecoder().decode(memory.bytes.slice(fs, fs + 5))).toBe('CDFS\0');
  });

  it('RA2 profile 才报告 RA2 光盘卷标', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      driveTypes: { C: DRIVE_FIXED, D: DRIVE_CDROM },
    });
    const path = 0x1000;
    const label = 0x1200;
    writeAsciiZ(memory, path, 'D:\\');

    expect(dispatch(shim, 'KERNEL32.DLL!GetVolumeInformationA', [path, label, 16, 0, 0, 0, 0, 0])).toBe(1);
    expect(new TextDecoder().decode(memory.bytes.slice(label, label + 4))).toBe('RA2\0');
  });

  it('MCIWndCreateA 播放结束经 MM_MCINOTIFY 通知游戏 WndProc', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const messagePtr = 0x3000;
    const mciWindow = dispatch(shim, 'MSVFW32.DLL!MCIWndCreateA', []);
    expect(mciWindow).toBeTruthy();
    expect(dispatch(shim, 'USER32.DLL!SendMessageA', [mciWindow, 0x0806, 0, 0])).toBe(0);
    expect(dispatch(shim, 'USER32.DLL!PeekMessageA', [messagePtr, 0, 0, 0, 1])).toBe(1);
    expect(
      memory.bytes[messagePtr + 4]! | (memory.bytes[messagePtr + 5]! << 8),
      'MCI_PLAY 应通过 MM_MCINOTIFY 通知游戏 WndProc',
    ).toBe(0x03b9);
    expect(dispatch(shim, 'USER32.DLL!SendMessageA', [mciWindow, 0x0010, 0, 0])).toBe(0);
  });

  // Saving often uses many small _lwrite calls: coalesce them in the guest and send one write to the directory backend at _lclose.
  it('小块 _lwrite 合并落盘；持久化快照可重新打开读回（save→load）', () => {
    const memory = createGuestMemory();
    const persisted: Array<{ path: string; bytes: Uint8Array }> = [];
    const shim = createTestShim(memory, {
      onFileWrite: (path, bytes) => persisted.push({ path, bytes }),
    });
    const pathPtr = 0x1000;
    const bytePtr = 0x2000;
    writeAsciiZ(memory, pathPtr, 'Save\\batch.sav');
    const saveHandle = dispatch(shim, 'KERNEL32.DLL!_lcreat', [pathPtr, 0]);
    for (let value = 0; value < 16_384; value++) {
      memory.write_memory([value & 0xff], bytePtr);
      expect(dispatch(shim, 'KERNEL32.DLL!_lwrite', [saveHandle, bytePtr, 1])).toBe(1);
    }
    expect(persisted.length, '小块写入期间不应整文件反复落盘').toBe(0);
    expect(dispatch(shim, 'KERNEL32.DLL!_lclose', [saveHandle])).toBe(0);
    expect(persisted.length, '关闭存档时只持久化一次').toBe(1);
    expect(persisted[0]?.path).toBe('save/batch.sav');
    expect(persisted[0]?.bytes.length).toBe(16_384);
    expect([...persisted[0]!.bytes.subarray(0, 4)]).toEqual([0, 1, 2, 3]);

    // Recreate the VM/handle layer and load the newly saved file from the persisted snapshot, covering the actual save -> load handle path.
    const loadedMemory = createGuestMemory();
    const loadedShim = createTestShim(loadedMemory);
    loadedShim.mountFile(persisted[0]!.path, persisted[0]!.bytes);
    const loadPathPtr = 0x1000;
    const loadBufferPtr = 0x2000;
    writeAsciiZ(loadedMemory, loadPathPtr, 'Save\\batch.sav');
    const loadHandle = dispatch(loadedShim, 'KERNEL32.DLL!_lopen', [loadPathPtr, 0]);
    expect(loadHandle, '刚保存的存档应可重新打开').not.toBe(0xffff_ffff);
    expect(dispatch(loadedShim, 'KERNEL32.DLL!_lread', [loadHandle, loadBufferPtr, 16_384])).toBe(16_384);
    expect([...loadedMemory.bytes.subarray(loadBufferPtr, loadBufferPtr + 4)]).toEqual([0, 1, 2, 3]);
    expect(dispatch(loadedShim, 'KERNEL32.DLL!_lclose', [loadHandle])).toBe(0);
  });
});
