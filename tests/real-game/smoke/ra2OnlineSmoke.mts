/**
 * RA2 optional-package end-to-end smoke test (outside CI): download explicitly specified campaign maps (about 2 MB, MAPS01.MIX + maps02.mix) and movies (about 628 MB ZIP, movies01/02.mix + subtitle.txt), verify required files and overlay byte ranges, then use two OverlayGameFileProvider layers over a zero-byte-placeholder base (base < campaign < movies).
 * Verify sparse-playback semantics: readPrefix returns actual totalSize, and hasKnownFile finds files unique to campaign/movie packages.
 *
 * Usage: set RA2_CAMPAIGN_PACK_URL and RA2_MOVIES_PACK_URL, then run pnpm exec tsx tests/real-game/smoke/ra2OnlineSmoke.mts. The built-in catalog no longer supplies online ZIP URLs.
 * Runtime depends on the network; the movie package contains high-entropy Bink data and extracts quickly after download.
 */
import { MemoryGameFileProvider } from '../../../src/resources/providers/memory';
import { OverlayGameFileProvider } from '../../../src/resources/providers/overlay';
import { loadRemoteGamePackage } from '../../../scripts/resources/gamePackageDownload';
import { isDeepStrictEqual } from 'node:util';

const campaignUrl = process.env.RA2_CAMPAIGN_PACK_URL;
const moviesUrl = process.env.RA2_MOVIES_PACK_URL;
if (!campaignUrl || !moviesUrl) {
  throw new Error('在线 ZIP 地址已移除，请显式设置 RA2_CAMPAIGN_PACK_URL 和 RA2_MOVIES_PACK_URL');
}

let failures = 0;
console.info(`[冒烟] 下载战役包 ${campaignUrl}`);
const campaignProvider = await loadRemoteGamePackage(campaignUrl, {
  sha256: process.env.RA2_CAMPAIGN_PACK_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});
console.info(`[冒烟] 下载电影包 ${moviesUrl}`);
const moviesProvider = await loadRemoteGamePackage(moviesUrl, {
  sha256: process.env.RA2_MOVIES_PACK_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});

const required = ['MAPS01.MIX', 'maps02.mix', 'movies01.mix', 'movies02.mix', 'subtitle.txt'];
const supplied = new Map<string, Uint8Array>();
for (const path of required) {
  const bytes = (await moviesProvider.read(path)) ?? (await campaignProvider.read(path));
  if (!bytes || ((path.endsWith('.mix') || path.endsWith('.MIX')) && bytes.length === 0)) {
    console.error(`[冒烟] 缺少或为空 ${path}`);
    failures++;
    continue;
  }
  supplied.set(path, bytes);
}

// Simulate a trimmed multiplayer base: MAPS01/movies01 are zero-byte placeholders; maps02/movies02/subtitle are absent.
// Overlay campaign and movie packages in order (base < campaign < movies). Sparse playback uses readPrefix/
// readRange; overlay hits must return the actual totalSize.
const placeholderBase = new MemoryGameFileProvider(
  new Map([
    ['MAPS01.MIX', new Uint8Array(0)],
    ['movies01.mix', new Uint8Array(0)],
  ]),
  true,
  '联机精简基包',
);
const withCampaign = new OverlayGameFileProvider(placeholderBase, campaignProvider.files, '（战役包）', false, false);
const base = new OverlayGameFileProvider(withCampaign, moviesProvider.files, '（电影包）', false, false);

for (const [path, expected] of supplied) {
  const prefix = await base.readPrefix(path, 1024 * 1024);
  if (
    !prefix ||
    prefix.totalSize !== expected.length ||
    !isDeepStrictEqual(prefix.bytes, expected.subarray(0, 1024 * 1024))
  ) {
    console.error(`[冒烟] overlay readPrefix ${path} 内容或 totalSize 不符`);
    failures++;
  }
  const range = await base.readRange(path, 0, 4096);
  if (!range || !isDeepStrictEqual(range, expected.subarray(0, 4096))) {
    console.error(`[冒烟] overlay readRange ${path} 内容不符`);
    failures++;
  }
}
if (base.hasKnownFile('maps02.mix') !== true) {
  console.error('[冒烟] 战役包独有文件 maps02.mix 未被 overlay 认可');
  failures++;
}
if (base.hasKnownFile('movies02.mix') !== true) {
  console.error('[冒烟] 电影包独有文件 movies02.mix 未被 overlay 认可');
  failures++;
}

if (failures > 0) {
  console.error(`[冒烟] ${failures} 项校验失败`);
  process.exit(1);
}
console.info('[冒烟] 通过。');
