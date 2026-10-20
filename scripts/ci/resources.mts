import { isSupportedGameId } from '../../src/games/catalog';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { assertGameResources, inventoryResources, sha256, verifyResources } from './gameResources';

const gameId = process.env.RA2_CI_GAME;
if (gameId !== undefined && !isSupportedGameId(gameId)) throw new Error('RA2_CI_GAME 仅支持 ra2 或 yr');
const roots = { game: process.env.RA2_GAME_ROOT ?? '' };
const manifest = process.env.RA2_CI_RESOURCE_MANIFEST;
if (!manifest) throw new Error('请设置 RA2_CI_RESOURCE_MANIFEST（清单位于资源目录之外）');
if (!isAbsolute(manifest)) throw new Error('资源清单必须使用绝对路径');
for (const root of Object.values(roots)) {
  if (!isAbsolute(root)) throw new Error('资源目录必须使用绝对路径');
  const path = relative(root, manifest);
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) {
    throw new Error('资源清单必须位于资源目录之外');
  }
}
if (process.argv.slice(2).some((arg) => arg !== '--record')) throw new Error('仅支持 --record 或无参数校验');
if (process.argv.includes('--record')) {
  // Maintainers establish baselines explicitly; CI must never refresh them automatically to conceal asset drift.
  const inventory = await inventoryResources(roots);
  assertGameResources(inventory, gameId);
  const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(manifest, bytes, { flag: 'wx' });
  console.log(`资源清单已创建，SHA-256=${sha256(bytes)}`);
} else {
  const inventory = await verifyResources(roots, manifest, process.env.RA2_CI_RESOURCE_MANIFEST_SHA256 ?? '', gameId);
  console.log(`真实资源校验通过：${Object.keys(inventory.files).length} 个文件`);
}
