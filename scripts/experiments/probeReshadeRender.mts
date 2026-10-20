/** Development probe for external LaserBlit compiler output on real RA2 frames; does not load plugin DLLs. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { selectDevelopmentGame } from '../../tests/helpers/selectDevelopmentGame';

const shaderPath = process.env.RA2_LASER_GLSL;
assert.ok(shaderPath, '设置 RA2_LASER_GLSL 为外部 FX 编译器生成的 LaserBlit GLSL 文件');
const source = await readFile(shaderPath, 'utf8');
const output = resolve(process.env.RA2_POST_OUTPUT ?? '.tmp-reshade-render');
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
  // Redraw the same frame within one browser task so different starts or simulation progress cannot distort the image comparison.
  const result = await page.evaluate(async (source) => {
    const moduleUrl = '/src/graphics/experimental/reshadeLaser.ts';
    const { createReshadeLaser } = await import(/* @vite-ignore */ moduleUrl);
    const g = globalThis as any,
      renderer = g.__postRenderer,
      args = g.__postArgs;
    const canvas = document.querySelector('#screen') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const read = () => {
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    renderer.draw(...args);
    const original = canvas.toDataURL(),
      base = read();
    renderer.setPostProcess((gl: WebGL2RenderingContext) => createReshadeLaser(gl, source, () => null));
    renderer.draw(...args);
    const passthrough = canvas.toDataURL(),
      plain = read();
    let differences = 0;
    for (let i = 0; i < base.length; i++) differences += base[i] !== plain[i] ? 1 : 0;
    // This input only verifies shader participation in real-frame presentation; it does not establish extraction of the original plugin's game data.
    renderer.setPostProcess((gl: WebGL2RenderingContext) =>
      createReshadeLaser(gl, source, () => ({
        inGame: true,
        topMask: { width: 1, height: 1, rgba: new Float32Array([0, 0, 0, 1]) },
        distortion: { width: 1, height: 1, rgba: new Float32Array([0.505, 0.5, 0, 1]) },
      })),
    );
    renderer.draw(...args);
    const diagnostic = canvas.toDataURL(),
      changed = read();
    let diagnosticDifferences = 0;
    for (let i = 0; i < base.length; i++) diagnosticDifferences += base[i] !== changed[i] ? 1 : 0;
    renderer.setPostProcess(null);
    renderer.draw(...args);
    const restored = read();
    let restoredDifferences = 0;
    for (let i = 0; i < base.length; i++) restoredDifferences += base[i] !== restored[i] ? 1 : 0;
    return {
      original,
      passthrough,
      diagnostic,
      differences,
      diagnosticDifferences,
      restoredDifferences,
      error: gl.getError(),
      width: canvas.width,
      height: canvas.height,
    };
  }, source);
  for (const name of ['original', 'passthrough', 'diagnostic'] as const)
    await writeFile(join(output, `${name}.png`), Buffer.from(result[name].split(',')[1], 'base64'));
  const { original: _a, passthrough: _b, diagnostic: _c, ...metrics } = result;
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      { scope: '真实 RA2 帧；扰动为诊断输入，未桥接原插件游戏数据', ...metrics, before, after, errors },
      null,
      2,
    ),
  );
  assert.equal(result.differences, 0, '无游戏数据时应逐像素直通');
  assert.ok(result.diagnosticDifferences > 0, '诊断效果未影响画面');
  assert.equal(result.restoredDifferences, 0, '关闭未恢复原帧');
  assert.equal(result.error, 0);
  assert.deepEqual(errors, []);
  console.log(metrics);
} catch (error) {
  await writeFile(join(output, 'failure.txt'), String(error));
  await page.screenshot({ path: join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
