import { chromium, expect, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { WECHAT_GROUP_QR_URL } from '../../../src/ui/pages/game/groupQr';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const receiver = 'https://monitoring-smoke.invalid';
// Inline defines override local .env and inherited production analytics configuration.
const server = await createServer({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  define: {
    'import.meta.env.VITE_POSTHOG_TOKEN': JSON.stringify('phc_monitoring_smoke'),
    'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify(receiver),
  },
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
});
let browser: Browser | undefined;
const events: Array<{ event: string; timestamp: string; properties: Record<string, unknown> }> = [];
const unexpectedExternalRequests: string[] = [];
const qrUrl = new URL(WECHAT_GROUP_QR_URL);
expect(qrUrl.href).toBe('https://qr1.ra2.games/s/40b87fac.svg');
// A local image fixture exercises image loading without fetching the live group invitation.
const qrFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><path d="M8 8h20v20H8zM36 8h20v20H36zM8 36h20v20H8zM36 36h8v8h-8zM48 48h8v8h-8z" fill="black"/></svg>';
let qrRequests = 0;
try {
  await server.listen();
  const origin = new URL(server.resolvedUrls!.local[0]!).origin;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.continue();
      return;
    }
    if (url.href === qrUrl.href && route.request().resourceType() === 'image' && route.request().method() === 'GET') {
      qrRequests++;
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: qrFixture });
      return;
    }
    if (url.origin !== receiver) {
      unexpectedExternalRequests.push(url.origin);
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/e/') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { batch?: typeof events };
      events.push(...(body.batch ?? []));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{}',
    });
  });
  await preventThirdPartyDownloads(page);
  // The admission guide auto-opens on a fresh page and would swallow the click below.
  // Pre-dismiss it so that click stays the only DOM operation this run records.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ra2-vm-game-guide-skipped', '1');
    } catch {
      /* Storage denial leaves the guide open; monitoring does not depend on it. */
    }
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    performance.getEntriesByType('resource').some((entry) => entry.name.includes('posthog-js.js')),
  );
  // Headless Chromium is correctly filtered as a bot in production. Override only this test client.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('posthog-js.js'))!;
    const sdk = await import(url);
    sdk.default.set_config({ opt_out_useragent_filter: true });
  });
  await page.locator('[data-monitor-action="open-group"]').click();
  const qrImage = page.locator('.join-group-qr');
  await expect(qrImage).toHaveAttribute('src', WECHAT_GROUP_QR_URL);
  await expect(qrImage).toBeVisible();
  await expect
    .poll(() => qrImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
    .toBe(true);
  expect(qrRequests).toBe(1);
  const clickTimestamp = await page.evaluate(async () => {
    const moduleUrl = '/src/platform/browser/operationMonitoring.ts';
    const monitor = await import(moduleUrl);
    const timestamp = new Date();
    // A modal dialog or decorative label may have a GUI title and control ID without being a button.
    for (const className of ['#32770', 'static']) {
      monitor.recordCanvasPress(
        { x: 123, y: 234, width: 800, height: 600, button: 'left', pointer: 'mouse' },
        'ra2',
        'running',
        'GUI:MainMenu',
        {
          lastMouseHitControlId: 1684,
          lastMouseHitClass: className,
          lastMouseHitText: 'GUI:PauseDialog',
          lastMouseInputX: 123,
          lastMouseInputY: 234,
          lastMouseInputMessage: 0x0201,
        },
      );
    }
    monitor.recordCanvasPress(
      { x: 400, y: 300, width: 800, height: 600, button: 'left', pointer: 'mouse' },
      'ra2',
      'running',
      'GUI:MainMenu',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.recordCanvasPress(
      { x: 344, y: 264, width: 800, height: 600, button: 'left', pointer: 'mouse' },
      'ra2',
      'running',
      'GUI:GameOptions',
      {
        lastMouseHitControlId: 1322,
        lastMouseHitClass: 'msctls_trackbar32',
        lastMouseHitText: '',
        lastMouseInputX: 344,
        lastMouseInputY: 264,
        lastMouseInputMessage: 0x0201,
      },
    );
    monitor.recordCanvasPress(
      { x: 123, y: 234, width: 800, height: 600, button: 'left', pointer: 'mouse' },
      'ra2',
      'running',
      'GUI:MainMenu',
      {
        lastMouseHitControlId: 1684,
        lastMouseHitClass: 'button',
        lastMouseHitText: 'GUI:SinglePlayer',
        lastMouseInputX: 123,
        lastMouseInputY: 234,
        lastMouseInputMessage: 0x0202,
      },
      timestamp,
    );
    return timestamp.toISOString();
  });
  // Give the real SDK time to send anything incorrectly triggered by normal operations.
  await page.waitForTimeout(500);
  expect(events).toEqual([]);
  await page.evaluate(async () => {
    const moduleUrl = '/src/platform/browser/operationMonitoring.ts';
    const monitor = await import(moduleUrl);
    monitor.updateOperationContext({ game: 'ra2', phase: 'error', mode: 'worker', shell: 'GUI:MainMenu' });
    const error = new TypeError('Cannot read "private-player" at https://private.invalid/?token=private-secret');
    error.stack =
      'TypeError: private-message\n    at run (https://private.invalid/src/ui/pages/game/page.ts?t=private-secret:12:34)';
    monitor.recordOperationIssue('runtime', 'ra2', error);
    monitor.recordOperationIssue('runtime', 'ra2', error);
  });
  await expect.poll(() => events.length, { timeout: 10_000 }).toBe(1);
  expect(events.map(({ event }) => event)).toEqual(['ra2vm_issue']);
  expect(events.every(({ properties }) => properties.token === 'phc_monitoring_smoke')).toBe(true);
  expect(unexpectedExternalRequests).toEqual([]);
  expect(events[0]?.properties).toMatchObject({
    kind: 'runtime',
    game: 'ra2',
    phase: 'error',
    mode: 'worker',
    error_name: 'TypeError',
    error_stack: '    at run (ui/pages/game/page.ts:12:34)',
    app_version: expect.any(String),
    app_revision: expect.stringMatching(/^[a-f0-9]{12}$/),
  });
  const operations = events[0]!.properties.recent_operations as Array<{
    action: string;
    timestamp: string;
    properties: Record<string, unknown>;
  }>;
  expect(operations).toHaveLength(2);
  expect(operations[0]).toMatchObject({ action: 'button', properties: { control: 'open-group' } });
  expect(operations[1]?.properties).toMatchObject({
    x: 123,
    y: 234,
    button: 'left',
    phase: 'running',
    guest_control: 'GUI:SinglePlayer',
    guest_control_id: 1684,
  });
  expect(Date.parse(operations[1]!.timestamp)).toBeLessThan(Date.parse(events[0]!.timestamp));
  expect(operations[1]!.timestamp).toBe(clickTimestamp);
  await page.evaluate(() => {
    const error = new Error('Global failure C:\\Users\\Alice Smith\\config.json 我的存档.sav');
    error.stack = 'render@https://private.invalid/src/ui/App.tsx?token=secret:12:34\nstart@app.ts:56:78';
    window.dispatchEvent(new ErrorEvent('error', { error }));
    void Promise.reject(new Error('Promise failure C:\\Users\\private\\game.exe'));
  });
  await expect.poll(() => events.length, { timeout: 10_000 }).toBe(3);
  expect(events.slice(1).map(({ properties }) => properties.kind)).toEqual(['uncaught', 'unhandled_rejection']);
  expect(events[1]?.properties.error_stack).toBe('    at render (ui/App.tsx:12:34)\n    at start (app.ts:56:78)');
  expect(JSON.stringify(events)).not.toMatch(/Alice|Smith|config\.json|我的|存档|\[email\]/);
  expect(new Set(events.map(({ properties }) => properties.$session_id)).size).toBe(1);
  expect(JSON.stringify(events)).not.toMatch(/private|\.zip|\$current_url|\$referrer/);
  expect(unexpectedExternalRequests).toEqual([]);
  console.log(
    'Normal operations stay local; issues include bounded context and redacted diagnostics in one anonymous session',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
