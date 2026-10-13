import { describe, expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
import {
  gameResolutionIni,
  parseGameResolution,
  patchGameResolutionIni,
  patchIniSection,
  withGameResolutionOverride,
} from '../../src/games/resolution';

const encode = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0));
const decode = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

describe('RA2/YR 分辨率 INI 内存覆盖', () => {
  it('只修改 [Video] 的三个键并保留 CRLF 与其他 section', () => {
    const original = encode(
      '[Options]\r\nScreenWidth=123\r\n\r\n[Video]\r\nVideoBackBuffer=no\r\n' +
        'AllowHiResModes=no\r\nScreenWidth=800\r\nScreenHeight=600\r\n\r\n[Audio]\r\nSoundVolume=1\r\n',
    );
    const patched = decode(patchGameResolutionIni(original, { width: 1440, height: 900 }));
    expect(patched).toContain('[Options]\r\nScreenWidth=123');
    expect(patched).toContain(
      '[Video]\r\nVideoBackBuffer=no\r\nAllowHiResModes=yes\r\n' + 'ScreenWidth=1440\r\nScreenHeight=900',
    );
    expect(patched).toContain('[Audio]\r\nSoundVolume=1\r\n');
    expect(patched.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('缺少 [Video] 或键时补齐，并严格限制为预设值', () => {
    const patched = decode(
      patchGameResolutionIni(encode('[Options]\nGameSpeed=1'), {
        width: 1920,
        height: 1080,
      }),
    );
    expect(patched).toBe('[Options]\nGameSpeed=1\n\n[Video]\nAllowHiResModes=yes\nScreenWidth=1920\nScreenHeight=1080');
    expect(parseGameResolution('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(parseGameResolution('1366x768')).toBeNull();
    expect(parseGameResolution('99999x1')).toBeNull();
  });

  it('RA2/YR 使用各自 INI，覆盖层可读但不会写回父 provider', async () => {
    for (const gameId of ['ra2', 'yr'] as const) {
      const ini = gameResolutionIni(gameId);
      const files = new MemoryGameFileProvider(
        new Map([[ini, encode('[Video]\nScreenWidth=800\nScreenHeight=600\n')]]),
      );
      const source: GameSource = { game: supportedGame(gameId), files, executableBytes: new Uint8Array([1]) };
      const overlaid = await withGameResolutionOverride(source, { width: 1600, height: 900 });
      expect(decode((await overlaid.files.read(ini))!)).toContain('ScreenWidth=1600\nScreenHeight=900');
      await overlaid.files.write(ini, encode('[Video]\nScreenWidth=1024\nScreenHeight=768\n'));
      expect(decode((await files.read(ini))!)).toContain('ScreenWidth=800\nScreenHeight=600');
      await overlaid.files.write('Save/slot.sav', new Uint8Array([7]));
      expect(await files.read('Save/slot.sav')).toEqual(new Uint8Array([7]));
    }
  });

  it('未设置分辨率时：无 INI 提供默认 800×600 规范配置，有 INI 原样返回', async () => {
    for (const gameId of ['ra2', 'yr'] as const) {
      const ini = gameResolutionIni(gameId);
      const missingFiles = new MemoryGameFileProvider();
      const missingSource: GameSource = {
        game: supportedGame(gameId),
        files: missingFiles,
        executableBytes: new Uint8Array([1]),
      };
      // The online package lacks ra2.ini: provide well-formed defaults (missing/empty INI makes the game
      // fall back to a frozen 640x400 intro). Writes are shadowed and do not reach the provider.
      const overlaid = await withGameResolutionOverride(missingSource, null);
      expect(decode((await overlaid.files.read(ini))!)).toBe(
        '[Video]\nAllowHiResModes=yes\nScreenWidth=800\nScreenHeight=600\n',
      );
      await overlaid.files.write(ini, encode('[Video]\nScreenWidth=1024\n'));
      expect(await missingFiles.read(ini)).toBeNull();

      const existingFiles = new MemoryGameFileProvider(new Map([[ini, encode('[Video]\n')]]));
      const existingSource: GameSource = { ...missingSource, files: existingFiles };
      expect(await withGameResolutionOverride(existingSource, null)).toBe(existingSource);
    }
  });

  it('空原稿生成格式规范的 INI：首行即段名、行尾换行', () => {
    const patched = decode(patchGameResolutionIni(new Uint8Array(), { width: 1024, height: 768 }));
    expect(patched).toBe('[Video]\nAllowHiResModes=yes\nScreenWidth=1024\nScreenHeight=768\n');
    expect(patched.startsWith('[')).toBe(true);
    expect(patched.endsWith('\n')).toBe(true);
  });
  it('通用 section 修改：大小写不敏感匹配键，保留编码、换行与其他行，缺失时追加', () => {
    const source = '[Intro]\r\nplay=yes\r\n; note\r\n[Video]\r\nScreenWidth=640\r\n';
    expect(decode(patchIniSection(encode(source), 'intro', [['Play', 'no']]))).toBe(
      '[Intro]\r\nPlay=no\r\n; note\r\n[Video]\r\nScreenWidth=640\r\n',
    );
    expect(decode(patchIniSection(encode('[Video]\nScreenWidth=640'), 'Intro', [['Play', 'no']]))).toBe(
      '[Video]\nScreenWidth=640\n\n[Intro]\nPlay=no',
    );
    expect(decode(patchIniSection(new Uint8Array(), 'Intro', [['Play', 'no']]))).toBe('[Intro]\nPlay=no\n');
    const latin1 = encode('[Options]\nName=\xe9\xff\n');
    expect(patchIniSection(latin1, 'Options', [['GameSpeed', '3']]).slice(0, latin1.length - 1)).toEqual(
      latin1.slice(0, latin1.length - 1),
    );
  });
});
