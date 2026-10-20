/**
 * Synchronize online game packages locally: download an explicitly specified ZIP with optional SHA-256 verification, retain it at game/<id>[-<pack>].zip, and extract to game/<folder>/. RA2 and YR share game/ra2, matching directory discovery. Node real-game tests can read the extracted files directly. Browser tests and players import them through the file or folder picker; the development server does not serve these files.
 *
 * Usage:
 *   RA2_PACKAGE_URL="$RA2_DOWNLOAD_URL" pnpm run sync:game -- ra2
 *   YR_PACKAGE_URL="$YR_DOWNLOAD_URL" pnpm run sync:game -- yr
 * Download sources have been removed from the built-in catalog; specify ZIPs with these environment variables and optionally RA2_PACKAGE_SHA256 / YR_PACKAGE_SHA256. Packages must include their game executable.
 *
 * Resource preparation does not establish executable compatibility. Run the relevant native startup and behavior regressions against the selected installation.
 * This archival entry point supports ZIP only; import other original packages in the frontend. CI uses the shared extractor.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from '../../src/games/catalog';
import { readZipArchive } from '../../src/utils/archive/zip';
import { sha256Hex } from '../../src/utils/sha256';
import { isArchiveTargetWithinRoot } from './archivePath';
import { fetchPackageFile } from './gamePackageDownload';

const requested = process.argv.slice(2);
const games = (requested.length ? requested : SUPPORTED_GAMES.map((game) => game.id)).map((id) =>
  supportedGame(id as SupportedGameId),
);

async function syncPackage(
  name: string,
  url: string,
  sha256: string | undefined,
  targetDirectory: string,
): Promise<void> {
  console.info(`[同步] 下载 ${url}`);
  let lastReportedMb = -1;
  const bytes = await fetchPackageFile(url, (downloaded, total) => {
    const mb = Math.floor(downloaded / (8 * 1024 * 1024));
    if (mb === lastReportedMb) return;
    lastReportedMb = mb;
    console.info(`[同步]   ${mb * 8} MB${total ? ` / ${Math.ceil(total / (8 * 1024 * 1024)) * 8} MB` : ''}`);
  });
  if (sha256) {
    console.info('[同步] 校验 SHA-256…');
    const actual = await sha256Hex(bytes);
    if (actual !== sha256) throw new Error(`${name} SHA-256 不匹配：${actual}`);
  }
  const zipPath = resolve('game', `${name}.zip`);
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, bytes);
  console.info(`[同步] 压缩包留档 ${zipPath}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
  const entries = await readZipArchive(bytes);
  const root = resolve(targetDirectory);
  let written = 0;
  for (const entry of entries) {
    const target = resolve(root, entry.path);
    // readZipArchive already normalizes paths, removing drive letters, backslashes, and parent segments; this is defense in depth.
    if (!isArchiveTargetWithinRoot(root, target)) throw new Error(`拒绝写出目录外的路径：${entry.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes);
    written++;
  }
  console.info(`[同步] 解压 ${written} 个文件 → ${targetDirectory}`);
}

let synced = 0;
let failed = false;
for (const game of games) {
  const prefix = game.id.toUpperCase();
  const url = process.env[`${prefix}_PACKAGE_URL`];
  const sha256 = process.env[`${prefix}_PACKAGE_SHA256`];
  if (!url) {
    console.warn(`[同步] ${game.id} 未登记在线包，请设置 ${prefix}_PACKAGE_URL 指定 ZIP 地址。`);
    if (requested.length) failed = true;
    continue;
  }
  console.info(`[同步] === ${game.title}（${game.id}）本体 ===`);
  try {
    await syncPackage(`${game.id}-base`, url, sha256, resolve('game', game.folder));
    synced++;
  } catch (error) {
    failed = true;
    console.warn(`[同步] ${game.id} 本体失败：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
}
if (failed || !synced) {
  process.exitCode = 1;
  console.error(
    `[同步] ${synced ? '部分包同步失败，请检查上述错误。' : '未同步任何游戏包。'} 资源包需包含原始游戏主程序。`,
  );
} else {
  console.info(`[同步] 已同步 ${synced} 个游戏本体。资源包需包含原始游戏主程序。`);
}
