import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertGameResources,
  assertInventory,
  inventoryResources,
  sha256,
  verifyResources,
} from '../../scripts/ci/gameResources';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { GAME_MANIFESTS } from '../../src/games/manifest';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

it('流式清单覆盖嵌套文件与零字节文件，顺序稳定', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ra2-ci-resources-'));
  temporary.push(base);
  const roots = { game: join(base, 'game') };
  await mkdir(join(roots.game, 'ra2'), { recursive: true });
  await writeFile(join(roots.game, 'ra2', 'movies.mix'), '');
  await writeFile(join(roots.game, 'ra2', 'game.exe'), 'fixture');
  const actual = await inventoryResources(roots);
  expect(actual.files).toEqual({ 'game/ra2/movies.mix': sha256(''), 'game/ra2/game.exe': sha256('fixture') });
  expect(await inventoryResources(roots)).toEqual(actual);
  expect(() => assertInventory(actual, actual)).not.toThrow();
  expect(() =>
    assertInventory(actual, { version: 1, files: { ...actual.files, 'game/extra.mix': sha256('') } }),
  ).toThrow('文件集合');
  expect(() =>
    assertInventory(actual, { version: 1, files: { ...actual.files, 'game/ra2/game.exe': sha256('changed') } }),
  ).toThrow('不匹配');
  expect(() => assertInventory(actual, { version: 2, files: actual.files })).toThrow('版本');
  const manifest = join(base, 'manifest.json');
  const content = JSON.stringify(actual);
  await writeFile(manifest, content);
  await expect(verifyResources(roots, manifest, 'bad')).rejects.toThrow('可信');
  await expect(verifyResources(roots, manifest, sha256('wrong'))).rejects.toThrow('清单 SHA');
  // Valid integrity does not make this a complete game; it must still fail so synthetic assets cannot count as real-game acceptance.
  await expect(verifyResources(roots, manifest, sha256(content))).rejects.toThrow('缺少真实游戏资源');
});

it('拒绝相对路径、缺资源及符号链接逃逸', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ra2-ci-resources-'));
  temporary.push(base);
  await expect(inventoryResources({ game: 'relative' })).rejects.toThrow('绝对路径');
  await expect(inventoryResources({ game: join(base, 'missing') })).rejects.toThrow();
  await mkdir(join(base, 'game'));
  await mkdir(join(base, 'thirdParty'));
  await symlink(join(base, 'thirdParty'), join(base, 'game', 'escape'), 'dir');
  await expect(inventoryResources({ game: join(base, 'game') })).rejects.toThrow('符号链接');
});

it('产品清单要求包内 RA2/YR 主程序，不限制其发行版哈希', () => {
  const files: Record<string, string> = {};
  for (const game of SUPPORTED_GAMES) {
    const manifest = GAME_MANIFESTS[game.id];
    for (const file of [{ name: game.executable }, ...manifest.playerRequired])
      files[`game/${game.folder}/${file.name}`.toLowerCase()] = sha256('fixture');
  }
  expect(() => assertGameResources({ version: 1, files })).not.toThrow();
  expect(() =>
    assertGameResources({ version: 1, files: { ...files, 'game/ra2/gamemd.exe': sha256('wrong') } }),
  ).not.toThrow();
  expect(() => assertGameResources({ version: 1, files: { ...files, 'game/ra2/GAME.EXE': sha256('wrong') } })).toThrow(
    '大小写冲突',
  );
});

it('独立资源包只校验对应游戏，不能拿 RA2 包通过 YR 准入', () => {
  for (const game of SUPPORTED_GAMES) {
    const manifest = GAME_MANIFESTS[game.id];
    const files: Record<string, string> = {};
    for (const file of [{ name: game.executable }, ...manifest.playerRequired])
      files[`game/${game.folder}/${file.name}`.toLowerCase()] = sha256('fixture');
    const inventory = { version: 1 as const, files };
    expect(() => assertGameResources(inventory, game.id)).not.toThrow();
    expect(() => assertGameResources(inventory, game.id === 'ra2' ? 'yr' : 'ra2')).toThrow();
  }
});
