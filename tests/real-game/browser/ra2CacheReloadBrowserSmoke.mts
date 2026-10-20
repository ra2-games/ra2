import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectedGameOption, dismissGameGuide, selectImportedGame } from '../../helpers/selectDevelopmentGame';
/** After the first local ZIP import, reload must boot normally from persisted resources; testing only development mode is insufficient. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const archive = process.env.RA2_BROWSER_ZIP;
const folder = process.env.RA2_BROWSER_FOLDER;
if (!archive && !folder) throw new Error('请通过 RA2_BROWSER_ZIP 或 RA2_BROWSER_FOLDER 指定合法的测试资源');
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const game = process.env.RA2_BROWSER_GAME === 'yr' ? 'yr' : 'ra2';
// Large installation caches need disk-backed storage, matching normal browser use rather than incognito memory quotas.
const profile = await mkdtemp(join(tmpdir(), 'ra2-bundle-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  locale: 'zh-CN',
  ignoreHTTPSErrors: true,
});
try {
  // Diagnostic comparison: remove only the layered plan and retain full extraction; never replace resource or EXE bytes.
  if (process.env.RA2_BROWSER_FULL_ARCHIVE === '1')
    await context.addInitScript(() => {
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        private archive: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.archive = String(url).includes('archiveExtractWorker');
        }
        postMessage(message: any, transfer: any = []) {
          super.postMessage(
            this.archive && message?.type === 'extract' ? { ...message, layers: undefined } : message,
            transfer,
          );
        }
      };
    });
  const page = await context.newPage();
  page.on('crash', () => {
    console.error('浏览器页面崩溃');
    void context.close();
  });
  const errors: string[] = [];
  const downloads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/__third-party/') || /\.exe(?:$|\?)/i.test(request.url()))
      downloads.push(request.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/?debug=1${process.env.RA2_BROWSER_MAIN_THREAD === '1' ? '&vm-worker=0' : ''}`);
  console.log('storage-before', await page.evaluate(() => navigator.storage.estimate()));
  if (process.env.RA2_BROWSER_STORAGE_QUOTA_BYTES) {
    const quotaSize = Number(process.env.RA2_BROWSER_STORAGE_QUOTA_BYTES);
    assert.ok(Number.isSafeInteger(quotaSize) && quotaSize > 0, '测试存储配额必须为正整数');
    const session = await context.newCDPSession(page);
    await session.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin, quotaSize });
    console.log('storage-override', quotaSize);
    // The quota override is tied to the CDP session; keep it until context.close, as early detach removes the override.
    assert.equal((await page.evaluate(() => navigator.storage.estimate())).quota, quotaSize, '配额覆盖必须实际生效');
  }

  await dismissGameGuide(page);
  await page.getByRole('button', { name: '加载游戏', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: folder ? '选择文件夹…' : '选择文件…', exact: true }).click();
  await (await chooser).setFiles(folder ?? archive!);
  await detectedGameOption(page, game).check({ timeout: 120000 });
  await expect(page.getByRole('button', { name: '启动游戏', exact: true })).toBeEnabled({ timeout: 120000 });
  // Refresh before the first launch: uploading alone must publish the imported package.
  await page.reload();
  await dismissGameGuide(page);
  await selectImportedGame(page, game);
  for (let launch = 0; launch < 2; launch++) {
    if (launch) {
      await page.reload();
      await dismissGameGuide(page);
      await selectImportedGame(page, game);
    }
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector<HTMLCanvasElement>('#screen');
        const status = canvas?.dataset.vmStatus ?? '';
        return canvas?.dataset.shellPage?.includes('MainMenu') || /exited|error|blocked/.test(status);
      },
      undefined,
      { timeout: 120000 },
    );
    const state = await page.locator('#screen').evaluate((el) => ({ ...(el as HTMLElement).dataset }));
    console.log('launch', launch, { status: state.vmStatus, page: state.shellPage });
    assert.equal(
      await page.evaluate(() => localStorage.getItem('ra2-vm-preferred-game')),
      game,
      '测试必须实际启动所选游戏',
    );
    console.log('storage', await page.evaluate(() => navigator.storage.estimate()));
    await page.screenshot({ path: `/tmp/${game}-cache-launch-${launch}.png` });
    assert.ok(state.shellPage?.includes('MainMenu'), `第 ${launch + 1} 次启动失败：${JSON.stringify(state)}`);
    if (!launch) {
      const indicator = page.locator('#vm-resource-status');
      if (await indicator.count()) {
        await page.waitForFunction(
          () => document.getElementById('vm-resource-status')?.dataset.phase !== 'loading',
          null,
          { timeout: 120000 },
        );
        assert.equal(await indicator.getAttribute('data-phase'), 'complete');
      }
    }
    const cached = await page.evaluate(async () => {
      const url = '/src/platform/browser/files/importedResources.ts';
      const { loadImportedResources } = await import(url);
      return [...(await loadImportedResources()).original.files.keys()] as string[];
    });
    const executable = game === 'ra2' ? 'game.exe' : 'gamemd.exe';
    assert.ok(cached.includes(executable), '缓存必须包含资源包主程序');
    const digest = await page.evaluate(async (name) => {
      const url = '/src/platform/browser/files/importedResources.ts';
      const { loadImportedResources } = await import(url);
      const bytes = await (await loadImportedResources()).original.files.get(name).arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }, executable);
    if (process.env.RA2_BROWSER_EXE_SHA256) assert.equal(digest, process.env.RA2_BROWSER_EXE_SHA256);
    console.log('cache', { files: cached.length, executable });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, [], '导入与恢复不能请求外部 EXE');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
