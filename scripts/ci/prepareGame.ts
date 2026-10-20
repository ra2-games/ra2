import { GAME_ARCHIVE_DIRECTORY_RULES } from '../../src/games/archivePolicy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchiveExtractor } from '../../src/utils/archive/archiveExtractor';
import { ARCHIVE_WANTED_NAMES } from '../../src/games/manifest';
import type { SupportedGameId } from '../../src/games/catalog';
import { assertGameResources, inventoryResources, sha256 } from './gameResources';

/**
 * Use the same complete import as the frontend; CI waits for all extraction rather than starting early from the startup layer.
 */
export async function extractGameArchive(
  archive: string,
  destination: string,
  wanted: readonly string[],
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.extract-'));
  try {
    let files = 0,
      size = 0,
      complete = false;
    let failure: string | undefined;
    const extract = createArchiveExtractor({
      mountInput(sevenZip) {
        // Mount only this download directory; NODEFS reads on demand, matching browser WORKERFS semantics without copying the entire archive.
        sevenZip.FS.mount(sevenZip.NODEFS, { root: dirname(archive) }, '/work');
      },
      mountOutput(sevenZip) {
        // Solid/nested archives still use shared extraction; write large output sets to disk instead of retaining the whole package in MEMFS.
        sevenZip.FS.mount(sevenZip.NODEFS, { root: staging }, '/out');
      },
      post(message) {
        if (message.type === 'error') failure = message.message;
        if (message.type === 'done') complete = true;
        if (message.type !== 'file') return;
        const path = message.name.replaceAll('\\', '/');
        if (
          path.startsWith('/') ||
          path.split('/').some((part) => !part || part === '..' || part === '.') ||
          /[\r\n\0:]/.test(path)
        )
          throw new Error('提取结果路径无效');
        size += message.bytes.length;
        if (++files > 200_000 || size > 32 * 1024 ** 3) throw new Error('资源提取数量或体积超限');
        const target = join(destination, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, message.bytes, { flag: 'wx' });
      },
    });
    // The downloader always saves archive.bin so original URLs/filenames cannot enter extractor logs.
    await extract({ type: 'extract', wanted: [...wanted], directoryRules: GAME_ARCHIVE_DIRECTORY_RULES });
    if (failure || !complete || !files) throw new Error('游戏包提取失败或未提取到所需资源');
    console.log(`游戏包提取完成：${files} 个文件，${size} 字节`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareGame(
  game: SupportedGameId,
  root: string,
): Promise<{ manifest: string; expected: string }> {
  const gameDirectory = join(root, 'game', 'ra2');
  await mkdir(gameDirectory, { recursive: true });
  await extractGameArchive(join(root, 'archive.bin'), gameDirectory, ARCHIVE_WANTED_NAMES);
  const inventory = await inventoryResources({ game: join(root, 'game') });
  assertGameResources(inventory, game);
  // Inputs were authenticated by the secret archive hash, including the package executable; this manifest records materialized results, not a new trust baseline.
  const manifest = join(root, 'inventory.json');
  await writeFile(manifest, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return { manifest, expected: sha256(await readFile(manifest)) };
}

// A separate process owns the extractor and WASM memory; start VM acceptance only after it exits.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [game, root, ...extra] = process.argv.slice(2);
  if (extra.length || (game !== 'ra2' && game !== 'yr') || !root || !isAbsolute(root)) {
    throw new Error('用法：prepareGame.ts <ra2|yr> <绝对资源目录>');
  }
  const prepared = await prepareGame(game, root);
  await writeFile(join(root, 'prepared.json'), JSON.stringify(prepared), { flag: 'wx' });
  console.log(`资源提取进程峰值 RSS：${Math.round(process.resourceUsage().maxRSS / 1024)} MiB`);
}
