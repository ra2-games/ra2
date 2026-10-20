import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
/** Real RA2/YR executables: verify Worker and main-thread direct startup to settings and the LAN lobby, preserving the default entry. Requires local game assets. */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const relay = process.env.RA2_BROWSER_RELAY;
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? tmpdir();
assert.ok(!process.env.RA2_BROWSER_GAME || ['ra2', 'yr'].includes(process.env.RA2_BROWSER_GAME));
assert.ok(
  !process.env.RA2_BROWSER_STARTUP_MODE ||
    ['worker', 'main', 'default', 'lan-worker', 'lan-main'].includes(process.env.RA2_BROWSER_STARTUP_MODE),
);
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  for (const game of ['ra2', 'yr'].filter(
    (game) => !process.env.RA2_BROWSER_GAME || process.env.RA2_BROWSER_GAME === game,
  ))
    for (const mode of ['worker', 'main', 'default', 'lan-worker', 'lan-main'].filter(
      (mode) => !process.env.RA2_BROWSER_STARTUP_MODE || process.env.RA2_BROWSER_STARTUP_MODE === mode,
    )) {
      const context = await browser.newContext({
        locale: 'zh-CN',
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(() => localStorage.setItem('vm-resolution-ra2', '800x600'));
      // Do not intercept or replace EXE responses; the actual override propagation mechanism must handle different versions in the development directory.
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const lan = mode.startsWith('lan-');
      await page.goto(
        `${origin}/?debug=1${lan ? '&network=1&start-page=lan' + (relay ? '&relay=' + encodeURIComponent(relay) : '') : ''}${mode === 'lan-main' ? '&vm-worker=0' : ''}${mode === 'main' ? '&start-page=skirmish&vm-worker=0' : ''}`,
      );
      // Restart into the page from the runtime sidebar for the Worker; retain URL compatibility coverage on the main thread.
      if (mode === 'worker') {
        await selectDevelopmentGame(page, game);
        await page.waitForFunction(
          () => document.querySelector('#screen')?.getAttribute('data-shell-page')?.includes('MainMenu'),
          null,
          { timeout: 90000 },
        );
        await page.locator('#vm-quick-start').click();
        const dialog = page.getByRole('dialog', { name: '快速开局', exact: true });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.has('start-page'), false);
        await page.locator('#vm-quick-start').click();
        await Promise.all([
          page.waitForEvent('load'),
          dialog.getByRole('button', { name: '重启并进入遭遇战', exact: true }).click(),
        ]);
        // The development directory is not a persisted local package; reselect resources through the original flow after reload, without secretly injecting files.
      }
      await page.evaluate(() => {
        const canvas = document.querySelector('#screen')!;
        (window as any).__pages = [];
        new MutationObserver(() => {
          const title = (canvas as HTMLElement).dataset.shellPage;
          if (title) (window as any).__pages.push(title);
        }).observe(canvas, { attributes: true, attributeFilter: ['data-shell-page'] });
      });
      await selectDevelopmentGame(page, game);
      const target = mode === 'default' ? 'MainMenu' : lan ? 'GUI:Lobby' : 'Skirmish';
      await page.waitForFunction(
        (t) => (document.querySelector('#screen') as HTMLElement)?.dataset.shellPage?.includes(t),
        target,
        { timeout: 90000 },
      );
      const titles = await page.evaluate(() => (window as any).__pages as string[]);
      assert.ok(titles.length > 0);
      assert.ok(titles[0]!.includes(target), JSON.stringify(titles));
      // A silent fallback must not turn a requested Worker run into main-thread acceptance.
      const vmWorkers = page.workers().filter((worker) => /\/vmWorker\.[^/]+/.test(worker.url()));
      assert.equal(vmWorkers.length, mode === 'main' || mode === 'lan-main' ? 0 : 1);
      if (!lan) assert.equal(await page.locator('#vm-custom-maps').isEnabled(), true);
      if (lan) {
        await page.waitForFunction(
          () => document.querySelector('#vm-network-status')?.getAttribute('data-phase') === 'connected',
          null,
          { timeout: 30000 },
        );
      }
      if (mode !== 'default') assert.ok(titles.every((t) => !t.includes('MainMenu') && !t.includes('SinglePlayer')));
      // Wait for the next batch of game frames to avoid capturing an intermediate state with created but uncomposited controls.
      const frame = await page.locator('#screen').getAttribute('data-vm-frame');
      await page.waitForFunction(
        (f) => Number((document.querySelector('#screen') as HTMLElement).dataset.vmFrame) > Number(f) + 120,
        frame,
        { timeout: 30000 },
      );
      const screenshot = join(screenshotDirectory, `${game}-start-page-${mode}.png`);
      await page.screenshot({ path: screenshot });
      assert.deepEqual(errors, []);
      console.log(game, mode, { firstPage: titles[0], screenshot });
      await context.close();
    }
} finally {
  await browser.close();
}
