import { GAME_MANIFESTS } from '../../../src/games/manifest';
import { localizeText, resolveLocale } from '../../../src/ui/shared/i18n/translate';
import { zipSync } from 'fflate';
import { detectedGameOption, dismissGameGuide, selectImportedGame } from '../../helpers/selectDevelopmentGame';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
import { WECHAT_GROUP_QR_URL } from '../../../src/ui/pages/game/groupQr';
/** React admission tests without game assets: one state-driven tree, file cancellation, dialog focus, and a stable canvas. */
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
try {
  for (const locale of ['zh-CN', 'en-US']) {
    const text = (value: string) => localizeText(value, resolveLocale([locale]));
    for (const requestedViewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      let viewport = requestedViewport;
      const context = await browser.newContext({ locale, ignoreHTTPSErrors: true, viewport });
      try {
        const page = await context.newPage();
        let qrRequests = 0;
        await page.route(WECHAT_GROUP_QR_URL, async (route) => {
          qrRequests++;
          if (qrRequests === 1) {
            await route.abort('failed');
            return;
          }
          await route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>',
          });
        });
        let runtimeModuleUrl = '';
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === '/src/ui/pages/game/page.ts') runtimeModuleUrl = response.url();
        });
        // tsx inserts this helper for named inline functions; the isolated browser evaluate context needs it too.
        await page.addInitScript('globalThis.__name = (value) => value');
        const errors: string[] = [];
        const failedResponses: string[] = [];
        const modelRequests: string[] = [];
        const themeRequests: string[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname.startsWith('/theme/ra2/')) themeRequests.push(url.href);
          // Vite's ?url returns a tiny JS module containing only the asset path, not the 25 MB WASM payload.
          if (!url.searchParams.has('url') && /ort[.-].*(?:wasm|bundle)|\.onnx(?:\?|$)/.test(url.href))
            modelRequests.push(url.href);
        });
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => {
          if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
        });
        page.on('console', (message) => {
          if (/React.*error|unmounted|flushSync was called|same container.*createRoot/i.test(message.text()))
            errors.push(message.text());
        });
        await preventThirdPartyDownloads(page);
        await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
        await expect(page.locator('html')).toHaveAttribute('lang', resolveLocale([locale]));
        // Error boundaries catch render failures, so pageerror alone cannot detect split React instances.
        await expect(page.locator('#screen, #root > [role="alert"]')).toHaveCount(1);
        expect(await page.locator('#root > [role="alert"]').allTextContents()).toEqual([]);
        const canvas = await page.locator('#screen').elementHandle();
        if (viewport.width < viewport.height && viewport.width <= 860) {
          await expect(page.locator('#landscape-notice')).toBeVisible();
          await expect(page.locator('#landscape-notice h1')).toHaveText(text('转至横屏，立即开玩'));
          await page.locator('.game-source-picker').waitFor({ state: 'attached' });
          await expect(page.locator('.game-source-picker')).toBeHidden();
          await expect(page.locator('.ra2-menu-nav')).toBeHidden();
          viewport = { width: viewport.height, height: viewport.width };
          await page.setViewportSize(viewport);
          await expect(page.locator('#landscape-notice')).toBeHidden();
          await expect(page.locator('.game-source-picker')).toBeVisible();
        }

        const guide = page.getByRole('dialog', { name: text('获取游戏'), exact: true });
        await expect(guide).toBeVisible();
        await expect(guide.locator('.get-game-disclaimer')).toHaveText(
          'EA has not endorsed and does not support this product.',
        );
        await expect(guide.locator('.get-game-disclaimer')).toBeInViewport();
        await expect(guide.locator('a[href="https://store.steampowered.com/app/2229850"]')).toHaveCount(1);
        await expect(guide.locator('a[href*="mental-omega-330"]')).toHaveCount(1);
        await expect(guide.locator('a[href*="mental-omega-336-patch-manual-update"]')).toHaveCount(1);
        await expect(
          page.locator('.game-source-picker').getByRole('button', { name: text('获取游戏'), exact: true }),
        ).toHaveCount(1);
        await expect(guide.locator('.network-toggle')).toHaveCount(0);
        await guide.getByRole('button', { name: text('知道了'), exact: true }).click();
        await expect(guide).toBeHidden();
        expect(await page.evaluate(() => localStorage.getItem('ra2-vm-game-guide-skipped'))).toBeNull();
        await page.getByRole('button', { name: text('获取游戏'), exact: true }).click();
        await expect(guide).toBeVisible();
        await guide.getByRole('button', { name: text('下次不再显示'), exact: true }).click();
        await expect(guide).toBeHidden();
        await expect(page.getByRole('button', { name: text('下载游戏'), exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: text('附加地图包…') })).toBeHidden();
        const mobileHome = viewport.width <= 560;
        await expect(page.locator('#root')).toHaveCSS('transform', 'none');
        const measureBackdrop = () =>
          page.locator('.ra2-panel').evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              image: style.backgroundImage,
              size: style.backgroundSize,
              position: style.position,
              coordinates: style.backgroundPosition,
            };
          });
        const backdrop = await measureBackdrop();
        expect(backdrop.image).toBe('none');
        expect(themeRequests).toEqual([]);
        await expect(page).toHaveTitle(text('红色警戒2 网页版') + ' · ra2.games');
        await expect(page.locator('.source-home-contact a')).toHaveAttribute('href', 'mailto:contact@ra2.games');
        await expect(page.locator('.source-home-contact')).toContainText(text('联系我们：'));
        await expect(page.locator('.game-source-picker .console-title').first()).toHaveText('RED ALERT 2');
        await expect(page.locator('.game-source-picker .console-domain').first()).toHaveText('https://ra2.games');
        if (mobileHome) {
          expect(
            await page
              .locator('.ra2-menu-btn')
              .first()
              .evaluate((node) => getComputedStyle(node, '::after').backgroundImage),
          ).toContain('radial-gradient');
          expect(
            await page.locator('.ra2-menu-header').evaluate((node) => getComputedStyle(node).backgroundImage),
          ).toBe('none');
          await page.getByRole('button', { name: text('联机设置'), exact: true }).click();
          await expect(page.getByRole('dialog', { name: text('联机设置') })).toBeVisible();
          const toggle = page.locator('.network-toggle input');
          await toggle.scrollIntoViewIfNeeded();
          for (let pass = 0; pass < 3; pass++) {
            await toggle.check();
            await expect(page.locator('.network-settings')).toBeInViewport({ ratio: 1 });
            expect(await measureBackdrop()).toEqual(backdrop);
            await toggle.uncheck();
            expect(await measureBackdrop()).toEqual(backdrop);
          }
          await page.keyboard.press('Escape');
          await expect(page.getByRole('button', { name: text('联机设置'), exact: true })).toBeFocused();
        } else {
          await expect(page.locator('.game-source-picker .ra2-console-art')).toBeVisible();
          await expect(page.locator('.game-source-picker svg.ra2-console-art')).toHaveAttribute(
            'viewBox',
            '0 0 800 600',
          );
          await expect(page.locator('.game-source-picker .console-glass')).toHaveAttribute('fill', /url\(#/);
        }
        await expect(page.getByRole('button', { name: text('开发测试'), exact: true })).toHaveCount(0);
        await expect(page.locator('.development-sources details, .development-sources summary')).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: text('快速开局：直达遭遇战设置') })).toHaveCount(0);
        await expect(page.locator('#vm-controls')).toBeHidden();
        await expect(page.locator('#screen-frame')).toBeHidden();
        const home = page.locator('.game-source-picker');
        await expect(home.getByRole('button', { name: text('加载游戏'), exact: true })).toHaveCount(1);
        await expect(home.getByRole('button', { name: text('清除缓存'), exact: true })).toHaveCount(0);
        await expect(home.getByRole('button', { name: text('选择文件…'), exact: true })).toHaveCount(0);
        await expect(home.getByRole('button', { name: text('选择文件夹…'), exact: true })).toHaveCount(0);
        await expect(home.locator('.detected-games')).toHaveCount(0);
        await expect(
          home.getByRole('link', { name: text('在 Steam 获取红警 2 / 尤里的复仇') + ' ↗', exact: true }),
        ).toHaveCount(0);
        await home.getByRole('button', { name: text('获取游戏'), exact: true }).click();
        const resources = page.getByRole('dialog', { name: text('获取游戏'), exact: true });
        await expect(resources).toBeVisible();
        await expect(
          resources.getByRole('link', { name: text('在 Steam 获取红警 2 / 尤里的复仇') + ' ↗', exact: true }),
        ).toHaveAttribute('href', 'https://store.steampowered.com/app/2229850');
        await expect(resources.getByRole('link', { name: text('下载基础包') + ' ↗', exact: true })).toHaveAttribute(
          'href',
          'https://www.moddb.com/mods/mental-omega/downloads/mental-omega-330',
        );
        await expect(resources.getByRole('link', { name: text('下载补丁') + ' ↗', exact: true })).toHaveAttribute(
          'href',
          'https://www.moddb.com/mods/mental-omega/downloads/mental-omega-336-patch-manual-update',
        );
        await expect(resources.locator('input[type="file"]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(home.getByRole('button', { name: text('获取游戏'), exact: true })).toBeFocused();
        await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
        const upload = page.getByRole('dialog', { name: text('加载游戏'), exact: true });
        await expect(upload).toBeVisible();
        await expect(upload.getByRole('button', { name: text('开发测试'), exact: true })).toHaveCount(0);
        await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
        await expect(upload.getByRole('radio')).toHaveCount(3);
        await expect(upload.getByRole('radio', { disabled: false })).toHaveCount(3);
        await expect(upload.locator('input[value="ra2"]')).toBeChecked();
        await expect(upload.getByRole('button', { name: text('选择文件…'), exact: true })).toBeInViewport({ ratio: 1 });
        await expect(upload.getByRole('button', { name: text('选择文件夹…'), exact: true })).toBeInViewport({
          ratio: 1,
        });
        const modRegion = upload.getByRole('region', { name: text('心灵终结 MOD'), exact: true });
        await expect(modRegion).toHaveCount(0);
        await page.screenshot({
          path: `${screenshotDirectory}/resource-upload-empty-${locale}-${viewport.width}x${viewport.height}.png`,
        });
        const sharedImport = upload.getByRole('region', { name: text('添加游戏资源'), exact: true });
        const importContent = await sharedImport.innerHTML();
        const resourceLink = sharedImport.getByRole('link', {
          name: text('在 Steam 获取红警 2 / 尤里的复仇'),
          exact: true,
        });
        await expect(resourceLink).toHaveAttribute('href', 'https://store.steampowered.com/app/2229850');
        await expect(resourceLink).toHaveAttribute('target', '_blank');
        await expect(resourceLink).toHaveAttribute('rel', 'noopener noreferrer');
        await upload.locator('input[value="ra2"]').focus();
        for (const game of ['yr', 'mo']) {
          await page.keyboard.press('ArrowRight');
          await expect(upload.locator('input[value="' + game + '"]')).toBeChecked();
          if (game === 'yr') expect(await sharedImport.innerHTML()).toBe(importContent);
          if (game === 'mo') {
            await expect(modRegion).toBeVisible();
            const workflow = upload.getByRole('group', { name: text('资源加载流程') });
            await expect(workflow.locator('.upload-workflow-node')).toHaveCount(5);
            await expect(workflow.locator('[data-optional="true"]')).toContainText(text('中文语言包（可选）'));
            expect(
              await workflow
                .locator('.upload-workflow-node')
                .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-step'))),
            ).toEqual(['01', '02', '03', '04', '05']);

            await expect(upload.getByRole('button', { name: text('添加语言包…'), exact: true })).toHaveCount(1);
            await expect(upload.locator('.upload-language-package a').first()).toHaveAttribute(
              'href',
              'https://mentalomega.com/game/lang/MentalOmega336ChineseSimplified.rar',
            );
            await expect(upload.locator('.upload-language-package a').last()).toHaveAttribute(
              'href',
              'https://mentalomega.com/game/lang/MentalOmega336ChineseTraditional.rar',
            );
            await expect(modRegion.getByRole('button', { name: text('添加基础包'), exact: true })).toBeEnabled();
            await expect(modRegion.getByRole('button', { name: text('添加补丁'), exact: true })).toBeEnabled();
            await expect(upload.locator('input[value="mo"]')).toHaveAccessibleName(text('心灵终结'));
            await expect(modRegion).not.toContainText(text('已复用导入的尤里的复仇资源，只需添加基础包和补丁。'));
          } else await expect(modRegion).toHaveCount(0);
          await expect(upload.getByRole('button', { name: text('选择文件…'), exact: true })).toBeEnabled();
          await expect(upload.getByRole('button', { name: text('选择文件夹…'), exact: true })).toBeEnabled();
        }
        await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
        await upload.getByRole('button', { name: text('启动游戏'), exact: true }).scrollIntoViewIfNeeded();
        await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeInViewport({ ratio: 1 });
        await expect(upload.locator('.source-settings-header')).toBeInViewport({ ratio: 1 });
        expect(await upload.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({
          path: `${screenshotDirectory}/resource-upload-mo-${locale}-${viewport.width}x${viewport.height}.png`,
        });
        await upload.locator('input[value="yr"]').check();
        await expect(modRegion).toHaveCount(0);
        await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
        await expect(home.getByRole('button', { name: text('加载游戏'), exact: true })).toBeFocused();

        await page.screenshot({
          path: `${screenshotDirectory}/resource-picker-standby-${locale}-${viewport.width}x${viewport.height}.png`,
        });
        await expect(home.getByLabel(text('联机 relay 地址（可选）'))).toHaveCount(0);
        await home.getByRole('button', { name: text('联机设置'), exact: true }).click();
        await page.getByRole('checkbox', { name: text('联机'), exact: true }).check();
        const relay = page.getByLabel(text('联机 relay 地址（可选）'));
        await expect(relay).toBeInViewport({ ratio: 1 });
        await relay.fill('/missing-host');
        await expect(relay).toHaveAttribute('aria-invalid', 'true');
        await expect(home.getByRole('button', { name: text('开发测试'), exact: true })).toHaveCount(0);
        await expect(home.getByRole('button', { name: text('加载游戏'), exact: true })).toBeEnabled();
        await relay.fill('ws://127.0.0.1:15178/ra2');
        await expect(relay).toHaveAttribute('aria-invalid', 'false');
        expect(new URL(page.url()).searchParams.get('relay')).toBe('ws://127.0.0.1:15178/ra2');
        await relay.fill('127.0.0.1:15178');
        await expect(relay).toHaveAttribute('aria-invalid', 'false');
        expect(new URL(page.url()).searchParams.get('relay')).toBe('127.0.0.1:15178');
        await relay.fill('');
        expect(new URL(page.url()).searchParams.has('relay')).toBe(false);
        await expect(home.getByRole('button', { name: text('加载游戏'), exact: true })).toBeEnabled();
        await page.getByRole('checkbox', { name: text('联机'), exact: true }).uncheck();
        await expect(relay).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get('network')).toBe('0');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: text('联机设置') })).toBeHidden();
        const homeBox = await home.boundingBox();
        expect(homeBox!.x).toBeGreaterThanOrEqual(0);
        expect(homeBox!.y).toBeGreaterThanOrEqual(0);
        expect(homeBox!.x + homeBox!.width).toBeLessThanOrEqual(viewport.width);
        await home.getByRole('button', { name: text('微信群'), exact: true }).scrollIntoViewIfNeeded();
        await expect(home.getByRole('button', { name: text('微信群'), exact: true })).toBeInViewport();

        await expect(page.locator('.game-download-dialog')).toHaveCount(0);
        expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
          bootState.set({
            game: { id: 'ra2', title: '红色警戒 2' },
            status: { phase: 'loading', detail: 'PE 已解析：入口 0x785aa0，368 个 Win32 导入' },
            cancel: async () => {},
          });
        });
        await expect(page.locator('#vm-boot')).toBeVisible();
        await expect(page.locator('#vm-boot [role=progressbar]')).toBeVisible();
        await expect(page.locator('#vm-boot [role=progressbar]')).not.toHaveAttribute('aria-valuenow');
        await expect(page.locator('.vm-boot-title')).toHaveText(text('红色警戒 2'));
        await expect(page.locator('.vm-boot-detail')).toHaveText(text('PE 已解析：入口 0x785aa0，368 个 Win32 导入'));
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
          bootState.set(null);
        });
        await expect(page.locator('#vm-boot')).toHaveCount(0);
        // Command events are low-frequency UI metadata; they must not replace the game canvas.
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const controlUrl = '/src/ui/pages/game/controlSession.ts';
          const { gameRunning } = await import(stateUrl);
          const { controlJournal } = await import(controlUrl);
          gameRunning.set(true);
          controlJournal.activity({
            kind: 'request',
            method: 'command',
            params: {
              sessionId: 'ui-test',
              commandId: 'train-tank',
              action: 'produce',
              type: 'MTNK',
            },
          });
          controlJournal.activity({
            kind: 'reply',
            method: 'command',
            params: {
              sessionId: 'ui-test',
              commandId: 'train-tank',
            },
            result: { state: 'submitted' },
          });
        });
        await expect(page.locator('.agent-commands summary')).toContainText(text('生产'));
        await expect(page.locator('.agent-commands summary')).toContainText('MTNK');
        await expect(page.locator('.agent-commands summary')).toBeInViewport();
        await page.locator('.agent-commands summary').click();
        await expect(page.getByRole('list', { name: text('AI 指令记录') })).toBeVisible();
        await expect(page.locator('[data-command-id="train-tank"]')).toContainText(text('已进入游戏队列'));
        expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const controlUrl = '/src/ui/pages/game/controlSession.ts';
          const { gameRunning } = await import(stateUrl);
          const { controlJournal } = await import(controlUrl);
          gameRunning.set(false);
          controlJournal.activity({ kind: 'reset' });
        });
        // The page controller has installed the toolbar; real events verify that React updates do not recreate the picker.
        {
          await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          await expect(upload.locator('input[value="yr"]')).toBeChecked();
          const choose = upload.getByRole('button', { name: text('选择文件…'), exact: true });
          const measureUpload = () =>
            upload.evaluate((dialog) => {
              const selectors = [
                '.upload-editions',
                '.upload-preparation-grid',
                '.resource-upload-footer',
                '.upload-launch-summary',
              ];
              return selectors.map((selector) => {
                const rect = dialog.querySelector(selector)!.getBoundingClientRect();
                return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              });
            });
          const beforeChoose = await measureUpload();
          const chooserPromise = page.waitForEvent('filechooser');
          await choose.click();
          const chooser = await chooserPromise;
          expect(await measureUpload()).toEqual(beforeChoose);
          await expect(home.getByRole('button', { name: text('加载游戏'), exact: true })).toBeEnabled();
          await expect(home.getByRole('button', { name: text('获取游戏'), exact: true })).toBeEnabled();
          await expect(choose).toBeDisabled();
          await expect(upload.getByRole('radio', { disabled: true })).toHaveCount(3);
          await expect(upload.getByRole('button', { name: text('关闭'), exact: true })).toBeDisabled();
          await page.keyboard.press('Escape');
          await expect(upload).toBeVisible();
          await page.locator('input[accept=".zip,.exe,.rar,.7z"]').dispatchEvent('cancel');
          await expect(choose).toBeEnabled();
          expect(await measureUpload()).toEqual(beforeChoose);
          // Cancel arrives first, change later: do not lose the selection or let a failed import permanently disable the UI.
          await chooser.setFiles({
            name: 'broken.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from('invalid archive'),
          });
          await expect(upload.locator('[role="alert"]')).not.toHaveText('');
          if (locale === 'en-US') await expect(upload.locator('[role="alert"]')).not.toHaveText(/\p{Script=Han}/u);
          await expect(choose).toBeEnabled();
          await expect(upload).toBeVisible();
          await expect(page.getByRole('dialog', { name: text('联机设置') })).toBeHidden();
          expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
          // A synthetic two-version manifest verifies real ZIP recognition and deferred version selection without loading or faking a game EXE.
          const both = zipSync(
            Object.fromEntries(
              [
                'game.exe',
                'gamemd.exe',
                'ra2.mix',
                'language.mix',
                'ra2md.mix',
                'langmd.mix',
                'binkw32.dll',
                'blowfish.dll',
              ].map((name) => [name, new Uint8Array([1])]),
            ),
          );
          await upload.locator('input[value="mo"]').check();
          const secondChooser = page.waitForEvent('filechooser');
          await choose.click();
          await (await secondChooser).setFiles({
            name: 'both.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from(both),
          });
          await expect(upload.getByRole('region', { name: text('游戏资源状态'), exact: true })).toBeVisible();
          await expect(upload.locator('input[value="mo"]')).toBeChecked();
          await expect(upload.locator('input[value="mo"]')).toBeEnabled();
          await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
          await upload.locator('input[value="yr"]').check();
          const launch = upload.getByRole('button', { name: text('启动游戏'), exact: true });
          await expect(launch).toBeEnabled();
          await expect(launch).toHaveAttribute('data-monitor-action', 'choose-yr');
          await launch.scrollIntoViewIfNeeded();
          await expect(launch).toBeInViewport({ ratio: 1 });
          expect(await upload.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
          await page.screenshot({
            path:
              screenshotDirectory +
              '/resource-upload-ready-' +
              locale +
              '-' +
              viewport.width +
              'x' +
              viewport.height +
              '.png',
          });
          // Ready resources cannot bypass invalid network settings.
          await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
          await home.getByRole('button', { name: text('联机设置'), exact: true }).click();
          await page.getByRole('checkbox', { name: text('联机'), exact: true }).check();
          await relay.fill('/missing-host');
          await page.keyboard.press('Escape');
          await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          await expect(launch).toBeDisabled();
          await expect(upload.locator('[role="alert"]')).not.toHaveText('');
          await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
          await home.getByRole('button', { name: text('联机设置'), exact: true }).click();
          await page.getByRole('checkbox', { name: text('联机'), exact: true }).uncheck();
          await page.keyboard.press('Escape');
          await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          await expect(launch).toBeEnabled();
          // Invalid executables must report errors inside the modal when launched directly.
          await launch.click();
          await expect(upload.locator('[role="alert"]')).not.toHaveText('');
          await expect(upload).toBeVisible();
          await expect(launch).toBeEnabled();
          await expect(page.locator('#vm-boot')).toHaveCount(0);
          await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
          await expect(home.locator('[data-monitor-action^="choose-"]')).toHaveCount(0);
          await expect(home.locator('.detected-games')).toHaveCount(0);
          // Separate packages must enable MO while preserving both original launch choices.
          await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          await expect(upload.locator('input[value="yr"]')).toBeChecked();
          await upload.locator('input[value="mo"]').check();
          await expect(launch).toBeDisabled();
          await upload.getByText(text('查看缺少的文件'), { exact: true }).click();
          await expect(upload.locator('.upload-missing-files p')).toContainText('expandmo');
          await expect(modRegion).toBeVisible();
          await expect(modRegion).not.toContainText(text('已复用导入的尤里的复仇资源，只需添加基础包和补丁。'));
          await expect(sharedImport.locator('.upload-resource-ready')).toHaveText(
            text('尤里基础资源已就绪。请继续加载下方两个 MO 资源包。'),
          );
          await expect(modRegion.locator('.upload-resource-ready')).toHaveCount(0);
          const packageChooser = page.waitForEvent('filechooser');
          await upload.getByRole('button', { name: text('添加补丁'), exact: true }).click();
          await (await packageChooser).setFiles([
            {
              name: 'mental-omega-3.3.6-update-with-a-long-package-name-for-layout-verification.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(
                zipSync(
                  Object.fromEntries(
                    GAME_MANIFESTS.mo.playerRequired
                      .filter((entry) => !['expandmo95.mix', 'expandmo96.mix'].includes(entry.name))
                      .map((entry) => [entry.name, new Uint8Array([1])]),
                  ),
                ),
              ),
            },
          ]);
          await expect(upload.getByRole('button', { name: text('关闭'), exact: true })).toBeEnabled();
          await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
          const baseChooser = page.waitForEvent('filechooser');
          await upload.getByRole('button', { name: text('添加基础包'), exact: true }).click();
          await (await baseChooser).setFiles([
            {
              name: 'base.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(
                zipSync({
                  'expandmo95.mix': new Uint8Array([1]),
                  'expandmo96.mix': new Uint8Array([1]),
                }),
              ),
            },
          ]);
          await expect(upload.getByRole('button', { name: text('关闭'), exact: true })).toBeEnabled();
          await expect(upload).toContainText('base.zip');
          await expect(sharedImport.locator('.upload-resource-ready')).toHaveText(
            text('心灵终结资源已就绪，可以启动游戏。'),
          );
          await expect(upload.locator('.upload-workflow-finish [role="status"]')).toHaveText(text('资源已就绪'));
          for (const message of ['MO 基础包已导入。', 'MO 更新补丁已导入。']) {
            const success = modRegion
              .locator('.upload-package .upload-resource-ready')
              .filter({ hasText: text(message) });
            await expect(success).toBeVisible();
            await expect(success).toHaveCSS('color', 'rgb(198, 214, 155)');
          }
          await expect(upload).toContainText(
            'mental-omega-3.3.6-update-with-a-long-package-name-for-layout-verification.zip',
          );
          await expect(upload.locator('input[value="mo"]')).toBeChecked();
          await expect(launch).toBeEnabled();
          await upload.locator('input[value="ra2"]').check();
          await expect(modRegion).toHaveCount(0);
          await upload.locator('input[value="mo"]').check();
          await expect(upload).toContainText('base.zip');
          expect(
            await upload.evaluate((node) =>
              [...node.querySelectorAll('*')]
                .filter((child) => child.scrollWidth > child.clientWidth + 1)
                .map((child) => ({
                  tag: child.tagName,
                  className: child.className,
                  text: child.textContent,
                  width: child.clientWidth,
                  scrollWidth: child.scrollWidth,
                })),
            ),
          ).toEqual([]);
          await page.screenshot({
            path: `${screenshotDirectory}/resource-upload-mo-ready-${locale}-${viewport.width}x${viewport.height}.png`,
          });
          if (locale === 'zh-CN') {
            const languageChooser = page.waitForEvent('filechooser');
            await upload.getByRole('button', { name: text('添加语言包…'), exact: true }).click();
            await (await languageChooser).setFiles({
              name: 'chinese.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(zipSync({ 'expandmo98.mix': Uint8Array.of(98) })),
            });
            await expect(upload.getByRole('button', { name: text('移除语言包'), exact: true })).toBeEnabled();
            await expect(upload.locator('.upload-language-package')).toContainText('chinese.zip');
            await expect(launch).toBeEnabled();
            await upload.getByRole('button', { name: text('移除语言包'), exact: true }).click();
            await expect(upload.locator('.upload-language-package')).toContainText(text('未添加'));
            await expect(launch).toBeEnabled();
          }
          await expect(launch).toHaveAttribute('data-monitor-action', 'choose-mo');
          await upload.getByRole('button', { name: text('移除基础包'), exact: true }).click();
          await expect(sharedImport.locator('.upload-resource-ready')).toBeVisible();
          await expect(upload.locator('.upload-workflow-finish')).toHaveAttribute('data-ready', 'false');
          await expect(modRegion.locator('.upload-package .upload-resource-ready')).toHaveText(
            text('MO 更新补丁已导入。'),
          );
          await expect(upload.locator('input[value="mo"]')).toBeEnabled();
          await expect(upload.locator('input[value="mo"]')).toBeChecked();
          await expect(launch).toBeDisabled();
          await expect(upload.locator('.upload-launch-summary small')).toHaveText(
            text('资源仅在当前浏览器中读取，不会上传至服务器。'),
          );
          if (locale === 'zh-CN') {
            const languageChooser = page.waitForEvent('filechooser');
            await upload.getByRole('button', { name: text('添加语言包…'), exact: true }).click();
            await (await languageChooser).setFiles({
              name: 'chinese.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(zipSync({ 'expandmo98.mix': Uint8Array.of(98) })),
            });
            await expect(upload.getByRole('button', { name: text('移除语言包'), exact: true })).toBeEnabled();
            await expect(upload.locator('.upload-language-package')).toContainText('chinese.zip');
            await expect(launch).toBeDisabled();
            await upload.getByRole('button', { name: text('移除语言包'), exact: true }).click();
            await expect(upload.locator('.upload-language-package')).toContainText(text('未添加'));
            await expect(launch).toBeDisabled();
          }
          await expect(launch).toHaveAttribute('data-monitor-action', 'choose-mo');
          await expect(upload).toContainText(
            'mental-omega-3.3.6-update-with-a-long-package-name-for-layout-verification.zip',
          );
          await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
          await expect(home.locator('[data-monitor-action^="choose-"]')).toHaveCount(0);
          const menuLayout = await home.locator('.ra2-panel').evaluate((panel) => {
            const bounds = panel.getBoundingClientRect();
            const scale = bounds.width / 800;
            const buttons = [...panel.querySelectorAll<HTMLElement>('.ra2-menu-btn')];
            return buttons.map((button) => {
              const rect = button.getBoundingClientRect();
              const label = button.querySelector('.ra2-menu-btn-label')!;
              const text = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
              const range = document.createRange();
              range.selectNodeContents(text);
              const textRect = range.getBoundingClientRect();
              return {
                x: (rect.x + rect.width / 2 - bounds.x) / scale,
                y: (rect.y - bounds.y) / scale,
                textOffset: (textRect.x + textRect.width / 2 - rect.x - rect.width / 2) / scale,
              };
            });
          });
          for (const [index, command] of menuLayout.entries()) {
            expect(command.x).toBeCloseTo(709, 0);
            expect(command.y).toBeGreaterThanOrEqual(198);
            if (index < menuLayout.length - 2) expect(command.y).toBeCloseTo(199 + index * 42, 0);
            expect(Math.abs(command.textOffset)).toBeLessThan(1);
          }
          // Share locators with real-game CI; trial checks clickability without starting synthetic assets.
          await home.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          for (const game of ['ra2', 'yr']) await detectedGameOption(page, game, resolveLocale([locale])).check();
          await launch.click({ trial: true });
          await upload.getByRole('button', { name: text('关闭'), exact: true }).click();
          await page.screenshot({
            path: `${screenshotDirectory}/resource-picker-${locale}-${viewport.width}x${viewport.height}.png`,
          });
          // The home page hides the runtime toolbar; finish resource selection before checking in-game controls instead of forcing visibility through CSS.
          await page.evaluate(async () => {
            const stateUrl = '/src/ui/pages/game/state/uiState.ts';
            const { cancelSourceRequest } = (await import(
              stateUrl
            )) as typeof import('../../../src/ui/pages/game/state/uiState');
            cancelSourceRequest();
          });
          await expect(page.locator('#vm-controls')).toBeVisible();
          const overflowing = await page.locator('#vm-controls').evaluate((sidebar) => {
            const bounds = sidebar.getBoundingClientRect();
            return [
              ...sidebar.querySelectorAll<HTMLElement>(
                '.toolbar-button, .game-select-value, .label, .slider-fields, output',
              ),
            ]
              .filter((element) => element.getClientRects().length > 0)
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.left < bounds.left ||
                  rect.right > bounds.right ||
                  (element.matches('.toolbar-button, output') && element.scrollWidth > element.clientWidth + 1)
                );
              })
              .map((element) => element.id || element.textContent);
          });
          expect(overflowing, `${locale}: sidebar controls and translated text must fit`).toEqual([]);

          const upscaleBox = await page.locator('#vm-upscale-widget').boundingBox();
          const resolutionBox = await page.locator('#vm-resolution-widget').boundingBox();
          const columnStart = (box: NonNullable<typeof upscaleBox>) => box.x;
          const columnWidth = (box: NonNullable<typeof upscaleBox>) => box.width;
          expect(Math.abs(columnStart(upscaleBox!) - columnStart(resolutionBox!))).toBeLessThan(1);
          expect(Math.abs(columnWidth(upscaleBox!) - columnWidth(resolutionBox!))).toBeLessThan(1);
          await expect(page.locator('#vm-controls > button').last()).toHaveAttribute('id', 'vm-fullscreen');
          const openSource = page.locator('#vm-open-source');
          await expect(openSource).toHaveAttribute('href', 'https://github.com/ra2-games/ra2');
          await expect(openSource).toHaveAttribute('rel', 'noopener noreferrer');
          const openSourceBox = (await openSource.boundingBox())!;
          const joinGroupBox = (await page.locator('#vm-join-group').boundingBox())!;
          expect(Math.abs(columnStart(openSourceBox) - columnStart(joinGroupBox))).toBeLessThan(1);
          expect(columnWidth(openSourceBox)).toBe(columnWidth(joinGroupBox));
          const options = page.locator('#vm-resolution-options');
          await expect(options).toBeHidden();
          await expect(page.locator('#vm-custom-maps')).toBeDisabled();
          await expect(page.locator('#vm-quick-start')).toBeDisabled();
          await page.locator('#vm-upscale-toggle').click();
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('gan');
          await page.locator('#vm-upscale-toggle').click();
          await page.keyboard.press('Home');
          await page.keyboard.press('Enter');
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('off');
          await page.locator('#vm-resolution-toggle').click();
          await expect(options).toBeVisible();
          await expect(options.getByRole('option')).toHaveCount(8);
          const popupBox = await options.boundingBox();
          expect(popupBox!.y).toBeGreaterThanOrEqual(0);
          expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(viewport.height);
          // Drag the scrollbar itself; proving wheel scrolling works is insufficient (button blur could previously close the popup early).
          const thumb = page.getByRole('scrollbar', { name: text('选项滚动条') });
          const thumbBox = await thumb.boundingBox();
          await page.mouse.move(thumbBox!.x + thumbBox!.width / 2, thumbBox!.y + thumbBox!.height / 2);
          await page.mouse.down();
          await page.mouse.move(popupBox!.x + popupBox!.width - 8, popupBox!.y + popupBox!.height - 8, { steps: 8 });
          await page.mouse.up();
          await expect(options).toBeVisible();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          const bottomScroll = await options.evaluate((node) => node.scrollTop);
          await page.getByRole('button', { name: text('向上滚动'), exact: true }).click();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeLessThan(bottomScroll);
          const upperScroll = await options.evaluate((node) => node.scrollTop);
          await page.getByRole('button', { name: text('向下滚动'), exact: true }).click();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(upperScroll);
          await options.getByRole('option').last().hover();
          await page.mouse.wheel(0, 500);
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          await expect(options.getByRole('option').last()).toBeInViewport();
          await page.keyboard.press('Escape');
          await expect(options).toBeHidden();
          await page.locator('#vm-upscale-toggle').click();
          await page.locator('#vm-upscale-options').getByRole('option').last().click();
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('gan');
          await page.locator('#vm-upscale-toggle').click();
          await page.keyboard.press('Home');
          await page.keyboard.press('Enter');
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('off');
          await page.locator('#vm-volume').fill('70');
          await expect(page.locator('#vm-volume-value')).toHaveValue('70%');
          expect(await page.evaluate(() => localStorage.getItem('vm-master-volume'))).toBe('70');
          await page.locator('#vm-volume').focus();
          await page.keyboard.press('ArrowLeft');
          await expect(page.locator('#vm-volume-value')).toHaveValue('69%');
          const track = await page.locator('#vm-volume').boundingBox();
          const trackStart = { x: track!.x + 3, y: track!.y + track!.height / 2 };
          const trackEnd = { x: track!.x + track!.width - 2, y: track!.y + track!.height / 2 };
          await page.mouse.move(trackStart.x, trackStart.y);
          await page.mouse.down();
          await page.mouse.move(trackEnd.x, trackEnd.y, { steps: 10 });
          await page.mouse.up();
          await expect(page.locator('#vm-volume')).toHaveValue('100');
          await page.locator('#vm-model-probe').click();
          const probe = page.getByRole('dialog', { name: text('WebGPU 模型实验'), exact: true });
          try {
            await expect(probe).toBeVisible();
          } catch (error) {
            const bodyText = await page
              .locator('body')
              .innerText()
              .catch(() => '');
            console.error('模型实验对话框未加载', JSON.stringify({ bodyText, errors, failedResponses }, null, 2));
            throw error;
          }
          await expect(probe.getByRole('button', { name: text('采样并推理') })).toBeDisabled();
          expect(modelRequests).toEqual([]);
          // Empty-file rejection is independent of GPU availability and does not start an inference Worker.
          await probe.getByLabel(text('选择本地模型')).setInputFiles({
            name: 'empty.onnx',
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(0),
          });
          await expect(probe.getByRole('status')).toHaveText(
            text('请选择 {0} ONNX（约 {1} MB）')
              .replace('{0}', 'AnimeSharpV2 RealPLKSR 2× Soft')
              .replace('{1}', '29.9'),
          );
          await expect(probe.getByRole('button', { name: text('采样并推理') })).toBeDisabled();
          expect(modelRequests).toEqual([]);
          await page.keyboard.press('Escape');
          await expect(probe).toHaveCount(0);
          await page.locator('#vm-join-group').click();
          const group = page.getByRole('dialog', { name: text('微信交流群'), exact: true });
          await expect(group).toBeVisible();
          await expect(group.locator('.join-group-hint.error')).toHaveText(
            text('二维码图片加载失败，请稍后重试或刷新页面。'),
          );
          await expect(group.locator('.join-group-qr')).toHaveCount(0);
          await group.getByRole('button', { name: text('关闭微信群二维码'), exact: true }).click();
          await expect(group).toHaveCount(0);
          await expect(page.locator('#vm-join-group')).toBeFocused();
          await page.locator('#vm-join-group').click();
          const qrImage = group.locator('.join-group-qr');
          await expect(qrImage).toHaveAttribute('src', WECHAT_GROUP_QR_URL);
          await expect
            .poll(() => qrImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
            .toBe(true);
          await expect(group.locator('.join-group-hint.error')).toHaveCount(0);
          expect(qrRequests).toBe(2);
          await page.keyboard.press('Escape');
          await expect(group).toHaveCount(0);
          await page.locator('#vm-fullscreen').scrollIntoViewIfNeeded();
          await expect(page.locator('#vm-fullscreen')).toBeInViewport();
        }
        // Vite may add an HMR timestamp to the actual entry; dispose the same service instance instead of importing a separate copy.
        expect(runtimeModuleUrl).not.toBe('');
        await page.evaluate(async (pageUrl) => {
          const { stopVmPage } = (await import(pageUrl)) as typeof import('../../../src/ui/pages/game/page');
          stopVmPage();
        }, runtimeModuleUrl);
        await expect(page.locator('#vm-controls button')).toHaveCount(0);
        await expect(page.locator('.game-folder-panel')).toHaveCount(0);
        expect(errors).toEqual([]);
        console.log(`${locale} ${viewport.width}×${viewport.height}: React dialogs, focus, canvas, and cleanup passed`);
      } finally {
        await context.close();
      }
    }
  }
  // Only an explicit skip suppresses guidance after a reload; legacy display records do not.
  const admission = await browser.newContext({
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await admission.newPage();
    await preventThirdPartyDownloads(page);
    await page.addInitScript(() => localStorage.setItem('ra2-vm-game-guide-seen', '1'));
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    const edge = page.locator('.edge-mouse-notice');
    const guide = page.getByRole('dialog', { name: 'Get Game', exact: true });
    await expect(edge).toBeVisible();
    await expect(guide).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('ra2-vm-game-guide-skipped'))).toBeNull();
    await edge.locator('[data-remember]').click();
    await expect(guide).toBeVisible();
    await dismissGameGuide(page);
    expect(await page.evaluate(() => localStorage.getItem('ra2-vm-game-guide-skipped'))).toBeNull();
    await page.reload();
    await page.locator('.game-source-picker .ra2-menu-nav').waitFor();
    await expect(edge).toBeHidden();
    await expect(guide).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'Do not show again', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('ra2-vm-game-guide-skipped'))).toBe('1');
    await page.reload();
    await page.locator('.game-source-picker .ra2-menu-nav').waitFor();
    await expect(guide).toBeHidden();
    await page.getByRole('button', { name: 'Get Game', exact: true }).click();
    await expect(guide).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Network settings', exact: true }).click();
    const network = page.getByRole('dialog', { name: 'Network settings', exact: true });
    await expect(network).toBeVisible();
    await expect(network.locator('.game-guide')).toHaveCount(0);
    await expect(network.locator('.network-toggle')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByRole('button', { name: 'Load Game', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Select files…', exact: true }).click();
    await (await chooser).setFiles({
      name: 'invalid-executable.zip',
      mimeType: 'application/zip',
      // Named files reach the manifest view, but the invalid PE must fail validation before any VM starts.
      buffer: Buffer.from(
        zipSync(
          Object.fromEntries(
            ['game.exe', 'ra2.mix', 'language.mix', 'binkw32.dll', 'blowfish.dll'].map((name) => [
              name,
              new Uint8Array([1]),
            ]),
          ),
        ),
      ),
    });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await selectImportedGame(page, 'ra2', 'en');
    const upload = page.getByRole('dialog', { name: 'Load Game', exact: true });
    await expect(upload.locator('[role="alert"]')).not.toHaveText('');
    await upload.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Network settings', exact: true }).click();
    await expect(network).toBeVisible();
    await expect(network.locator('.manifest-line').first()).toBeVisible();
    const bounds = await network.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390);
    const content = network.locator('.ra2-content');
    expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await network.locator('.source-picker-error').scrollIntoViewIfNeeded();
    await expect(network.locator('.source-picker-error')).toBeInViewport();
    await expect(network.locator('.source-settings-close')).toBeInViewport();
    await network.locator('.source-settings-close').click();
    await expect(network).toBeHidden();
    console.log(
      'Admission notices: Edge sequencing, temporary dismissal, explicit skip persistence, legacy records, and manual reopening passed',
    );
  } finally {
    await admission.close();
  }
  // Development builds must use the same local import controls as production.
  const localImport = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  try {
    const page = await localImport.newPage();
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await dismissGameGuide(page);
    await page.getByRole('button', { name: '加载游戏', exact: true }).click();
    await expect(page.locator('[data-monitor-action="pick-development"]')).toHaveCount(0);
    await expect(page.locator('input[webkitdirectory]')).toHaveCount(1);
  } finally {
    await localImport.close();
  }
  // Cancel during the asynchronous handoff: the loading shell must already be visible,
  // and a late custom-map cache result must not create a VM.
  const handoff = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true });
  try {
    const page = await handoff.newPage();
    await page.addInitScript('globalThis.__name = (value) => value');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/src/adapter/cachedGameFiles.ts*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const patched = source.replace(
        'export async function loadCustomMapFiles(gameId) {',
        'export async function loadCustomMapFiles(gameId) { return await new Promise(resolve => { globalThis.__releaseMapRead = () => resolve(new Map()); });',
      );
      expect(patched).not.toBe(source);
      await route.fulfill({ response, body: patched });
    });
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await page.getByRole('heading', { name: 'Choose game resources', exact: true }).waitFor();
    await page.evaluate(async () => {
      const stateUrl = '/src/ui/pages/game/state/uiState.ts';
      const catalogUrl = '/src/games/catalog.ts';
      const filesUrl = '/src/platform/browser/files/sessionFiles.ts';
      const { sourceRequest } = await import(stateUrl);
      const { supportedGame } = await import(catalogUrl);
      const { SessionGameFileProvider } = await import(filesUrl);
      (globalThis as any).__finishSource = () =>
        sourceRequest.getSnapshot().finish({
          game: supportedGame('ra2'),
          files: new SessionGameFileProvider('handoff fixture', new Map()),
          executableBytes: new Uint8Array(),
        });
    });
    // Invoke the action after asynchronous module setup has returned, as a UI event would.
    await page.evaluate(() => (globalThis as any).__finishSource());
    await expect(page.locator('#vm-boot .ra2-loading-content')).toBeVisible();
    await expect(page.locator('#vm-controls')).toBeHidden();
    await page.getByRole('button', { name: 'Cancel startup', exact: true }).click();
    await expect(page.locator('#vm-boot')).toHaveCount(0);
    await page.evaluate(() => (globalThis as any).__releaseMapRead());
    await page.waitForTimeout(100);
    await expect(page.locator('#vm-boot')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Back to the web page', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await handoff.close();
  }

  // Presentation-only fixtures keep the real modal in progress states without loading game assets.
  for (const locale of ['zh-CN', 'en-US']) {
    const text = (value: string) => localizeText(value, resolveLocale([locale]));
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 844, height: 390 },
    ]) {
      for (const totalFiles of [40, null]) {
        const progressContext = await browser.newContext({
          locale,
          viewport,
          ignoreHTTPSErrors: true,
          reducedMotion: totalFiles === null ? 'reduce' : 'no-preference',
        });
        try {
          const page = await progressContext.newPage();
          await preventThirdPartyDownloads(page);
          await page.route('**/src/ui/pages/game/components/ResourceUploadDialog.tsx*', async (route) => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const editionName = useId();';
            expect(source).toContain(marker);
            const fixture = {
              busy: true,
              awaitingSelection: false,
              description: '加载游戏',
              progress: { completedFiles: 12, totalFiles },
            };
            await route.fulfill({
              response,
              body: source.replace(marker, 'picker = { ...picker, ...' + JSON.stringify(fixture) + ' };' + marker),
            });
          });
          await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
          await dismissGameGuide(page);
          await page.getByRole('button', { name: text('加载游戏'), exact: true }).click();
          const upload = page.getByRole('dialog', { name: text('加载游戏'), exact: true });
          const status = upload.locator('.upload-import-progress');
          const frame = status.locator('.ra2-progress-frame');
          await frame.scrollIntoViewIfNeeded();
          await expect(frame).toBeInViewport({ ratio: 1 });
          const bounds = await status.boundingBox();
          const track = await frame.boundingBox();
          const footer = await upload.locator('.resource-upload-footer').boundingBox();
          expect(track!.x).toBeGreaterThanOrEqual(bounds!.x);
          expect(track!.x + track!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
          expect(track!.y).toBeGreaterThanOrEqual(bounds!.y);
          expect(track!.y + track!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
          expect(track!.y + track!.height).toBeLessThanOrEqual(footer!.y);
          expect(await upload.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
          await expect(upload.getByRole('button', { name: text('清除缓存'), exact: true })).toBeInViewport({
            ratio: 1,
          });
          await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
          const progress = status.getByRole('progressbar');
          if (totalFiles === null) {
            await expect(progress).not.toHaveAttribute('aria-valuenow');
            await expect(progress).toHaveAttribute('aria-label', text('已解压 {0} 个文件').replace('{0}', '12'));
            await expect(status.locator('.ra2-progress-fill')).toHaveCSS('animation-name', 'none');
            await expect(status.locator('.upload-progress-percent')).toHaveCount(0);
          } else {
            await expect(progress).toHaveAttribute('aria-valuenow', '30');
            await expect(progress).toHaveAttribute(
              'aria-label',
              text('已解压 {0}/{1} 个文件').replace('{0}', '12').replace('{1}', '40'),
            );
            await expect(status.locator('.upload-progress-percent')).toHaveText('30%');
            const fill = await status.locator('.ra2-progress-fill').boundingBox();
            const innerTrack = await progress.boundingBox();
            expect(fill!.width / innerTrack!.width).toBeCloseTo(0.3, 2);
          }
          await page.screenshot({
            path:
              screenshotDirectory +
              '/resource-upload-progress-' +
              locale +
              '-' +
              viewport.width +
              '-' +
              (totalFiles ?? 'unknown') +
              '.png',
          });
        } finally {
          await progressContext.close();
        }
      }
    }
  }

  // Import publication and deletion must survive a real page reload, without a VM launch.
  for (const locale of ['zh-CN', 'en-US']) {
    const context = await browser.newContext({ locale, ignoreHTTPSErrors: true });
    try {
      const text = (value: string) => localizeText(value, resolveLocale([locale]));
      const page = await context.newPage();
      await preventThirdPartyDownloads(page);
      await page.addInitScript('globalThis.__name = (value) => value');
      await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
      await dismissGameGuide(page);
      await page.getByRole('button', { name: text('加载游戏'), exact: true }).click();
      const upload = page.getByRole('dialog', { name: text('加载游戏'), exact: true });
      const names = ['game.exe', 'ra2.mix', 'language.mix', 'binkw32.dll', 'blowfish.dll'];
      await page.locator('input[accept=".zip,.exe,.rar,.7z"]').setInputFiles({
        name: 'persistent.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries([
              ...names.map((name) => [name, Uint8Array.of(1, 2, 3)]),
              ['movies01.mix', new Uint8Array()],
              ['taunts/test.wav', Uint8Array.of(9)],
            ]),
          ),
        ),
      });
      await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeEnabled();
      await expect(upload).not.toContainText(/资源已保存在当前浏览器|Resources saved in this browser/);
      await page.evaluate(async () => {
        const cacheUrl = '/src/adapter/cachedGameFiles.ts';
        const { saveCustomMapFiles } = await import(cacheUrl);
        const writeUrl = '/src/platform/browser/files/writeCache.ts';
        const { IndexedDbWriteCache } = await import(writeUrl);
        await saveCustomMapFiles('ra2', new Map([['custom.mpr', Uint8Array.of(5)]]));
        await new IndexedDbWriteCache().write('savegame.sav', Uint8Array.of(6));
      });
      await page.reload();
      await dismissGameGuide(page);
      await page.getByRole('button', { name: text('加载游戏'), exact: true }).click();
      await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeEnabled();
      expect(
        await page.evaluate(async () => {
          const url = '/src/platform/browser/files/importedResources.ts';
          const { loadImportedResources, ImportedResourceFileProvider } = await import(url);
          const groups = await loadImportedResources();
          const provider = new ImportedResourceFileProvider(groups.original);
          return {
            empty: [...(await provider.read('movies01.mix'))],
            range: [...(await provider.readRange('game.exe', 1, 1))],
            nested: [...(await provider.read('taunts/test.wav'))],
          };
        }),
      ).toEqual({ empty: [], range: [2], nested: [9] });
      // Abort a replacement after put: completion, rather than request success, defines publication.
      expect(
        await page.evaluate(async () => {
          const url = '/src/platform/browser/files/importedResources.ts';
          const { saveImportedResources, loadImportedResources } = await import(url);
          const transaction = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
            const tx = transaction.apply(this, args);
            if (this.name === 'ra2-vm-imported-resources' && args[1] === 'readwrite') queueMicrotask(() => tx.abort());
            return tx;
          };
          let rejected: boolean;
          try {
            rejected = await saveImportedResources({
              original: { label: 'replacement', files: new Map([['replacement.mix', Uint8Array.of(8)]]) },
            }).then(
              () => false,
              () => true,
            );
          } finally {
            IDBDatabase.prototype.transaction = transaction;
          }
          const retained = await loadImportedResources();
          return {
            rejected,
            original: retained.original.files.has('game.exe'),
            replacement: retained.original.files.has('replacement.mix'),
          };
        }),
      ).toEqual({ rejected: true, original: true, replacement: false });
      await upload.getByRole('button', { name: text('清除缓存'), exact: true }).click();
      await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
      await page.reload();
      await dismissGameGuide(page);
      await page.getByRole('button', { name: text('加载游戏'), exact: true }).click();
      await expect(upload.getByRole('button', { name: text('启动游戏'), exact: true })).toBeDisabled();
      expect(
        await page.evaluate(async () => {
          const cacheUrl = '/src/adapter/cachedGameFiles.ts';
          const { loadCustomMapFiles } = await import(cacheUrl);
          const writeUrl = '/src/platform/browser/files/writeCache.ts';
          const { IndexedDbWriteCache } = await import(writeUrl);
          return {
            map: [...(await loadCustomMapFiles('ra2')).get('custom.mpr')],
            save: [...(await new IndexedDbWriteCache().read('savegame.sav'))],
          };
        }),
      ).toEqual({ map: [5], save: [6] });
    } finally {
      await context.close();
    }
  }

  // Unsupported browser languages fall back to English, including document metadata.
  const fallback = await browser.newContext({ locale: 'fr-FR', ignoreHTTPSErrors: true });
  try {
    const page = await fallback.newPage();
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await expect(page.getByRole('heading', { name: 'Choose game resources', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Red Alert 2 in your browser · ra2.games');
    expect(await page.locator('.game-source-picker').innerText()).not.toMatch(/\p{Script=Han}/u);
  } finally {
    await fallback.close();
  }
  // A cache entry can remain listed after its Blob becomes unreadable. Keep the failure visible across reloads.
  const unreadableCache = await browser.newContext({
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await unreadableCache.newPage();
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await expect(page.locator('#landscape-notice')).toBeVisible();
    await expect(page.locator('.game-source-picker')).toBeHidden();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#landscape-notice')).toBeHidden();
    await page.getByRole('heading', { name: '选择游戏资源' }).waitFor();
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ra2-vm-game-files', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('files', 'readwrite');
        for (const name of ['game.exe', 'ra2.mix', 'language.mix', 'binkw32.dll', 'blowfish.dll'])
          transaction.objectStore('files').put(new Blob([new Uint8Array(name === 'ra2.mix' ? 7 : 1)]), `ra2/${name}`);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page.addInitScript(() => {
      const slice = Blob.prototype.slice;
      Blob.prototype.slice = function (...args) {
        if (this.size === 7) throw new DOMException('The requested file could not be read', 'NotReadableError');
        return slice.apply(this, args);
      };
    });
    await page.reload();
    await expect(page.getByRole('dialog', { name: '加载游戏' })).toContainText('ra2/ra2.mix');
    await expect(page.getByRole('dialog', { name: '加载游戏' })).toContainText('The requested file could not be read');
    await page.getByRole('dialog', { name: '加载游戏' }).getByRole('button', { name: '清除缓存', exact: true }).click();
    await page.getByRole('dialog', { name: '加载游戏' }).getByRole('button', { name: '关闭', exact: true }).click();
    await dismissGameGuide(page);
    await expect(page.locator('.status-terminal-readout')).toContainText('STANDBY');
    await page.reload();
    await dismissGameGuide(page);
    await expect(page.getByRole('heading', { name: '选择游戏资源' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '联机设置' })).toBeHidden();
  } finally {
    await unreadableCache.close();
  }
} finally {
  await browser.close();
}
