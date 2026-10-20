import { chromium, expect } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
import { localizeText, resolveLocale } from '../../../src/ui/shared/i18n/translate';
import type { VmExecutionSample } from '../../../src/vm86/diagnostics';

type RestoredExecutionSample = VmExecutionSample & { restored: boolean };

/** Real v86 instrumentation and UI lifecycle with synthetic inputs; no game assets. */
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // A tiny synthetic BIOS exercises the real v86 scheduler/JIT without allocating a game's 640 MiB guest.
  // This validates instrumentation, not game performance or compatibility.
  const executionPage = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(executionPage);
  await executionPage.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
  const executionScript = `(async () => {
    const { createBrowserEmulator } = await import(location.origin + '/src/platform/browser/emulator.ts');
    const { BrowserEmulatorProbe } = await import(location.origin + '/src/platform/browser/emulatorProbe.ts');
    const bios = new Uint8Array(65536);
    bios.set([0xfa, 0xeb, 0xfe]); // CLI; JMP to itself. Host CPU slices still yield normally.
    bios.set([0xea, 0, 0, 0, 0xf0], 65520); // Reset vector: far JMP F000:0000.
    const probe = new BrowserEmulatorProbe();
    const emulator = createBrowserEmulator({wasm_path:location.origin + '/node_modules/v86/build/v86.wasm',
      memory_size:32*1024*1024,bios:{buffer:bios.buffer},autostart:false,
      disable_keyboard:true,disable_mouse:true,disable_speaker:true},probe);
    try {
      await new Promise(resolve => emulator.add_listener('emulator-ready',resolve));
      const engine = emulator.v86;
      const original = engine.cpu.main_loop;
      probe.start();
      await emulator.run();
      const deadline = performance.now() + 10_000;
      while (probe.sample().cpuSlices.count < 3 && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve,100));
      }
      await emulator.stop();
      probe.stop();
      return {...probe.sample(),restored:engine.cpu.main_loop === original};
    } finally { await emulator.destroy(); }
  })()`;
  for (const worker of [false, true]) {
    const sample = worker
      ? await executionPage.evaluate<RestoredExecutionSample>(`new Promise((resolve,reject) => {
        const script = ${JSON.stringify(executionScript)};
        const url = URL.createObjectURL(new Blob([script + '.then(value=>postMessage({value}),error=>postMessage({error:String(error)}));'],{type:'text/javascript'}));
        const worker = new Worker(url,{type:'module'});
        const finish = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); };
        const timer = setTimeout(() => { finish(); reject(new Error('synthetic v86 Worker probe timed out')); },15000);
        worker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.value); };
        worker.onerror = event => { finish(); reject(new Error(event.message)); };
      })`)
      : await executionPage.evaluate<RestoredExecutionSample>(executionScript);
    expect(sample.supported).toBe(true);
    expect(sample.scheduler).toBe(worker ? 'message-channel' : 'upstream-worker');
    expect(sample.jitDisabled).toBe(false);
    expect(sample.cpuSlices.count, JSON.stringify(sample)).toBeGreaterThan(0);
    expect(sample.immediateWaits.count).toBeGreaterThan(0);
    expect(sample.active).toBe(false);
    expect(sample.restored).toBe(true);
    console.log(worker ? 'Worker' : 'main-thread', 'real v86 probe and restoration passed');
  }
  await executionPage.close();
  for (const locale of ['zh-CN', 'en-US']) {
    const text = (value: string) => localizeText(value, resolveLocale([locale]));
    const page = await browser.newPage({
      locale,
      ignoreHTTPSErrors: true,
      viewport: locale === 'zh-CN' ? { width: 844, height: 390 } : { width: 390, height: 844 },
      hasTouch: true,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    const notice = page.locator('#landscape-notice');
    if (locale === 'en-US') {
      await expect(notice).toBeVisible();
      await expect(notice.locator('h1')).toHaveText(text('转至横屏，立即开玩'));
      await page.locator('.game-source-picker').waitFor({ state: 'attached' });
      await expect(page.locator('.game-source-picker')).toBeHidden();
      await page.setViewportSize({ width: 844, height: 390 });
    }
    await expect(notice).toBeHidden();
    await page.getByRole('button', { name: text('加载游戏'), exact: true }).waitFor();
    await page.evaluate(`(async () => {
      const state = await import('/src/ui/pages/game/state/uiState.ts');
      const { collectPerformanceReport } = await import('/src/ui/pages/game/performanceDiagnostics.ts');
      const { FramePresenter } = await import('/src/graphics/framePresenter.ts');
      state.cancelSourceRequest();
      const props = state.toolbarState.getSnapshot();
      const presenter = new FramePresenter({clear(){},destroy(){},draw(){}}, {targetSize:()=>({width:800,height:600})});
      const calls = globalThis.__diagnosticCalls = [];
      const vm = {
        runtimeInfo: { mode:'main-thread',reason:'probe-failed',workerProbeMs:3001,fallbackReason:'synthetic probe timeout' },
        async getDiagnostics(action) {
          calls.push(action);
          return { sampledAtMs:performance.now(),phase:'running',hypercalls:calls.length,clockRate:1,execution:null,game:null };
        }
      };
      const callbacks = {...props.callbacks, onCollectPerformance: (signal, progress) => collectPerformanceReport({
        vm, signal, progress, canvas:props.canvas, presenter,
        renderer:{backend:'Canvas 2D',detail:'synthetic UI test'},gameId:null,sourceKind:'synthetic',
        settings:()=>({rate:1,resolution:'800x600',upscaleMode:'off',reshadeMode:'off'})
      })};
      state.toolbarState.set({...props, model:{...props.model,mapsAvailable:true}, callbacks});
      // Stop the page's toolbar publisher from replacing this explicitly synthetic target.
      const originalSet = state.toolbarState.set.bind(state.toolbarState);
      state.toolbarState.set = next => originalSet(next && next.callbacks !== callbacks ? {...next, model:{...next.model,mapsAvailable:true},callbacks} : next);
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{ async writeText(text) {globalThis.__copiedReport=text;} }});
      globalThis.__disposeDiagnostics = () => { state.toolbarState.set = originalSet; originalSet(null); presenter.destroy(); };
    })()`);
    const button = page.locator('#vm-performance-diagnostics');
    await button.click();
    const dialog = page.getByRole('dialog', { name: text('性能诊断'), exact: true });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.height).toBeLessThanOrEqual(viewport.height);
    await dialog.getByRole('button', { name: text('开始 20 秒采样'), exact: true }).click();
    await expect(dialog).toBeHidden();
    if (locale === 'en-US') {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(notice).toBeVisible();
      await expect(button).toBeHidden();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(notice).toBeHidden();
      await expect(button).toBeVisible();
    }
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const reportText = dialog.getByRole('textbox', { name: text('性能诊断报告') });
    const report = JSON.parse(await reportText.inputValue());
    expect(report.status).toBe('complete');
    expect(report.durationMs).toBeGreaterThanOrEqual(20_000);
    expect(report.runtime.reason).toBe('probe-failed');
    expect(report.samples.length).toBeGreaterThan(10);
    expect(report.summary.nativeLogicFps).toBeNull();
    expect(report.summary.rafFps).toBeGreaterThan(0);
    expect(report.samples.at(-1).host.mainThreadLongTasks).not.toBeUndefined();
    await dialog.getByRole('button', { name: text('复制报告'), exact: true }).click();
    expect(await page.evaluate('globalThis.__copiedReport')).toBe(await reportText.inputValue());
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {configurable:true,value:undefined})`);
    await dialog.getByRole('button', { name: text('复制报告'), exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText(text('无法自动复制，请长按报告文字选择并复制。'));
    await dialog.getByRole('button', { name: text('开始 20 秒采样'), exact: true }).click();
    await button.click();
    await dialog.getByRole('button', { name: text('停止采样'), exact: true }).click();
    await expect(reportText).toHaveValue(/"status": "cancelled"/);
    await dialog.getByRole('button', { name: text('开始 20 秒采样'), exact: true }).click();
    await page.evaluate('globalThis.__disposeDiagnostics()');
    await expect.poll(() => page.evaluate('globalThis.__diagnosticCalls.at(-1)')).toBe('stop');
    await expect(dialog).toHaveCount(0);
    const count = await page.evaluate('globalThis.__diagnosticCalls.length');
    await page.waitForTimeout(1200);
    expect(await page.evaluate('globalThis.__diagnosticCalls.length')).toBe(count);
    expect(errors).toEqual([]);
    console.log(locale, 'diagnostic report, copy fallback, cancellation and disposal passed');
    await page.close();
  }
} finally {
  await browser.close();
}
