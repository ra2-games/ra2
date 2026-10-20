import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import type { GamePerformanceSample } from '../../../src/games/performance';
import { summarizeGamePerformance } from '../../helpers/gamePerformance';
/** Direct battle startup with real assets: send no guest mouse or keyboard events after resource selection. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
mkdirSync(screenshotDirectory, { recursive: true });
const games = process.env.RA2_BROWSER_GAME ? [process.env.RA2_BROWSER_GAME] : ['ra2', 'yr'];
const modes = process.env.VM_BROWSER_MODE ? [process.env.VM_BROWSER_MODE] : ['worker', 'main'];
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  for (const game of games)
    for (const mode of modes) {
      assert.ok(game === 'ra2' || game === 'yr');
      assert.ok(mode === 'worker' || mode === 'main');
      const context = await browser.newContext({
        locale: 'zh-CN',
        ignoreHTTPSErrors: true,
        viewport: { width: 1000, height: 800 },
      });
      await context.addInitScript((game) => localStorage.setItem(`vm-resolution-${game}`, '800x600'), game);
      // Read-only test probe: verify units exist for the native local House, without replacing the EXE or writing game state.
      const abi =
        game === 'ra2'
          ? { local: 0xa35db4, human: 0x134, units: 0x5434, dead: 0x13d }
          : { local: 0xa83d4c, human: 0x1ec, units: 0x5518, dead: 0x1f5 };
      const probe = (core: string) => `globalThis.__battleGamePerformance = () => (${core})?.getGamePerformance();
globalThis.__battleStartSnapshot = () => {
      const s=(${core})?.shim; if(!s) return null;
      const house=s.readU32(${abi.local}); if(!house) return null;
      const units=s.readU32(house+${abi.units}), size=s.readU32(house+${abi.units}+4);
      let total=0;
      if(units && size>0 && size<=4096) for(let i=0;i<size;i++) total+=s.readU32(units+i*4);
      return {human:s.readU8(house+${abi.human}),dead:s.readU8(house+${abi.dead}),units:total};
    };`;
      const module = mode === 'worker' ? 'vmWorker' : 'runtime';
      await context.route(`**/src/adapter/${module}.ts*`, async (route) => {
        const response = await route.fetch(),
          source = await response.text();
        const marker =
          mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
        assert.ok(source.includes(marker), '只读探针入口已变更');
        const replacement =
          mode === 'worker'
            ? `const controller = installVmWorker(self);${probe('controller.core')}`
            : `${marker}${probe('this.core')}`;
        await route.fulfill({ response, body: source.replace(marker, replacement) });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/?debug=1&start-page=battle${mode === 'main' ? '&vm-worker=0' : ''}`);
      await selectDevelopmentGame(page, game);
      // YR loads an order of magnitude more archive data than RA2 (CI observed ~2.5 min vs a few seconds),
      // so a shared timeout would treat its healthy startup as a failure under runner load.
      const battleStartupTimeout = game === 'yr' ? 300_000 : 150_000;
      try {
        // Temporary shell absence during loading is not success; require battlefield pixels, the sidebar, and continuing frame updates.
        await page.waitForFunction(
          () => {
            const c = document.querySelector<HTMLElement>('#screen');
            const [edge, field] = (c?.dataset.vmBattlefield ?? '').split(',').map(Number);
            return (
              JSON.parse(c?.dataset.vmStatus ?? '{}').phase === 'running' &&
              !c?.dataset.shellPage &&
              edge! > 0.01 &&
              field! > 0.1
            );
          },
          null,
          { timeout: battleStartupTimeout },
        );
        const snapshot = async () => {
          const target = mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts'))! : page;
          return target.evaluate(() => (globalThis as any).__battleStartSnapshot?.());
        };
        await expect
          .poll(
            async () => {
              const state = await snapshot();
              return state?.human === 1 && state.dead === 0 && state.units > 0;
            },
            { timeout: battleStartupTimeout },
          )
          .toBe(true);
        // Loading screens can also contain many colorful pixels. Wait for native units to exist before checking sustained frame output.
        const frame = Number(await page.locator('#screen').getAttribute('data-vm-frame'));
        await page.waitForFunction(
          (frame) => Number(document.querySelector<HTMLElement>('#screen')?.dataset.vmFrame) > frame + 120,
          frame,
          { timeout: 60000 },
        );
        assert.equal(await page.locator('#screen').getAttribute('data-shell-page'), null);
        assert.deepEqual(errors, []);
        const target = mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts'))! : page;
        const samples: GamePerformanceSample[] = [];
        for (let i = 0; i < 6; i++) {
          if (i) await page.waitForTimeout(1000);
          const sample = (await target.evaluate(() =>
            (globalThis as any).__battleGamePerformance(),
          )) as GamePerformanceSample | null;
          assert.ok(sample, '已知 EXE 的原生帧 hook 必须可用');
          samples.push(sample);
        }
        const report = summarizeGamePerformance(samples);
        writeFileSync(
          join(screenshotDirectory, `${game}-native-perf-${mode}.json`),
          JSON.stringify({ game, mode, samples, report }, null, 2),
        );
        assert.ok(report?.valid && report.logicFps > 0, '原生逻辑计数必须真实推进');
        console.log('[game-perf]', game, mode, JSON.stringify(report));
        // Exercise the same opt-in capture the phone user opens, including Worker RPC and native counters.
        await page.locator('#vm-performance-diagnostics').click();
        const diagnosticDialog = page.getByRole('dialog', { name: '性能诊断', exact: true });
        await diagnosticDialog.getByRole('button', { name: '开始 20 秒采样', exact: true }).click();
        await expect(diagnosticDialog).toBeHidden();
        await expect(diagnosticDialog).toBeVisible({ timeout: 45_000 });
        const diagnostic = JSON.parse(
          await diagnosticDialog.getByRole('textbox', { name: '性能诊断报告' }).inputValue(),
        );
        writeFileSync(
          join(screenshotDirectory, `${game}-diagnostics-${mode}.json`),
          JSON.stringify(diagnostic, null, 2),
        );
        assert.equal(diagnostic.status, 'complete');
        assert.equal(diagnostic.runtime.mode, mode === 'worker' ? 'worker' : 'main-thread');
        assert.ok(diagnostic.summary.nativeLogicFps > 0, '诊断必须读取实际推进的原生计数');
        const execution = diagnostic.samples.at(-1).vm.execution;
        assert.equal(execution.supported, true);
        assert.equal(execution.active, false, '采样结束后必须恢复原调度方法');
        assert.equal(execution.jitDisabled, false);
        assert.ok(execution.cpuSlices.count > 0 && execution.immediateWaits.count > 0, '实际 CPU 与调度必须被观测');
        assert.deepEqual(diagnostic.errors, []);
        await diagnosticDialog.getByRole('button', { name: '关闭', exact: true }).click();
        const afterCapture = await snapshot();
        assert.ok(afterCapture?.human === 1 && afterCapture.dead === 0 && afterCapture.units > 0);
        assert.deepEqual(errors, []);
        console.log('[diagnostics]', game, mode, diagnostic.runtime, diagnostic.summary);
        console.log(game, mode, '无客体输入直达战场通过');
      } finally {
        // A crashed renderer must not let a screenshot error replace the real failure; capture page state and
        // page errors first, then tolerate screenshot loss and always release the context.
        try {
          console.log(
            await page.locator('#screen').evaluate((c) => {
              const d = (c as HTMLElement).dataset;
              return { status: d.vmStatus, shell: d.shellPage, frame: d.vmFrame, pixels: d.vmBattlefield };
            }),
          );
        } catch (error) {
          console.log('页面状态读取失败（渲染进程可能已崩溃）', error);
        }
        if (errors.length) console.log('页面错误', errors);
        try {
          await page.screenshot({ path: join(screenshotDirectory, `${game}-battle-start-${mode}.png`) });
        } catch (error) {
          console.log('截图失败（渲染进程可能已崩溃）', error);
        }
        await context.close();
      }
    }
} finally {
  await browser.close();
}
