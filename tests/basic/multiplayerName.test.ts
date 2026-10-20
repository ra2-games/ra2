import { describe, expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
import { gameResolutionIni, withGameResolutionOverride } from '../../src/games/resolution';
import {
  patchMultiplayerNameIni,
  randomMultiplayerName,
  validateMultiplayerName,
  withMultiplayerNameOverride,
} from '../../src/games/multiplayerName';
const encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const decode = (b: Uint8Array) => String.fromCharCode(...b);

describe('启动用户名 INI 内存覆盖', () => {
  it('随机默认名以 ra2.games- 开头且满足原版 15 字节限制，每次创建独立身份', () => {
    const names = Array.from({ length: 32 }, randomMultiplayerName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(validateMultiplayerName(name)).toMatch(/^ra2\.games-[0-9a-z]{5}$/);
  });
  it('校验 GBK 字节长度与代码页，不允许换行注入', () => {
    expect(validateMultiplayerName(' HostOne ')).toBe('HostOne');
    expect(validateMultiplayerName('中国')).toBe('中国');
    expect(validateMultiplayerName('中国玩家')).toBe('中国玩家');
    // 15-byte limit: 16 ASCII characters or 8 Chinese characters (16 bytes) are too long; emoji are outside the GBK code page.
    for (const value of ['', 'a'.repeat(16), '汉'.repeat(8), 'x\n[Video]', '\t', '😀']) {
      expect(() => validateMultiplayerName(value)).toThrow();
    }
  });
  it('中文名编码为 GBK 十六进制字节', () => {
    expect(decode(patchMultiplayerNameIni(new Uint8Array(), '中国'))).toBe('[MultiPlayer]\nHandle=d6,d0,b9,fa,\n');
    expect(decode(patchMultiplayerNameIni(encode('[MultiPlayer]\nColor=1\n'), 'ra2.games-A'))).toBe(
      '[MultiPlayer]\nColor=1\n\nHandle=72,61,32,2e,67,61,6d,65,73,2d,41,\n',
    );
  });
  it('Handle 编码为原生十六进制，并保留其他 section、CRLF 和非 ASCII 原字节', () => {
    const original =
      '[Video]\r\nScreenWidth=1440\r\n[MultiPlayer]\r\nHandle=00,\r\nColor=3\r\nhandle=01,\r\n[Other]\r\nHandle=untouched\r\n;\xff\r\n';
    const patched = decode(patchMultiplayerNameIni(encode(original), 'Ab'));
    expect(patched).toContain('Handle=41,62,\r\nColor=3');
    expect(patched).not.toContain('handle=01,');
    expect(patched).toContain('[Other]\r\nHandle=untouched\r\n;\xff\r\n');
    expect(patched).toContain('[Video]\r\nScreenWidth=1440');
  });
  it('补齐缺少的 section 和 Handle', () => {
    expect(decode(patchMultiplayerNameIni(new Uint8Array(), 'A'))).toBe('[MultiPlayer]\nHandle=41,\n');
    expect(decode(patchMultiplayerNameIni(encode('[MultiPlayer]\nColor=1\n[Video]\n'), 'B'))).toContain(
      'Color=1\nHandle=42,\n[Video]',
    );
  });
  it.each(['ra2', 'yr'] as const)('%s 与分辨率叠加，两个 VM 的名字及后续写入互不污染', async (game) => {
    const path = gameResolutionIni(game),
      original = encode('[Video]\nScreenWidth=800\n');
    const files = new MemoryGameFileProvider(new Map([[path, original]]));
    const source: GameSource = { game: supportedGame(game), files, executableBytes: new Uint8Array([1]) };
    const a = await withMultiplayerNameOverride(
      await withGameResolutionOverride(source, { width: 1440, height: 900 }),
      'A',
    );
    const b = await withMultiplayerNameOverride(source, 'B');
    expect(decode((await a.files.read(path))!)).toContain('ScreenWidth=1440');
    expect(decode((await a.files.read(path))!)).toContain('Handle=41,');
    expect(decode((await b.files.read(path))!)).toContain('Handle=42,');
    await a.files.write(path, encode('changed'));
    expect(await files.read(path)).toEqual(original);
    expect(decode((await b.files.read(path))!)).toContain('Handle=42,');
    expect(await withMultiplayerNameOverride(source)).toBe(source);
  });
});
