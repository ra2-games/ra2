/** Operate the ReShade dropdown in a real game; verify enhancement and restoration after disabling it against the same frame. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { selectDevelopmentGame } from '../../tests/helpers/selectDevelopmentGame';

const output = resolve(process.env.RA2_POST_OUTPUT ?? '.tmp-reshade-ui');
await mkdir(output);
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  locale: 'zh-CN',
  ignoreHTTPSErrors: true,
  viewport: { width: 1200, height: 900 },
});
await context.addInitScript(() => localStorage.setItem('vm-resolution-ra2', '800x600'));
await context.route('**/src/ui/pages/game/page.ts*', async (route) => {
  const response = await route.fetch(),
    code = await response.text();
  const marker = 'const calls';
  assert.ok(code.includes(marker));
  await route.fulfill({
    response,
    body: code.replace(
      marker,
      `globalThis.__postRenderer=frameRenderer;
    const originalDraw=frameRenderer.draw.bind(frameRenderer);
    frameRenderer.draw=(...args)=>{globalThis.__postArgs=args;originalDraw(...args);};
    ${marker}`,
    ),
  });
});
await context.addInitScript('globalThis.__name = (fn) => fn;');
await context.route('**/src/adapter/runtime.ts*', async (route) => {
  const response = await route.fetch(),
    code = await response.text();
  const marker = 'this.core = new VmCore(callbacks, source, platform);';
  assert.ok(code.includes(marker));
  await route.fulfill({ response, body: code.replace(marker, marker + 'globalThis.__postCore=this.core;') });
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`${process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15185'}/?start-page=battle&vm-worker=0`);
  await selectDevelopmentGame(page, 'ra2');
  await page.waitForFunction(`globalThis.__postArgs?.[0]?.width === 800`, {}, { timeout: 150000 });
  // Reuse read-only scene evidence from the RA2 MCV probe; this entry point is RA2-only and cannot be used for YR.
  await page.waitForFunction(
    `(()=>{const s=globalThis.__postCore?.shim;if(!s)return false;const h=s.readU32(0xa35db4);return h && s.readU32(h+0x5438)>0;})()`,
    {},
    { timeout: 150000 },
  );
  const before = await page.evaluate<number>('globalThis.__postCore.shim.readU32(0xa40d2c)');
  await page.waitForTimeout(3000);
  const after = await page.evaluate<number>('globalThis.__postCore.shim.readU32(0xa40d2c)');
  assert.ok(after > before, '原生模拟未推进');
  await page.evaluate('globalThis.__heldArgs=structuredClone(globalThis.__postArgs)');
  if ((await page.locator('#vm-controls-toggle').getAttribute('aria-expanded')) === 'false')
    await page.locator('#vm-controls-toggle').click();
  const captures: Record<string, string> = {};
  for (const [mode, label] of [
    ['off', '关闭'],
    ['enhance', '色彩 + 锐化'],
    ['compare', '左右对照'],
    ['off-again', '关闭'],
  ]) {
    await page.locator('#vm-reshade-toggle').click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.waitForTimeout(100);
    captures[mode!] = await page.evaluate<string>(
      `(()=>{globalThis.__postRenderer.draw(...globalThis.__heldArgs);return document.querySelector('#screen').toDataURL();})()`,
    );
    await writeFile(join(output, mode + '.png'), Buffer.from(captures[mode!]!.split(',')[1]!, 'base64'));
    if (mode === 'enhance') {
      assert.match(await page.locator('#vm-reshade-status').innerText(), /已开启/);
      await page.screenshot({ path: join(output, 'in-game-toolbar.png') });
    }
  }
  assert.equal(captures.off, captures['off-again'], '关闭应恢复同一帧');
  assert.notEqual(captures.off, captures.enhance, '增强应改变真实画面');
  assert.notEqual(captures.off, captures.compare, '左右对照应改变右半边');
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ before, after, restored: true, enhanced: true, errors }, null, 2),
  );
  console.log({ before, after, restored: true, enhanced: true });
} catch (error) {
  await writeFile(join(output, 'failure.txt'), String(error));
  await page.screenshot({ path: join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
