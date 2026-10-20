import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME, SUPPORTED_GAMES } from '../../src/games/catalog';
import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS } from '../../src/games/manifest';

describe('游戏目录边界', () => {
  it('每款游戏显式登记独立 profile 与 ABI', () => {
    expect(SUPPORTED_GAMES.map((game) => game.id)).toEqual(['ra2', 'yr', 'mo']);
    expect(SUPPORTED_GAMES[0]!.shimProfile).not.toBe(SUPPORTED_GAMES[1]!.shimProfile);
    expect(SUPPORTED_GAMES.find((game) => game.id === 'mo')?.shimProfile).toBe(
      SUPPORTED_GAMES.find((game) => game.id === 'yr')?.shimProfile,
    );
    expect(SUPPORTED_GAMES.every((game) => Object.keys(game.abi).length > 0)).toBe(true);
    expect(DEFAULT_GAME).toBe(SUPPORTED_GAMES[0]);
  });

  it('共辉覆盖文件只在 RA2 可选清单中，并进入归档提取白名单', () => {
    for (const name of ['expand01.mix', 'ecache01.mix', 'ra2.csf']) {
      expect(GAME_MANIFESTS.ra2.playerOptional.some((file) => file.name === name)).toBe(true);
      expect(GAME_MANIFESTS.ra2.playerRequired.some((file) => file.name === name)).toBe(false);
      expect(
        [...GAME_MANIFESTS.yr.playerOptional, ...GAME_MANIFESTS.yr.playerRequired].some((file) => file.name === name),
      ).toBe(false);
      expect(ARCHIVE_WANTED_NAMES).toContain(name);
    }
  });
});
