import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** Browser regression without game assets: real 7z Worker -> frontend staging/persistence -> file set for the next startup. */
import assert from 'node:assert/strict';
import SevenZip from '7z-wasm';
import { zipSync, strToU8 } from 'fflate';
import { chromium, expect } from '@playwright/test';

const seven = await SevenZip({ print: () => {}, printErr: () => {} });
seven.FS.mkdir('/input');
seven.FS.mkdir('/input/maps');
seven.FS.writeFile('/input/maps/FIRST.MPR', strToU8('[Basic]\nName=Fixture\n'));
seven.FS.writeFile('/input/RA2MD.CSF', new Uint8Array([1, 2, 3]));
seven.FS.writeFile('/input/game.exe', new Uint8Array([0x4d, 0x5a]));
seven.FS.writeFile('/input/rules.ini', strToU8('[General]\n'));
// Even with a target and more than three entries in the outer archive, explore nested ZIPs; do not reuse the base-game import's early-stop rule.
seven.FS.writeFile('/input/nested.zip', zipSync({ 'deep/SECOND.YRM': strToU8('[Basic]\nName=Nested\n') }));
assert.equal(seven.callMain(['a', '-t7z', '/maps.7z', '/input']), 0);
const archive = Buffer.from(seven.FS.readFile('/maps.7z'));
const duplicate = Buffer.from(zipSync({ 'one/X.MPR': strToU8('one'), 'two/x.mpr': strToU8('two') }));
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  // The map entry is available only after VM startup; this asset-free regression requests the same React dialog service directly.
  const openMaps = async () => {
    await expect(page.getByRole('button', { name: '加载游戏', exact: true })).toBeVisible();
    await page.evaluate(`(async () => {
      const { editCustomMapPackages } = await import('/src/ui/pages/game/customMapDialog.ts');
      void editCustomMapPackages('ra2');
    })()`);
  };
  await openMaps();
  const dialog = page.getByRole('dialog', { name: '自定义地图包', exact: true });
  const picker = dialog.getByLabel('添加自定义地图压缩包');
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({ name: 'fixture.7z', mimeType: 'application/x-7z-compressed', buffer: archive });
  await dialog
    .getByRole('status')
    .filter({ hasText: '已暂存 3 个文件' })
    .waitFor()
    .catch(async (error) => {
      throw new Error(`导入失败：${await dialog.getByRole('status').textContent()}`, { cause: error });
    });
  assert.equal(await dialog.locator('li').count(), 3);
  assert.match(await dialog.innerText(), /first\.mpr/);
  assert.match(await dialog.innerText(), /second\.yrm/);
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.reload();
  await openMaps();
  await dialog.getByRole('button', { name: '移除 first.mpr', exact: true }).waitFor();
  assert.equal(await dialog.locator('li').count(), 3, '刷新后仍恢复附加文件');
  await picker.setInputFiles({ name: 'duplicate.zip', mimeType: 'application/zip', buffer: duplicate });
  await dialog.getByRole('status').filter({ hasText: '同名文件' }).waitFor();
  assert.equal(await dialog.locator('li').count(), 3, '失败不能部分覆盖原文件集');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await openMaps();
  await dialog.getByRole('button', { name: '移除 first.mpr', exact: true }).click();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const names = await page.evaluate(`(async () => {
    const { loadCustomMapFiles } = await import('/src/adapter/cachedGameFiles.ts');
    const ra2 = [...(await loadCustomMapFiles('ra2')).keys()].sort();
    const yr = [...(await loadCustomMapFiles('yr')).keys()];
    return { ra2, yr };
  })()`);
  assert.deepEqual(names, { ra2: ['ra2md.csf', 'second.yrm'], yr: [] });
  let navigations = 0;
  page.on('framenavigated', () => {
    navigations++;
  });
  await page.evaluate(`(async () => {
    const { editCustomMapPackages } = await import('/src/ui/pages/game/customMapDialog.ts');
    const { prepareDynamicMaps } = await import('/src/adapter/customMapPackage.ts');
    const { SessionGameFileProvider } = await import('/src/platform/browser/files/sessionFiles.ts');
    let base = new SessionGameFileProvider('运行中本体', new Map());
    void editCustomMapPackages('ra2', async files => {
      const mounted = await prepareDynamicMaps(base, files);
      base = mounted.provider;
      window.__customMapLiveFiles = await base.list('');
      return '动态挂载完成：' + mounted.result.attached.join(',');
    });
  })()`);
  await expect(dialog.getByRole('button', { name: '应用到运行中的 VM' })).toBeEnabled();
  await dialog.getByRole('button', { name: '应用到运行中的 VM' }).click();
  await dialog.getByRole('status').filter({ hasText: '动态挂载完成：second.yrm' }).waitFor();
  assert.deepEqual(await page.evaluate('window.__customMapLiveFiles'), ['second.yrm'], '动态挂载必须排除 CSF');
  assert.equal(navigations, 0, '动态应用不能刷新页面或重启 VM');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  // Simulate restoration with a new provider in the same browser context, and abort the transaction during a real put success event.
  const persistence = await page.evaluate(`(async () => {
    const { SessionGameFileProvider } = await import('/src/platform/browser/files/sessionFiles.ts');
    const { IndexedDbWriteCache } = await import('/src/platform/browser/files/writeCache.ts');
    const { readGuestFileSearch } = await import('/src/adapter/fileSearch.ts');
    const first = new SessionGameFileProvider('写入', new Map());
    await first.write('save/probe.sav', new Uint8Array([1, 2, 3]));
    await first.write('save/empty.sav', new Uint8Array());
    const restored = new SessionGameFileProvider('恢复', new Map());
    const prefix = await restored.readPrefix('save/probe.sav', 1);
    const entries = await readGuestFileSearch(restored, 'save/*.sav');
    const cache = new IndexedDbWriteCache();
    await cache.keys();
    const original = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    let rejected = false;
    try {
      IDBObjectStore.prototype.put = function(value, key) {
        const request = original.call(this, value, key);
        if (key === 'save/aborted.sav') request.addEventListener('success', () => {
          requestSucceeded = true;
          this.transaction.abort();
        });
        return request;
      };
      try { await cache.write('save/aborted.sav', new Uint8Array([9])); }
      catch { rejected = true; }
    } finally { IDBObjectStore.prototype.put = original; }
    return {
      prefix: [...prefix.bytes], totalSize: prefix.totalSize,
      range: [...await restored.readRange('save/probe.sav', 1, 1)],
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      requestSucceeded, rejected, known: cache.hasKnownKey('save/aborted.sav'),
      absent: await new IndexedDbWriteCache().read('save/aborted.sav') === null,
    };
  })()`);
  assert.deepEqual(persistence, {
    prefix: [1],
    totalSize: 3,
    range: [2],
    entries: [
      { path: 'save/empty.sav', size: 0 },
      { path: 'save/probe.sav', size: 3 },
    ],
    requestSucceeded: true,
    rejected: true,
    known: false,
    absent: true,
  });
  console.log('会话存档回归通过：恢复后枚举/前缀/范围读取、空文件、真实 IndexedDB 请求成功后事务中止');
  console.log('自定义地图包回归通过：真实 7z/嵌套 ZIP、三种扩展名、重复文件拒绝、持久化、移除、版本隔离');
} finally {
  await browser.close();
}
