import { dismissGameGuide } from '../../helpers/selectDevelopmentGame';
/** Real browser startup benchmark: run pnpm run dev first, using game/ra2/ resources. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = new URL(process.env.RA2_STARTUP_URL ?? 'https://127.0.0.1:15174/');
url.searchParams.set('debug', '1');
const runs = Number(process.env.RA2_STARTUP_RUNS ?? 3);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10, 'RA2_STARTUP_RUNS 必须为 1..10');

const browser = await chromium.launch({
  headless: true,
  args: ['--js-flags=--max-old-space-size=4096'],
});
const samples: number[] = [];
try {
  for (let run = 1; run <= runs; run++) {
    // Create a new context each round, with a fresh page/Worker and empty save environment.
    const context = await browser.newContext({
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    try {
      await context.addInitScript(() => {
        localStorage.setItem('vm-resolution-ra2', '800x600');
        localStorage.removeItem('vm-clock-rate');
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await dismissGameGuide(page);
      await page.getByRole('button', { name: '加载游戏', exact: true }).click();
      const startButton = page
        .locator('.resource-upload-dialog')
        .getByRole('button', { name: '开发测试', exact: true });
      await startButton.waitFor();
      await page.evaluate(() => {
        const milestones: Record<string, number> = {};
        (window as unknown as { startupMilestones: typeof milestones }).startupMilestones = milestones;
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent === '开发测试')!;
        button.addEventListener(
          'click',
          () => {
            milestones.start = performance.now();
          },
          { once: true, capture: true },
        );
        new MutationObserver(() => {
          const canvas = document.querySelector<HTMLElement>('#screen');
          if (canvas?.dataset.vmFrame && !milestones.frame) milestones.frame = performance.now();
          if (canvas?.dataset.shellPage?.includes('MainMenu') && !milestones.menu) {
            milestones.menu = performance.now();
          }
        }).observe(document.body, { subtree: true, attributes: true });
      });
      await startButton.click();
      // The first frame includes startup imagery; startup completes only when the real main-menu title exists.
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector<HTMLElement>('#screen');
          const status = JSON.parse(canvas?.dataset.vmStatus ?? '{}') as { phase?: string; detail?: string };
          if (['error', 'blocked', 'exited'].includes(status.phase ?? '')) throw new Error(status.detail);
          return canvas?.dataset.shellPage?.includes('MainMenu');
        },
        undefined,
        { timeout: 60_000 },
      );
      const sample = await page.evaluate(() => {
        const times = (window as unknown as { startupMilestones: Record<string, number> }).startupMilestones;
        return { frame: Math.round(times.frame! - times.start!), menu: Math.round(times.menu! - times.start!) };
      });
      assert(sample.frame > 0 && sample.menu >= sample.frame, `启动里程碑无效：${JSON.stringify(sample)}`);

      // Actually click Single Player to verify that the menu still accepts input after timing optimizations.
      await page.waitForTimeout(1_000);
      const box = await page.locator('#screen').boundingBox();
      assert(box, '游戏画布不可见');
      await page.mouse.move(box.x + box.width * 0.3, box.y + (box.height * 220) / 600);
      await page.waitForTimeout(100);
      await page.mouse.move(box.x + (box.width * 720) / 800, box.y + (box.height * 220) / 600);
      await page.waitForTimeout(300);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>('#screen')?.dataset.shellPage?.toLowerCase().includes('singleplayer'),
        undefined,
        { timeout: 10_000 },
      );
      assert.deepEqual(errors, [], '浏览器出现未处理异常');
      samples.push(sample.menu);
      console.log(`第 ${run} 轮：首帧 ${sample.frame}ms，主菜单 ${sample.menu}ms；单人游戏菜单可点击`);
    } finally {
      await context.close();
    }
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const median = (sorted[Math.floor((runs - 1) / 2)]! + sorted[Math.floor(runs / 2)]!) / 2;
  console.log(`主菜单耗时：中位数 ${median}ms，范围 ${sorted[0]}..${sorted.at(-1)}ms`);
} finally {
  await browser.close();
}
