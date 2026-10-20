import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** No game assets: switch UI through real touch/mouse events without mistaking touch capability for a mobile device. */
import { chromium, expect } from '@playwright/test';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const viewport of [
    { width: 1440, height: 900, mobile: false },
    { width: 844, height: 390, mobile: false },
    { width: 390, height: 844, mobile: false },
    { width: 844, height: 390, mobile: true },
    { width: 390, height: 844, mobile: true },
    { width: 375, height: 667, mobile: true },
    { width: 430, height: 932, mobile: true },
    { width: 390, height: 844, mobile: true, locale: 'en-US' },
  ]) {
    const portraitViewport = viewport.width < viewport.height;
    // Keep the desktop UA while enabling touch to reproduce a coarse=true desktop/emulator environment.
    const context = await browser.newContext({
      locale: 'locale' in viewport ? viewport.locale : 'zh-CN',
      ignoreHTTPSErrors: true,
      hasTouch: true,
      isMobile: viewport.mobile,
      viewport: { width: viewport.width, height: viewport.height },
    });
    try {
      const page = await context.newPage();
      await preventThirdPartyDownloads(page);
      await page.goto(origin);
      await page.locator('.game-source-picker').waitFor({ state: 'attached' });
      if (portraitViewport) {
        await expect(page.locator('#landscape-notice')).toBeVisible();
        await expect(page.locator('.game-source-picker')).toBeHidden();
        await expect(page.locator('.ra2-menu-nav')).toBeHidden();
      }
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      await page.evaluate(async () => {
        const controlsUrl = '/src/ui/pages/game/touchControls.ts';
        const inputUrl = '/src/ui/pages/game/gameInput.ts';
        const toolbarUrl = '/src/ui/pages/game/runtimeToolbar.ts';
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const { cancelSourceRequest, gameRunning } = await import(stateUrl);
        cancelSourceRequest();
        const { installAdaptiveTouchControls } = (await import(
          controlsUrl
        )) as typeof import('../../../src/ui/pages/game/touchControls');
        const { installGameInput, installCanvasFit } = (await import(
          inputUrl
        )) as typeof import('../../../src/ui/pages/game/gameInput');
        const { installRuntimeToolbar } = (await import(
          toolbarUrl
        )) as typeof import('../../../src/ui/pages/game/runtimeToolbar');
        const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
        gameRunning.set(true);
        document.getElementById('ui')!.hidden = true;
        let frame = { width: 800, height: 600 };
        const fit = installCanvasFit(canvas, () => frame);
        const inputMessages: number[][] = [];
        const vm = {
          setCursorPosition() {},
          setKeyState() {},
          postMessage(...args: number[]) {
            inputMessages.push(args);
          },
        };
        const input = installGameInput(
          canvas,
          vm as unknown as import('../../../src/adapter/runtime').VmShell,
          false,
          undefined,
          () => frame,
        );
        const touch = installAdaptiveTouchControls(canvas, vm);
        const toolbar = installRuntimeToolbar(
          {
            onClockRate() {},
            onVolume() {},
            onPerformance() {},
            onSendCheatText() {},
            onSendCheatKey() {},
            async onResolution() {},
            async onChangeSource() {},
            async onDownloadSave() {},
            async onUploadSave() {
              return false;
            },
          },
          canvas,
          'Canvas 2D',
          '触屏 UI 回归',
        );
        Object.assign(window, {
          resizeTouchFrame(width: number, height: number) {
            frame = { width, height };
            fit(width, height);
          },
          cleanupTouchUi() {
            touch();
            input.cleanup();
            fit.destroy();
            toolbar.destroy();
          },
          touchInputMessages: inputMessages,
          originalTouchCanvas: canvas,
        });
      });

      await page.waitForSelector('#landscape-notice', { state: 'attached' });
      const notice = page.locator('#landscape-notice');
      const controls = page.locator('#vm-touch-controls');
      const joystick = page.locator('#vm-touch-joystick');
      const rail = page.locator('#vm-controls');
      const canvas = page.locator('#screen');
      await expect(page.locator('#root')).toHaveCSS('transform', 'none');
      if (portraitViewport) {
        await expect(notice).toBeVisible();
        await expect(notice.locator('h1')).toHaveText(
          'locale' in viewport ? 'Rotate to landscape and start playing' : '转至横屏，立即开玩',
        );
        await expect(canvas).toBeHidden();
        await expect(rail).toBeHidden();
        await expect(controls).toBeHidden();
        await expect(joystick).toBeHidden();
        await expect(page.locator('.agent-connection')).toBeHidden();
      } else await expect(notice).toBeHidden();
      const landscape = portraitViewport
        ? { width: viewport.height, height: viewport.width }
        : { width: viewport.width, height: viewport.height };
      await page.setViewportSize(landscape);
      await expect(notice).toBeHidden();
      await expect(canvas).toBeVisible();
      await expect(rail).toBeVisible();
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      const box = (await canvas.boundingBox())!;
      const x = box.x + box.width * 0.6;
      const y = box.y + box.height * 0.4;
      await page.mouse.click(x, y);
      await expect(controls).toBeHidden();
      await expect(rail).not.toHaveClass(/collapsed/);
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(joystick).toBeVisible();
      await expect(rail).toHaveClass(/collapsed/);
      const up = await page.evaluate(() =>
        (window as unknown as { touchInputMessages: number[][] }).touchInputMessages
          .filter(([message]) => message === 0x0202)
          .at(-1),
      );
      expect(up![2] & 0xffff).toBeCloseTo(480, -1);
      expect((up![2] >>> 16) & 0xffff).toBeCloseTo(240, -1);
      if (landscape.height <= 600) {
        const joystickDevice = await context.newCDPSession(page);
        const joystickBox = (await joystick.boundingBox())!;
        const centerX = joystickBox.x + joystickBox.width / 2;
        const centerY = joystickBox.y + joystickBox.height / 2;
        for (const { dx, dy, keys } of [
          { dx: 24, dy: 0, keys: [0x27] },
          { dx: 17, dy: 17, keys: [0x27, 0x28] },
          { dx: 0, dy: 24, keys: [0x28] },
          { dx: -17, dy: 17, keys: [0x25, 0x28] },
          { dx: -24, dy: 0, keys: [0x25] },
          { dx: -17, dy: -17, keys: [0x25, 0x26] },
          { dx: 0, dy: -24, keys: [0x26] },
          { dx: 17, dy: -17, keys: [0x27, 0x26] },
          { dx: 4, dy: 3, keys: [] },
        ]) {
          const clientDx = dx;
          const clientDy = dy;
          const start = await page.evaluate(
            () => (window as unknown as { touchInputMessages: number[][] }).touchInputMessages.length,
          );
          await joystickDevice.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: centerX, y: centerY }],
          });
          await joystickDevice.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: centerX + clientDx, y: centerY + clientDy }],
          });
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
          const down = await page.evaluate(
            (start) => [
              ...new Set(
                (window as unknown as { touchInputMessages: number[][] }).touchInputMessages
                  .slice(start)
                  .filter(([message]) => message === 0x100)
                  .map(([, key]) => key),
              ),
            ],
            start,
          );
          expect(down.sort(), `Joystick (${dx}, ${dy}) must follow the game axes`).toEqual(keys.sort());
          const knob = (await joystick.locator('.joystick-knob').boundingBox())!;
          expect(knob.x + knob.width / 2).toBeCloseTo(centerX + clientDx, 0);
          expect(knob.y + knob.height / 2).toBeCloseTo(centerY + clientDy, 0);
          await joystickDevice.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          const up = await page.evaluate(
            (start) => [
              ...new Set(
                (window as unknown as { touchInputMessages: number[][] }).touchInputMessages
                  .slice(start)
                  .filter(([message]) => message === 0x101)
                  .map(([, key]) => key),
              ),
            ],
            start,
          );
          expect(up.sort(), 'Releasing the joystick must release every held direction').toEqual(keys.sort());
        }
        await joystickDevice.detach();
      }
      await page.locator('#vm-touch-controls [data-role="collapse"]').tap();
      await expect(controls).toHaveClass(/collapsed/);
      await page.mouse.move(x, y);
      await page.mouse.move(x + 10, y + 10);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(controls).toHaveClass(/collapsed/);
      if (portraitViewport) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await expect(notice).toBeVisible();
        await expect(canvas).toBeHidden();
        await expect(controls).toBeHidden();
        await expect(joystick).toBeHidden();
        await page.setViewportSize(landscape);
        await expect(notice).toBeHidden();
        await expect(canvas).toBeVisible();
        expect(
          await page.evaluate(
            () =>
              document.getElementById('screen') ===
              (window as unknown as { originalTouchCanvas: HTMLCanvasElement }).originalTouchCanvas,
          ),
        ).toBe(true);
        await page.locator('#vm-controls-toggle').tap();
        await page.locator('#vm-fullscreen').tap();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'screen-frame');
        const fullscreenNotice = page.locator('#landscape-fullscreen-notice');
        const device = await context.newCDPSession(page);
        await device.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          mobile: viewport.mobile,
          deviceScaleFactor: 1,
        });
        await expect(fullscreenNotice).toBeVisible();
        await expect(notice).toBeHidden();
        await expect(canvas).toBeHidden();
        await device.send('Emulation.setDeviceMetricsOverride', {
          ...landscape,
          mobile: viewport.mobile,
          deviceScaleFactor: 1,
        });
        await expect(fullscreenNotice).toBeHidden();
        await expect(canvas).toBeVisible();
        const fullscreenBox = (await canvas.boundingBox())!;
        expect(fullscreenBox.width / fullscreenBox.height).toBeCloseTo(800 / 600, 2);
        await page.evaluate(() => document.exitFullscreen());
        await device.detach();
      }
      await page.evaluate(() => (window as unknown as { cleanupTouchUi(): void }).cleanupTouchUi());
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      console.log(
        `${viewport.width}x${viewport.height} mobile=${viewport.mobile}: landscape input, portrait notice, orientation changes and cleanup passed`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
