import { describe, expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
import { gameResolutionIni, withGameResolutionOverride } from '../../src/games/resolution';
import { withMultiplayerNameOverride } from '../../src/games/multiplayerName';
import { patchGameSpeedIni, withGameSpeedDefault } from '../../src/games/gameSpeed';

const encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const decode = (b: Uint8Array) => String.fromCharCode(...b);

describe('原版启动速度', () => {
  it('只更新单机速度，保留联机设置、编码和 CRLF，清理重复键', () => {
    const original =
      '[Options]\r\nGameSpeed=2\r\ngamespeed=3\r\n;\xff\r\n[Skirmish]\r\nGameSpeed=1\r\n[LAN]\r\nGameSpeed=4\r\n';
    const result = decode(patchGameSpeedIni(encode(original), 0));
    expect(result).toBe(
      '[Options]\r\nGameSpeed=0\r\n;\xff\r\nToolTips=yes\r\n[Skirmish]\r\nGameSpeed=0\r\n[LAN]\r\nGameSpeed=4\r\n',
    );
  });
  it('空配置补齐节，已有节补齐键，并拒绝非原版档位', () => {
    expect(decode(patchGameSpeedIni(new Uint8Array(), 0))).toBe(
      '[Options]\nGameSpeed=0\nToolTips=yes\n[Skirmish]\nGameSpeed=0\n',
    );
    expect(decode(patchGameSpeedIni(encode('[Options]\nVolume=1\n[Video]\n'), 6))).toContain(
      'Volume=1\nGameSpeed=6\nToolTips=yes\n[Video]',
    );
    expect(decode(patchGameSpeedIni(encode('[Options]\nToolTips=no\n'), 6))).toContain('ToolTips=no');
    for (const speed of [-1, 7, 0.5, NaN, Infinity]) expect(() => patchGameSpeedIni(new Uint8Array(), speed)).toThrow();
  });
  it.each(['ra2', 'yr'] as const)('%s 默认最快，与分辨率/名字叠加且不写回导入包', async (id) => {
    const path = gameResolutionIni(id),
      original = encode('[Options]\nGameSpeed=2\n');
    const files = new MemoryGameFileProvider(new Map([[path, original]]));
    const source: GameSource = { game: supportedGame(id), files, executableBytes: new Uint8Array([1]) };
    expect(source.game.defaultGameSpeed).toBe(0);
    expect(source.game.commandLineArguments).toBe('-SPEEDCONTROL');
    const configured = await withGameSpeedDefault(
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(source, { width: 1440, height: 900 }),
        'Alice',
      ),
    );
    const ini = decode((await configured.files.read(path))!);
    expect(ini).toContain('GameSpeed=0');
    expect(ini).toContain('ToolTips=yes');
    expect(ini).toContain('ScreenWidth=1440');
    expect(ini).toContain('Handle=41,6c,69,63,65,');
    await configured.files.write(path, encode('[Options]\nGameSpeed=3\n'));
    expect(await files.read(path)).toEqual(original);
    const generic = { ...source, game: { ...source.game, defaultGameSpeed: undefined } };
    expect(await withGameSpeedDefault(generic)).toBe(generic);
  });
});
