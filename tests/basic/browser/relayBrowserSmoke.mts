/** Asset-free end-to-end test: independent browser contexts, main thread and real Worker, and bidirectional relay datagrams. */
import { chromium, firefox, expect } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const relayUrl = process.env.RELAY_PROBE_URL ?? '127.0.0.1:15176';
const permissionName = process.env.RELAY_PROBE_PERMISSION ?? 'local-network-access';
const engine = process.env.RELAY_PROBE_ENGINE ?? 'chromium';
if (engine !== 'chromium' && engine !== 'firefox') throw new Error('RELAY_PROBE_ENGINE 无效');
if (engine === 'firefox' && process.env.RELAY_PROBE_GRANT === '1')
  throw new Error('Firefox 探针不支持自动授予本地网络权限');
const browser = await (engine === 'firefox' ? firefox : chromium).launch({
  args: engine === 'chromium' ? ['--no-sandbox'] : [],
  ...(process.env.RELAY_PROBE_BROWSER ? { executablePath: process.env.RELAY_PROBE_BROWSER } : {}),
});
try {
  const pages: import('@playwright/test').Page[] = [];
  for (const worker of [false, true]) {
    const context = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: true });
    await context.route('**/__ws_probe__', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>WS relay probe</title>' }),
    );
    const page = await context.newPage();
    pages.push(page);
    await page.addInitScript('globalThis.__name = value => value;');
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(msg.text());
    });
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => expect(typeof payload).not.toBe('string'));
      socket.on('framereceived', ({ payload }) => expect(typeof payload).not.toBe('string'));
    });
    if (process.env.RELAY_PROBE_GRANT === '1') {
      await context.grantPermissions([permissionName], { origin: new URL(origin).origin });
    }
    await page.goto(new URL('/__ws_probe__', origin).href);
    await page.evaluate(
      async ({ worker, relayUrl }) => {
        const transportUrl = new URL('/src/games/ra2/networkTransport.ts', location.href).href;
        const portUrl = new URL('/@id/relay-package/client', location.href).href;
        const scope = globalThis as any;
        const start = async (transportUrl: string, portUrl: string, relayUrl: string, port?: MessagePort) => {
          const { createRa2WebSocketTransport } = await import(transportUrl);
          const { PortRelaySocket } = await import(portUrl);
          const state = { ready: false, address: 0, received: [] as number[][], peers: 0, reason: '' };
          const transport = createRa2WebSocketTransport(
            {
              onReady: (self: any) => {
                state.ready = true;
                state.address = self.addr;
              },
              onPeerJoin: () => state.peers++,
              onPeerLeave: () => state.peers--,
              onDatagram: (_src: number, _sport: number, _dport: number, data: Uint8Array) =>
                state.received.push([...data]),
              onClose: (reason: string) => {
                state.ready = false;
                state.reason = reason;
              },
            },
            { room: 'ws-browser-e2e', exeHash: 'a'.repeat(64), name: new Uint8Array([1]) },
            { url: relayUrl, ...(port ? { socketFactory: (url: string) => new PortRelaySocket(port, url) } : {}) },
          );
          return { state, transport };
        };
        if (!worker) {
          const { state, transport } = await start(transportUrl, portUrl, relayUrl);
          scope.probeState = () => state;
          scope.probeSend = (data: number[]) => transport.sendDatagram(0xffffffff, 1234, 1234, new Uint8Array(data));
          scope.probeBurst = (frames: number[][]) => {
            for (const data of frames) scope.probeSend(data);
          };
          scope.probeClose = () => transport.close();
        } else {
          const { serveRelayPort } = await import(portUrl);
          const channel = new MessageChannel();
          const cleanup = serveRelayPort(channel.port1);
          const batchSizes: number[] = [];
          channel.port1.addEventListener('message', (event) => {
            if (event.data.t === 'send') batchSizes.push(event.data.frames.length);
          });
          scope.probeBatchSizes = () => batchSizes;
          const source = `globalThis.__name = value => value; const start = ${start.toString()}; let client; onmessage = async e => {
          if (e.data.t === 'init') client = await start(e.data.transportUrl, e.data.portUrl, e.data.relayUrl, e.data.port);
          if (e.data.t === 'state') postMessage(client?.state);
          if (e.data.t === 'send') client.transport.sendDatagram(0xffffffff, 1234, 1234, new Uint8Array(e.data.data));
          if (e.data.t === 'burst') for (const data of e.data.frames) client.transport.sendDatagram(0xffffffff, 1234, 1234, new Uint8Array(data));
          if (e.data.t === 'close') client.transport.close();
        };`;
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          const thread = new Worker(url, { type: 'module' });
          thread.postMessage({ t: 'init', transportUrl, portUrl, relayUrl, port: channel.port2 }, [channel.port2]);
          scope.probeState = () =>
            new Promise((resolve) => {
              thread.onmessage = (e) => resolve(e.data);
              thread.postMessage({ t: 'state' });
            });
          scope.probeSend = (data: number[]) => thread.postMessage({ t: 'send', data });
          scope.probeBurst = (frames: number[][]) => thread.postMessage({ t: 'burst', frames });
          scope.probeClose = () => {
            cleanup();
            thread.terminate();
            URL.revokeObjectURL(url);
          };
        }
      },
      { worker, relayUrl },
    );
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).probeState()), { timeout: 25000 })
      .toMatchObject({ ready: true });
  }
  for (const page of pages)
    await expect.poll(() => page.evaluate(() => (globalThis as any).probeState())).toMatchObject({ peers: 1 });
  await pages[0]!.evaluate(() => (globalThis as any).probeSend([0, 255, 1, 42]));
  await pages[1]!.evaluate(() => (globalThis as any).probeSend([4, 3, 2, 1]));
  await expect
    .poll(() => pages[1]!.evaluate(() => (globalThis as any).probeState()))
    .toMatchObject({ received: [[0, 255, 1, 42]] });
  await expect
    .poll(() => pages[0]!.evaluate(() => (globalThis as any).probeState()))
    .toMatchObject({ received: [[4, 3, 2, 1]] });
  const burst = Array.from({ length: 160 }, (_, i) => [i, 255 - i]);
  const beforeBatches = await pages[1]!.evaluate(() => (globalThis as any).probeBatchSizes().length);
  await pages[1]!.evaluate((frames) => (globalThis as any).probeBurst(frames), burst);
  await expect
    .poll(() => pages[0]!.evaluate(() => (globalThis as any).probeState()))
    .toMatchObject({ received: [[4, 3, 2, 1], ...burst] });
  const batches = await pages[1]!.evaluate(
    (before) => (globalThis as any).probeBatchSizes().slice(before),
    beforeBatches,
  );
  expect(batches).toEqual([64, 64, 32]);
  await pages[0]!.evaluate((frames) => (globalThis as any).probeBurst(frames), burst);
  await expect
    .poll(() => pages[1]!.evaluate(() => (globalThis as any).probeState()))
    .toMatchObject({ received: [[0, 255, 1, 42], ...burst] });
  console.log('真实 Worker 突发派发', { datagrams: burst.length, portMessages: batches.length, batches });
  const holdMs = Number(process.env.RELAY_PROBE_HOLD_MS ?? 0);
  if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > 60000) throw new Error('RELAY_PROBE_HOLD_MS 无效');
  if (holdMs) await pages[0]!.waitForTimeout(holdMs);
  for (const page of pages)
    expect(await page.evaluate(() => (globalThis as any).probeState())).toMatchObject({ ready: true, peers: 1 });
  const permissions = await Promise.all(
    pages.map((page) =>
      page.evaluate(async (name) => {
        try {
          return { name, state: (await navigator.permissions.query({ name: name as PermissionName })).state };
        } catch {
          return { name, state: 'unsupported' };
        }
      }, permissionName),
    ),
  );
  if (process.env.RELAY_PROBE_GRANT === '1')
    for (const permission of permissions) expect(permission.state).toBe('granted');
  await pages[1]!.evaluate(() => (globalThis as any).probeClose());
  await expect.poll(() => pages[0]!.evaluate(() => (globalThis as any).probeState())).toMatchObject({ peers: 0 });
  await pages[0]!.evaluate(() => (globalThis as any).probeClose());
  console.log(
    JSON.stringify(
      { ok: true, browser: browser.version(), relayUrl, permissions, permissionDenialValidated: false },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
