import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { GAME_MANIFESTS } from '../../src/games/manifest';
import { type SupportedGameId, SUPPORTED_GAMES } from '../../src/games/catalog';

export interface ResourceRoots {
  game: string;
}
export interface ResourceInventory {
  version: 1;
  files: Record<string, string>;
}
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Fingerprint the entire asset set so extra MODs/maps cannot silently change the acceptance environment; hash large MIX files as streams. */
export async function inventoryResources(roots: ResourceRoots): Promise<ResourceInventory> {
  const files: Record<string, string> = {};
  async function walk(path: string, key: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`资源不允许符号链接：${key}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${key}/${name}`);
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      files[key] = hash.digest('hex');
    } else throw new Error(`资源不是普通文件：${key}`);
  }
  for (const [key, path] of Object.entries(roots)) {
    if (!isAbsolute(path)) throw new Error(`资源目录必须为绝对路径：${key}`);
    if (!(await lstat(path)).isDirectory()) throw new Error(`资源根目录不是目录：${key}`);
    await walk(path, key);
  }
  if (!Object.keys(files).length) throw new Error('资源清单为空');
  return { version: 1, files };
}

export function assertInventory(actual: ResourceInventory, expected: unknown): void {
  if (!expected || typeof expected !== 'object') throw new Error('资源清单格式错误');
  const value = expected as Partial<ResourceInventory>;
  if (value.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('资源清单版本或 files 无效');
  }
  const keys = Object.keys(value.files).sort(),
    current = Object.keys(actual.files).sort();
  if (!keys.length || JSON.stringify(keys) !== JSON.stringify(current))
    throw new Error('资源文件集合变化：存在缺失或额外文件');
  for (const key of keys) {
    if (!/^[a-f0-9]{64}$/.test(value.files[key]!) || value.files[key] !== actual.files[key]) {
      throw new Error(`资源 SHA-256 不匹配：${key}`);
    }
  }
}

/** A manifest cannot justify missing assets; also use the product manifest to verify required resources and executables for the specified game, or both if unspecified. */
export function assertGameResources(inventory: ResourceInventory, gameId?: SupportedGameId): void {
  const names = new Map<string, string>();
  for (const name of Object.keys(inventory.files)) {
    if (names.has(name.toLowerCase())) throw new Error(`资源文件大小写冲突：${name}`);
    names.set(name.toLowerCase(), name);
  }
  for (const game of SUPPORTED_GAMES.filter((game) => !gameId || game.id === gameId)) {
    const manifest = GAME_MANIFESTS[game.id];
    for (const file of [{ name: game.executable }, ...manifest.playerRequired]) {
      const name = `game/${game.folder}/${file.name}`.toLowerCase();
      if (!names.has(name)) throw new Error(`缺少真实游戏资源：${name}`);
    }
  }
}

export async function verifyResources(
  roots: ResourceRoots,
  manifest: string,
  expectedSha256: string,
  gameId?: SupportedGameId,
): Promise<ResourceInventory> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('必须设置可信资源清单的 SHA-256');
  const bytes = await readFile(manifest);
  if (sha256(bytes) !== expectedSha256) throw new Error('资源清单 SHA-256 不匹配');
  const actual = await inventoryResources(roots);
  assertInventory(actual, JSON.parse(bytes.toString('utf8')));
  assertGameResources(actual, gameId);
  return actual;
}
