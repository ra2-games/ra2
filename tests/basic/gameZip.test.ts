/**
 * Network game-package unit tests: streaming ZIP extraction, session-provider IndexedDB write-through (memory-only fallback when Node lacks IndexedDB), and deep-directory discovery.
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { formatZipBytes, readZipArchive } from '../../src/utils/archive/zip';
import { discoverGameSources } from '../../src/resources/discovery/discoverGameSources';

/** Minimal recognizable PE: MZ magic plus a little padding. */
function fakeExe(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  return bytes;
}

describe('ZIP 解包', () => {
  it('流式解压并过滤目录占位与 macOS 垃圾条目', async () => {
    const zip = zipSync({
      'ra2/game.exe': fakeExe(),
      'ra2/ra2.mix': strToU8('mix-data'),
      '__MACOSX/._game.exe': strToU8('junk'),
      'empty/': new Uint8Array(0),
    });
    const entries = await readZipArchive(zip);
    const paths = entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(['ra2/game.exe', 'ra2/ra2.mix']);
    expect(entries.find((entry) => entry.path === 'ra2/game.exe')?.bytes[0]).toBe(0x4d);
  });

  it('字节格式化刻度正确', () => {
    expect(formatZipBytes(512)).toBe('512 B');
    expect(formatZipBytes(2048)).toBe('2.0 KB');
    expect(formatZipBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatZipBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('会话级包 provider', () => {
  it('内存读取与写档（Node 无 IndexedDB 时写穿透退化为内存）', async () => {
    const provider = new SessionGameFileProvider('测试包', new Map([['game.exe', fakeExe()]]));
    expect(await provider.read('GAME.EXE')).not.toBeNull();
    expect(provider.hasKnownFile('game.exe')).toBe(true);
    // Synchronous checks return null until IndexedDB key enumeration completes (Node has no IDB, so the enumerated set is empty).
    expect(provider.hasKnownFile('missing.mix')).toBeNull();
    await provider.list('');
    expect(provider.hasKnownFile('missing.mix')).toBe(false);
    await provider.write('save/allies.sav', strToU8('save'));
    expect(new TextDecoder().decode((await provider.read('SAVE/ALLIES.SAV')) ?? new Uint8Array())).toBe('save');
    expect(await provider.list('save')).toEqual(['allies.sav']);
    expect(await provider.list('')).toContain('game.exe');
  });
});

describe('包内深目录发现', () => {
  it('ZIP 内游戏位于任意子目录时仍能识别（deepDiscovery）', async () => {
    const provider = new SessionGameFileProvider(
      '嵌套包',
      new Map([
        ['红色警戒2 中文版/game.exe', fakeExe()],
        ['红色警戒2 中文版/ra2.mix', strToU8('mix')],
      ]),
    );
    const sources = await discoverGameSources(provider);
    expect(sources.length).toBe(1);
    expect(sources[0]!.game.id).toBe('ra2');
    expect(await sources[0]!.files.read('ra2.mix')).not.toBeNull();
  });
});
