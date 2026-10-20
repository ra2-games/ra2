/** Synthetic rectangular frame -> real Nomos Worker -> full 2x frame; this is not a game FPS test. */
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15175');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/pages/game/experiments/liveModel.ts';
    const { LiveModel } = (await import(path)) as typeof import('../../../src/ui/pages/game/experiments/liveModel');
    const response = await fetch('/.tmp-models/nomosuni-span-2x-fp32.onnx');
    if (!response.ok) throw new Error('缺少 Nomos ONNX');
    const model = new LiveModel(() => {});
    try {
      await model.load(new File([await response.arrayBuffer()], 'nomos.onnx'), 'nomos2x');
      const frame = {
        width: 64,
        height: 48,
        rgba: new Uint8Array(64 * 48 * 4).fill(127),
        pixels: new Uint8Array(),
        palette: new Uint8Array(),
      };
      const start = performance.now();
      let result = model.frame(frame);
      while (!result && performance.now() - start < 120000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = model.frame(frame);
        if (model.status.includes('失败')) throw new Error(model.status);
      }
      return { width: result?.width, height: result?.height, status: model.status };
    } finally {
      model.destroy();
    }
  });
  expect([result.width, result.height]).toEqual([128, 96]);
  expect(result.status).toContain('NomosUni SPAN');
  console.log(result);
} finally {
  await browser.close();
}
