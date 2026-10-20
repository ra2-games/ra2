/** Local official ONNX -> real WebGPU Worker -> sampled output; no original game assets required, and models stay outside the repository. */
import { chromium, expect } from '@playwright/test';
import { PROBE_MODELS } from '../../../src/ui/pages/game/experiments/modelProbe';
const model = process.env.RA2_PROBE_MODEL;
const modelId = process.env.RA2_PROBE_MODEL_ID ?? 'ultra4x';
const selectedModel = PROBE_MODELS.find((candidate) => candidate.id === modelId);
if (!selectedModel) throw new Error(`未登记的模型：${modelId}`);
if (!model) throw new Error('请设置 RA2_PROBE_MODEL=/path/to/4x-UltraSharpV2_Lite_fp32_op17.onnx');
const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    ...(process.env.RA2_PROBE_SOFTWARE === '1' ? ['--use-angle=swiftshader'] : []),
  ],
});
try {
  const page = await browser.newPage({
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
  await page.getByRole('button', { name: '加载游戏', exact: true }).waitFor();
  await page.evaluate(async () => {
    const path = '/src/ui/pages/game/state/uiState.ts';
    const { toolbarState, cancelSourceRequest } = (await import(
      path
    )) as typeof import('../../../src/ui/pages/game/state/uiState');
    cancelSourceRequest();
    const current = toolbarState.getSnapshot()!;
    // Replace only the frame-sampling source; model validation, Worker, WebGPU, output, and UI all use the production implementation.
    current.callbacks.onCaptureProbe = (size) => {
      const padded = size + 32;
      const rgba = new Uint8ClampedArray(padded ** 2 * 4);
      for (let i = 0; i < padded ** 2; i++) {
        rgba[i * 4] = i % padded < padded / 2 ? 255 : 0;
        rgba[i * 4 + 1] = i % padded < padded / 2 ? 0 : 255;
        rgba[i * 4 + 3] = 255;
      }
      return { rgba, size: padded };
    };
    toolbarState.set({ ...current });
  });
  await page.locator('#vm-model-probe').click();
  const dialog = page.getByRole('dialog', { name: 'WebGPU 模型实验', exact: true });
  await dialog.locator(`input[name="probe-model"][value="${modelId}"]`).check();
  await dialog.getByLabel('选择本地模型').setInputFiles(model);
  await expect(dialog.getByRole('status')).toHaveText(/WebGPU 已就绪|模型实验失败/, { timeout: 120_000 });
  if (process.env.RA2_PROBE_EXPECT_NO_F16 === '1') {
    expect(await dialog.getByRole('status').innerText()).toContain('不支持 shader-f16');
    console.log('缺少 shader-f16 明确拒绝，不伪装为 FP16 推理');
    await dialog.getByRole('button', { name: '关闭并释放模型' }).click();
    await browser.close();
    process.exit(0);
  }
  expect(await dialog.getByRole('status').innerText()).toContain('WebGPU 已就绪');
  await dialog.getByLabel('中心采样边长').fill('32');
  for (let i = 0; i < 2; i++) {
    await dialog.getByRole('button', { name: '采样并推理' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/ms\/块|模型实验失败|超过 120 秒/, { timeout: 125_000 });
    const status = await dialog.getByRole('status').innerText();
    expect(status).toContain('ms/块');
    console.log(status);
    await expect(dialog.locator('canvas')).toHaveCount(2);
    await expect(dialog.locator('canvas').last()).toHaveAttribute('width', String(32 * selectedModel.scale));
  }
  await page.screenshot({ path: '/tmp/ra2-model-probe-webgpu.png' });
  const activeWorkers = page.workers();
  expect(activeWorkers.length).toBeGreaterThan(0);
  const closed = Promise.all(
    activeWorkers.map((worker) => new Promise<void>((resolve) => worker.on('close', () => resolve()))),
  );
  // Closing during execution must release the Worker; slow inference must not later write into a closed React dialog.
  await dialog.getByRole('button', { name: '采样并推理' }).click();
  await dialog.getByRole('button', { name: '关闭并释放模型' }).click();
  await closed;
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
} finally {
  await browser.close();
}
