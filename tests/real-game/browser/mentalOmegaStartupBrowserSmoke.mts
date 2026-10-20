/** Import the supplied installation through normal UI and observe native simulation in both execution modes. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const output = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
const modes = process.env.VM_BROWSER_MODE ? [process.env.VM_BROWSER_MODE] : ['worker', 'main'];
assert.ok(process.env.VM_GAME_DIR, 'Set VM_GAME_DIR to the complete user-supplied Mental Omega installation');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const cdp = await browser.newBrowserCDPSession();
await cdp.send('Target.setDiscoverTargets', { discover: true });
cdp.on('Target.targetCrashed', (event) => console.log('BROWSER_TARGET_CRASH', JSON.stringify(event)));
try {
  for (const mode of modes) {
    assert.ok(mode === 'worker' || mode === 'main');
    const context = await browser.newContext({
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      viewport: { width: 1000, height: 800 },
    });
    try {
      await context.addInitScript(() => localStorage.setItem('vm-resolution-mo', '800x600'));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol)
          ? route.continue()
          : route.abort();
      });
      const module = mode === 'worker' ? 'vmWorker' : 'runtime';
      await context.route(`**/src/adapter/${module}.ts*`, async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const marker =
          mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
        assert.ok(source.includes(marker), 'Read-only probe entry changed');
        const core = mode === 'worker' ? 'controller.core' : 'this.core';
        const probe = `globalThis.__moStartupSnapshot = () => {
          const owner=(${core}); if(!owner) return null;
          const c=owner.emulator ? owner : owner.launcherCore;
          const vm=c?.emulator, shim=c?.shim;
          if(!vm || !shim) return { name:c?.source?.game?.executable, phase:c?.currentPhase };
          const read = p => { const b=vm.read_memory(p,4); return b.length===4 ? new DataView(b.slice().buffer).getUint32(0,true) : 0; };
          const house=read(0xa83d4c);
          return { name:c?.source?.game?.executable, phase:c?.currentPhase, frame:read(0xa8ed84),
            human:house ? vm.read_memory(house+0x1ec,1)[0] : 0,
            defeated:house ? vm.read_memory(house+0x1f5,1)[0] : 1 };
        };`;
        await route.fulfill({
          response,
          body: source.replace(
            marker,
            mode === 'worker' ? `const controller = installVmWorker(self);${probe}` : `${marker}${probe}`,
          ),
        });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (msg) => {
        if (['warning', 'error'].includes(msg.type())) console.log('browser', msg.type(), msg.text());
      });
      console.log(`MO ${mode}: importing the local installation`);
      await page.goto(`${origin}/?debug=1${mode === 'main' ? '&vm-worker=0' : ''}`);
      try {
        await selectDevelopmentGame(page, 'mo');
      } catch (error) {
        writeFileSync(join(output, `mo-import-${mode}.txt`), await page.locator('body').innerText());
        await page.screenshot({ path: join(output, `mo-import-${mode}.png`) });
        throw error;
      }
      const menu = page.getByRole('region', { name: '心灵终结主菜单' });
      await menu.getByRole('button', { name: '遭遇战', exact: true }).click();
      await menu.getByRole('combobox', { name: '选择地图' }).selectOption({ index: 1 });
      await menu.getByRole('button', { name: '开始游戏', exact: true }).click();
      console.log(`MO ${mode}: native launcher started`);
      const snapshot = async () => {
        const target =
          mode === 'worker' ? page.workers().find((worker) => worker.url().includes('/vmWorker.ts')) : page;
        return target?.evaluate(() => (globalThis as any).__moStartupSnapshot?.());
      };
      let lastObservation = 0;
      await expect
        .poll(
          async () => {
            const state = await snapshot();
            const status = await page.locator('#screen').getAttribute('data-vm-status');
            writeFileSync(
              join(output, `mo-progress-${mode}.json`),
              JSON.stringify({ state, status, errors, workers: page.workers().map((w) => w.url()) }, null, 2),
            );
            if (Date.now() - lastObservation >= 10000) {
              console.log('MO native observation', mode, JSON.stringify(state), status);
              lastObservation = Date.now();
            }
            const phase = JSON.parse(status ?? '{}').phase;
            if (['error', 'exited', 'blocked'].includes(phase)) throw new Error(status ?? 'Native runtime stopped');
            return state?.name === 'gamemd.exe' && state.frame > 120 && state.human === 1 && state.defeated === 0;
          },
          { timeout: 300000 },
        )
        .toBe(true)
        .catch(async (error) => {
          try {
            writeFileSync(join(output, `mo-failure-${mode}.txt`), await page.locator('body').innerText());
            await page.screenshot({ path: join(output, `mo-failure-${mode}.png`) });
          } catch {
            // Preserve the original failure if the renderer has already stopped.
          }
          throw error;
        });
      const before = await snapshot();
      await expect.poll(async () => (await snapshot())?.frame, { timeout: 60000 }).toBeGreaterThan(before.frame + 30);
      const state = JSON.parse((await page.locator('#screen').getAttribute('data-vm-status')) ?? '{}');
      assert.equal(state.phase, 'running');
      assert.deepEqual(errors, []);
      const latest = await snapshot();
      writeFileSync(join(output, `mo-native-${mode}.json`), JSON.stringify({ mode, before, latest, errors }, null, 2));
      await page.screenshot({ path: join(output, `mo-native-${mode}.png`) });
      console.log(`MO ${mode}: native simulation advanced`, latest);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
