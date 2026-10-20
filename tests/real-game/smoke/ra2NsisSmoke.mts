/**
 * Real online-package end-to-end smoke test (outside CI): download an explicitly specified RA2 installer, extract it, and validate executable structure and required resources.
 *
 * Usage: pnpm exec tsx tests/real-game/smoke/ra2NsisSmoke.mts
 * Takes about 1-2 minutes for download and LZMA decoding, with roughly 1.5 GB peak memory.
 */
import { loadRemoteGamePackage } from '../../../scripts/resources/gamePackageDownload';
import { inspectPe32 } from '../../../src/vm86/peProbe';

// Validate a locally preconverted ZIP: RA2_PACKAGE_URL=http://localhost:8000/ra2.zip pnpm run test:ra2-nsis
const url = process.env.RA2_PACKAGE_URL;
if (!url) throw new Error('在线包地址已移除，请显式设置 RA2_PACKAGE_URL');

console.info(`[冒烟] 下载 ${url}`);
const provider = await loadRemoteGamePackage(url, {
  sha256: process.env.RA2_PACKAGE_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});

let failures = 0;
const bytes = await provider.read('game.exe');
if (!bytes || !inspectPe32(bytes)) {
  console.error('[冒烟] 缺少或无效的 game.exe（需要 PE32）');
  failures++;
}
const listing = await provider.list('');
console.info(
  `[冒烟] 根目录条目：${(listing ?? []).length} 项；语言资源 ${listing?.includes('language.mix') ? '含 language.mix' : '缺少 language.mix'}`,
);
if (!listing?.includes('language.mix')) failures++;

if (failures > 0) {
  console.error(`[冒烟] ${failures} 项校验失败`);
  process.exit(1);
}
console.info('[冒烟] 通过。');
