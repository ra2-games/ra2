import { dismissGameGuide, selectImportedGame } from '../../helpers/selectDevelopmentGame';
import assert from 'node:assert/strict';
import { chromium, expect, type Page } from '@playwright/test';

// Start Vite with RA2_GAME_ROOT pointing at the complete MO 3.3.6 installation.
const browser = await chromium.launch({ headless: true });
let testPage: Page | undefined;
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });
  const mode = process.env.MO_VM_MODE === 'main' ? 'main' : 'worker';
  const module = mode === 'worker' ? 'vmWorker' : 'runtime';
  // Read-only, test-only native-state observation; no production probe or guest writes.
  await context.route(`**/src/adapter/${module}.ts*`, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker =
      mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
    assert.ok(source.includes(marker));
    const core = mode === 'worker' ? 'controller.core' : 'this.core';
    const prefix = mode === 'worker' ? 'const controller = installVmWorker(self);' : marker;
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        `${prefix}
        globalThis.__moFrame = () => (${core})?.shim?.readU32(0xa8ed84) ?? 0;
        globalThis.__moSize = () => ({w: (${core}).shim.displayWidth, h: (${core}).shim.displayHeight});
        globalThis.__moWindows = () => {
          const shim = (${core})?.shim;
          return shim?.inspectWindowState().filter(w => shim.isWindowVisible(w.hwnd))
            .map(w => ({text: w.text, rect: shim.screenRect(w.hwnd)})) ?? [];
        };
        globalThis.__moFlush = () => (${core}).flushFiles();`,
      ),
    });
  });
  const page = await context.newPage();
  testPage = page;
  if (process.env.MO_SAVE_LOAD === '1') {
    // Incognito quota varies with host memory; provision room for the full package.
    const storage = await context.newCDPSession(page);
    await storage.send('Storage.overrideQuotaForOrigin', {
      origin: process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174',
      quotaSize: 8 * 1024 ** 3,
    });
    await storage.detach();
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') console.error(message.text());
  });
  await page.goto(
    `${process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174'}/?debug=1${process.env.MO_VM_MODE === 'main' ? '&vm-worker=0' : ''}`,
  );
  await dismissGameGuide(page);
  await page.getByRole('button', { name: '加载游戏', exact: true }).click();
  if (process.env.MO_UPLOAD_DIR) await page.locator('input[webkitdirectory]').setInputFiles(process.env.MO_UPLOAD_DIR);
  if (process.env.MO_UPLOAD_DIR) await selectImportedGame(page, 'mo');
  else {
    await page.locator('.resource-upload-dialog input[value="mo"]').check();
    await page.getByRole('button', { name: '开发测试', exact: true }).click();
  }
  const menu = page.getByRole('region', { name: '心灵终结主菜单' });
  await menu.waitFor();
  assert.equal(
    page.workers().some((worker) => worker.url().includes('/vmWorker.ts')),
    false,
    'Opening the menu must not start a VM',
  );
  if (process.env.MO_MENU_SCREENSHOT) await page.screenshot({ path: process.env.MO_MENU_SCREENSHOT });
  const skirmish = process.env.MO_GAME_MODE === 'skirmish';
  await page.getByRole('button', { name: skirmish ? '遭遇战' : '战役任务', exact: true }).click();
  await page
    .getByRole('combobox', { name: skirmish ? '选择地图' : '选择任务', exact: true })
    .selectOption({ index: Number(process.env.MO_SELECTION_INDEX ?? 2) });
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await expect
    .poll(
      async () => {
        const target =
          mode === 'worker' ? page.workers().find((worker) => worker.url().includes('/vmWorker.ts')) : page;
        return target ? target.evaluate(() => (globalThis as any).__moFrame?.() ?? 0) : 0;
      },
      { timeout: 360000, intervals: [1000] },
    )
    .toBeGreaterThan(120);
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector<HTMLCanvasElement>('#screen');
      const status = JSON.parse(canvas?.dataset.vmStatus ?? '{}');
      if (['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
      const [edge, field] = (canvas?.dataset.vmBattlefield ?? '').split(',').map(Number);
      return status.phase === 'running' && !canvas?.dataset.shellPage && edge! > 0.01 && field! > 0.1;
    },
    undefined,
    { timeout: 360000 },
  );
  const initialFrame = await page.locator('#screen').getAttribute('data-vm-frame');
  await page.waitForFunction(
    (initial) => Number(document.querySelector<HTMLElement>('#screen')?.dataset.vmFrame) > Number(initial) + 120,
    initialFrame,
    { timeout: 90000 },
  );
  assert.deepEqual(errors, []);
  if (process.env.MO_SCREENSHOT) await page.screenshot({ path: process.env.MO_SCREENSHOT });
  console.log('Mental Omega browser mission rendered and continued updating');
  if (process.env.MO_SAVE_LOAD === '1') {
    assert.ok(process.env.MO_UPLOAD_DIR, 'Save/cold-load requires an uploaded installation');
    const target = () => (mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts'))! : page);
    const nativeButton = async (text: string) => {
      const rect = async () =>
        target().evaluate((label) => (globalThis as any).__moWindows().find((w: any) => w.text === label)?.rect, text);
      await expect.poll(rect, { timeout: 60000 }).toBeTruthy();
      await page.waitForTimeout(2500);
      const box = await rect();
      const canvas = await page.locator('#screen').boundingBox();
      const size = await target().evaluate(() => (globalThis as any).__moSize());
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => !document.pointerLockElement);
      console.log('Native control', text, { box, canvas, size });
      await page.mouse.click(
        canvas!.x + ((box.x + box.width / 2) * canvas!.width) / size.w,
        canvas!.y + ((box.y + box.height / 2) * canvas!.height) / size.h,
      );
    };
    await page.locator('#screen').click({ position: { x: 300, y: 200 } });
    await page.keyboard.press('Backquote');
    await page.keyboard.press('Escape');
    await nativeButton('GUI:SaveGame');
    await nativeButton('GUI:Save');
    await expect
      .poll(() => target().evaluate(() => (globalThis as any).__moWindows().some((w: any) => w.text === 'GUI:OK')), {
        timeout: 60000,
      })
      .toBe(true);
    await target().evaluate(() => (globalThis as any).__moFlush());
    const savedFrame = await target().evaluate(() => (globalThis as any).__moFrame());
    await page.reload();
    if (process.env.MO_UPLOAD_DIR) {
      await dismissGameGuide(page);
      await selectImportedGame(page, 'mo');
    }
    await page.getByRole('button', { name: '加载存档', exact: true }).click();
    const saves = page.getByRole('combobox', { name: '选择存档' });
    const slot = await saves
      .locator('option')
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value).find((path) => /(?:^|\/)save[0-9a-f]+\.sav$/i.test(path)),
      );
    assert.ok(slot, 'The browser-persisted native save must appear after refresh');
    await saves.selectOption(slot);
    await page.getByRole('button', { name: '加载存档', exact: true }).click();
    await expect
      .poll(
        async () => {
          const vm = mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts')) : page;
          return vm ? vm.evaluate(() => (globalThis as any).__moFrame?.() ?? 0) : 0;
        },
        { timeout: 360000 },
      )
      .toBeGreaterThan(savedFrame + 60);
    assert.deepEqual(errors, []);
    console.log('MO saved through native UI and cold-loaded through the browser menu');
  }
  if (process.env.MO_UPLOAD_DIR) {
    await page.reload();
    if (process.env.MO_UPLOAD_DIR) {
      await dismissGameGuide(page);
      await selectImportedGame(page, 'mo');
    }
    await page.getByRole('region', { name: '心灵终结主菜单' }).waitFor({ timeout: 90000 });
    assert.equal(
      page.workers().some((worker) => worker.url().includes('/vmWorker.ts')),
      false,
      'Restoring uploaded resources must return to the menu without starting a VM',
    );
    assert.equal(await page.evaluate(() => (globalThis as any).__moFrame?.() ?? 0), 0);
    assert.deepEqual(errors, []);
    console.log('Uploaded resources restored to the Mental Omega menu after refresh');
  }
} catch (error) {
  if (testPage) {
    console.error((await testPage.locator('body').innerText()).slice(-2000));
    if (process.env.MO_SCREENSHOT) await testPage.screenshot({ path: process.env.MO_SCREENSHOT });
  }
  throw error;
} finally {
  await browser.close();
}
