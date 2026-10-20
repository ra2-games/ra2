import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { chromium, type Locator, type Page } from '@playwright/test';

const ORIGIN = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const MENU_FRAME_SAMPLES = 6;
const GAME_ID = process.env.RA2_BROWSER_GAME === 'yr' ? 'yr' : 'ra2';
const GAME_LABEL = GAME_ID === 'yr' ? 'RA2YR' : 'RA2';
const EXECUTABLE = GAME_ID === 'yr' ? 'gamemd.exe' : 'game.exe';
// clickLogical takes normalized 1440x900 coordinates; RA2 and YR sidebars have different actual horizontal positions.
const MAIN_SINGLE_PLAYER: readonly [number, number] = GAME_ID === 'yr' ? [1288, 330] : [1034, 371];
const SINGLE_PLAYER_BACK: readonly [number, number] = GAME_ID === 'yr' ? [1288, 830] : [1034, 708];
const SINGLE_PLAYER_CAMPAIGN: readonly [number, number] = GAME_ID === 'yr' ? [1288, 330] : [1034, 371];

function serverReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(ORIGIN, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    req.setTimeout(1_000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await serverReady()) return null;
  const origin = new URL(ORIGIN);
  // Start Vite directly so finally terminates the server itself, leaving no npm grandchild holding the port.
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', origin.hostname, '--port', origin.port || '443'],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite 提前退出：${server.exitCode}`);
    if (await serverReady()) return server;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill('SIGTERM');
  throw new Error('等待 Vite 启动超时');
}

async function expectShellPage(page: Page, expected: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    (name) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage?.toLowerCase().includes(name),
    expected.toLowerCase(),
    { timeout },
  );
}

async function waitForQuietFileReads(page: Page, canvas: Locator): Promise<void> {
  const deadline = Date.now() + 10_000;
  let quietBatches = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (!batchText) continue;
    const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
    const reads = batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0;
    quietBatches = batch.calls < 4_000 && reads <= 100 ? quietBatches + 1 : 0;
    if (quietBatches >= 2) return;
  }
  throw new Error('主菜单文件读取在 10 秒内未进入稳态');
}

async function clickUntilShellPage(page: Page, canvas: Locator, expected: string, x: number, y: number): Promise<void> {
  const offsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [-50, 0],
    [50, 0],
    [0, -10],
    [0, 10],
    [0, -25],
    [0, 25],
    [-35, -12],
    [35, 12],
    [0, 0],
  ] as const;
  for (let attempt = 0; attempt < offsets.length; attempt++) {
    const current = (await canvas.getAttribute('data-shell-page')) ?? '';
    if (current.toLowerCase().includes(expected.toLowerCase())) return;
    await clickLogical(page, canvas, x + offsets[attempt]![0], y + offsets[attempt]![1]);
    try {
      // Native page transitions synchronously destroy batches of Win32 child windows and may reopen
      // LANGUAGE.MIX/Bink when returning to the main menu. Clicking old owner-drawn controls too early causes reentrancy during destruction.
      // After one real click, allow a full settling window before retrying a click potentially swallowed by animation.
      await expectShellPage(page, expected, 6_000);
      return;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`菜单切换中断：${status.phase}：${status.detail}`);
        }
      }
      // The original game may swallow a click while repainting buttons in the same tick; retry only if still on the original page.
    }
  }
  await canvas.screenshot({ path: `/tmp/${GAME_ID}-${expected}-click-failed.png` });
  await expectShellPage(page, expected, 1_000);
}

async function clickLogical(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  const targetX = (x / 1440) * width!;
  const targetY = (y / 900) * height!;
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, targetX, targetY, width!, height!, box.width, box.height);
    return;
  }
  const clientX = box.x + (targetX / width!) * box.width;
  const clientY = box.y + (targetY / height!) * box.height;
  // After a page transition, the same position refers to the next-level button; move away and back to generate a fresh hover.
  // RA2 sidebar buttons are about 100 CSS pixels wide; moving only 30 pixels stays inside the same button and produces no
  // mouse-leave -> enter hover transition. Move to the left half of the screen before returning to the button center.
  await page.mouse.move(box.x + box.width * 0.25, clientY);
  await page.waitForTimeout(100);
  await page.mouse.move(clientX, clientY);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function clickLockedGuest(
  page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  await moveLockedGuest(page, canvas, x, y, width, height, cssWidth, cssHeight);
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointerdown', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 1,
  });
  await page.waitForTimeout(200);
  await canvas.dispatchEvent('pointerup', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 0,
  });
}

async function moveLockedGuest(
  _page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  const cursor = (await canvas.getAttribute('data-vm-cursor'))?.match(/^(\d+),(\d+)\//);
  const currentX = Number(cursor?.[1] ?? width / 2);
  const currentY = Number(cursor?.[2] ?? height / 2);
  const relative = (logicalDelta: number, cssExtent: number, logicalExtent: number): number => {
    if (!logicalDelta) return 0;
    const scaled = (logicalDelta * cssExtent) / logicalExtent;
    // PointerEvent movement uses integer device counts; even a remainder below 1 CSS pixel must produce one event.
    return Math.sign(scaled) * Math.max(1, Math.abs(scaled));
  };
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: relative(x - currentX, cssWidth, width),
    movementY: relative(y - currentY, cssHeight, height),
  });
}

function callsOf(raw: string | null): Record<string, number> {
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

async function probeHostUi(page: Page): Promise<void> {
  const theme = await page.evaluate(() => ({
    yellow: getComputedStyle(document.documentElement).getPropertyValue('--ra2-yellow').trim(),
    debugBorder: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug')!).borderLeftColor,
    sectionRadius: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug .vm-debug-section')!).borderRadius,
    toolbarBackground: getComputedStyle(document.querySelector<HTMLElement>('#vm-controls .toolbar-button')!)
      .backgroundImage,
  }));
  assert.equal(theme.yellow.toLowerCase(), '#d8cf00', `网页未应用 RA2 信息黄：${JSON.stringify(theme)}`);
  assert.equal(theme.debugBorder, 'rgb(150, 150, 150)', `Debug 金属边框未生效：${JSON.stringify(theme)}`);
  assert.equal(theme.sectionRadius, '0px', `Debug 面板仍是普通圆角卡片：${JSON.stringify(theme)}`);
  // Toolbar buttons use three CSS states and no longer depend on game-menu sprites.
  assert(theme.toolbarBackground.includes('linear-gradient'), `CSS 工具按钮未生效：${JSON.stringify(theme)}`);

  // The old game-specific cursor table is gone; use the generic memory-recording output box to verify accelerated panel wheel scrolling.
  const scroller = page.locator('#vm-debug pre').first();
  const oldStyle = (await scroller.getAttribute('style')) ?? '';
  const oldText = (await scroller.textContent()) ?? '';
  await scroller.evaluate((element: HTMLElement) => {
    element.style.height = '80px';
    element.style.maxHeight = '80px';
    element.style.overflowY = 'auto';
    element.textContent = Array.from({ length: 40 }, (_, index) => `probe ${index}`).join('\n');
    element.scrollTop = 0;
  });
  await scroller.hover();
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(100);
  const scrollTop = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
  assert(scrollTop >= 90, `网页面板滚轮未加速：deltaY=40 后只滚动 ${scrollTop}px`);
  await scroller.evaluate(
    (element: HTMLElement, previous: { style: string; text: string }) => {
      element.setAttribute('style', previous.style);
      element.textContent = previous.text;
      element.scrollTop = 0;
    },
    { style: oldStyle, text: oldText },
  );
  console.log(
    `🔬 网页 HUD：信息黄=${theme.yellow}，灰黑金属按钮，工业边角=${theme.sectionRadius}，滚轮 40→${scrollTop}px`,
  );
}

async function probeCampaignHover(page: Page, canvas: Locator, playCallsBeforePage: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Campaign canvas 不可见');
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  await moveLockedGuest(page, canvas, 80, 520, width!, height!, box.width, box.height);
  await page.waitForTimeout(300);
  const hoverDispatchesBefore = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  const beforeCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const before = beforeCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await moveLockedGuest(page, canvas, 454, 188, width!, height!, box.width, box.height);
  const hashes = new Set<string>();
  for (let sample = 0; sample < 6; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    await page.waitForTimeout(150);
  }
  const hoverDispatchesEntered = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesEntered,
    hoverDispatchesBefore + 1,
    `阵营 logo 首次进入未产生且仅产生一次 hover：${hoverDispatchesBefore}→${hoverDispatchesEntered}`,
  );
  for (const [x, y] of [
    [465, 188],
    [475, 192],
    [460, 180],
    [470, 186],
  ] as const) {
    await moveLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  const hoverDispatchesAfterWiggle = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesAfterWiggle,
    hoverDispatchesEntered,
    `同一阵营内部移动重复触发 hover 音频：${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}`,
  );
  const afterCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const after = afterCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const changedAudio = Object.fromEntries(
    Object.entries(afterCalls).filter(([key, count]) => count !== (beforeCalls[key] ?? 0)),
  );
  const target = await canvas.getAttribute('data-vm-worker-mouse');
  const dispatchTarget = await canvas.getAttribute('data-vm-worker-dispatch');
  assert(
    (afterCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) &&
      (afterCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0) >
        (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0),
    `阵营 logo hover 后 DirectSound PCM 没有继续写入：${JSON.stringify(changedAudio)}`,
  );
  assert(hashes.size >= 2, `阵营 logo hover 没有动画：6 次采样只有 ${hashes.size} 张画面，命中=${target}`);
  console.log(
    `🔬 阵营 hover：页面前/移开/移入 DirectSound Play ` +
      `${playCallsBeforePage}/${before}/${after}，Static 分派=${dispatchTarget}，` +
      `enter-edge=${hoverDispatchesBefore}→${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}，` +
      `PCM Lock/Unlock 持续更新，变化帧=${hashes.size}/6`,
  );
}

async function probeCampaignVideo(page: Page, canvas: Locator, audioBefore: Record<string, number>): Promise<void> {
  // Native DLL calls do not cross the host import dispatcher. Observe the decoder's
  // DirectSound output and changing video frames instead of requiring shim Open counters.
  await page.waitForFunction(
    (before) => {
      const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmAudioCalls ?? '{}';
      const calls = JSON.parse(raw) as Record<string, number>;
      return (calls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0) > before;
    },
    audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0,
    { timeout: 30_000 },
  );
  // The reported failure occurs during audio/wait processing mid-playback, not on the first frame. Observe for eight seconds,
  // checking call batches every 500 ms to avoid missing a BinkWait storm by examining only the first 1.2 seconds.
  const hashes = new Set<string>();
  let maxBinkWaitCalls = 0;
  let maxSoundPositionCalls = 0;
  let maxBatchCalls = 0;
  for (let sample = 0; sample < 32; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (sample >= 4 && batchText) {
      const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
      maxBatchCalls = Math.max(maxBatchCalls, batch.calls);
      maxBinkWaitCalls = Math.max(
        maxBinkWaitCalls,
        batch.hot.find(([key]) => key === 'BINKW32.DLL!_BinkWait@4')?.[1] ?? 0,
      );
      maxSoundPositionCalls = Math.max(
        maxSoundPositionCalls,
        batch.hot.find(([key]) => key === 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition')?.[1] ?? 0,
      );
    }
    await page.waitForTimeout(250);
  }
  assert(hashes.size >= 12, `战役过场没有持续播放：32 次采样只有 ${hashes.size} 张画面`);
  assert(
    maxBinkWaitCalls < 100,
    `战役过场 BinkWait 仍在宿主 hypercall 自旋：最高 ${maxBinkWaitCalls}/500ms，总调用 ${maxBatchCalls}/500ms`,
  );
  // Cursor queries are Worker-local shim calls, not frontend RPCs. Track their
  // count diagnostically and apply the same total host-call budget as the menu.
  assert(maxBatchCalls < 4_000, `战役过场 Worker 调用批次过载：${maxBatchCalls}/500ms`);
  const audioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const buffersBefore = audioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const buffersAfter = audioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const playsBefore = audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const playsAfter = audioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  assert(
    buffersAfter > buffersBefore && playsAfter > playsBefore,
    `战役过场没有建立并播放音频缓冲：CreateSoundBuffer ${buffersBefore}→${buffersAfter}，Play ${playsBefore}→${playsAfter}`,
  );
  console.log(
    `🔬 战役过场：8 秒变化帧=${hashes.size}/32，` +
      `BinkWait=${maxBinkWaitCalls}/500ms，声音游标=${maxSoundPositionCalls}/500ms，` +
      `音频 buffer=${buffersBefore}→${buffersAfter}、Play=${playsBefore}→${playsAfter}；` +
      `等待原版影片自然结束`,
  );
}

async function clickGuest(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    return;
  }
  await page.mouse.move(box.x + (x / width!) * box.width, box.y + (y / height!) * box.height);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

type BattlefieldSignal = {
  rightEdgeRatio: number;
  fieldRatio: number;
  frame: number;
};

async function battlefieldSignal(canvas: Locator): Promise<BattlefieldSignal> {
  const ratios = ((await canvas.getAttribute('data-vm-battlefield')) ?? '0,0').split(',').map(Number);
  return {
    rightEdgeRatio: ratios[0] ?? 0,
    fieldRatio: ratios[1] ?? 0,
    frame: Number((await canvas.getAttribute('data-vm-frame')) ?? 0),
  };
}

async function waitForPlayableBattle(
  page: Page,
  canvas: Locator,
  timeoutMs: number,
): Promise<{
  elapsedMs: number;
  signal: BattlefieldSignal;
}> {
  const startedAt = Date.now();
  let lastSignal: BattlefieldSignal = { rightEdgeRatio: 0, fieldRatio: 0, frame: 0 };
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    const rawStatus = await canvas.getAttribute('data-vm-status');
    if (rawStatus) {
      const status = JSON.parse(rawStatus) as { phase: string; detail: string };
      if (status.phase === 'error' || status.phase === 'blocked') {
        throw new Error(`战役运行中断：${status.phase}：${status.detail}`);
      }
    }
    lastSignal = await battlefieldSignal(canvas);
    if (lastSignal.rightEdgeRatio >= 0.08 && lastSignal.fieldRatio >= 0.05) {
      return { elapsedMs: Date.now() - startedAt, signal: lastSignal };
    }
    if (Date.now() - lastLogAt >= 5_000) {
      lastLogAt = Date.now();
      console.log(
        `⏳ 等待可操作战场 ${Math.round((Date.now() - startedAt) / 1_000)}s：` +
          `右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，地图=${lastSignal.fieldRatio.toFixed(3)}，` +
          `帧=${lastSignal.frame}，批次=${await canvas.getAttribute('data-vm-batch')}`,
      );
    }
  }
  throw new Error(
    `等待可操作战场超时：右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，` +
      `地图=${lastSignal.fieldRatio.toFixed(3)}，帧=${lastSignal.frame}`,
  );
}

async function probeMainMenu(
  page: Page,
  canvas: Locator,
): Promise<{
  uniqueFrames: number;
  displayedFps: number;
  maxBatchCalls: number;
  maxReadFileCalls: number;
  emittedFrames: number;
  maxBatchHot: Array<[string, number]>;
}> {
  const hashes = new Set<string>();
  const batches: Array<{ calls: number; hot: Array<[string, number]> }> = [];
  const startFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  await page.waitForTimeout(750);
  for (let sample = 0; sample < MENU_FRAME_SAMPLES; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batch = await canvas.getAttribute('data-vm-batch');
    if (batch) batches.push(JSON.parse(batch));
    await page.waitForTimeout(250);
  }
  const fpsOutput = page.locator('#vm-fps');
  let fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  if (Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0) < 20) {
    await page.waitForTimeout(1_000);
    fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  }
  return {
    uniqueFrames: hashes.size,
    displayedFps: Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0),
    maxBatchCalls: Math.max(0, ...batches.map((batch) => batch.calls)),
    maxReadFileCalls: Math.max(
      0,
      ...batches.map((batch) => batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0),
    ),
    emittedFrames: Number((await canvas.getAttribute('data-vm-frame')) ?? 0) - startFrame,
    maxBatchHot: [...batches].sort((left, right) => right.calls - left.calls)[0]?.hot ?? [],
  };
}

assert(existsSync(`game/ra2/${EXECUTABLE}`), `缺少 game/ra2/${EXECUTABLE}`);
assert(existsSync('game/ra2/BINKW32.DLL'), '缺少 game/ra2/BINKW32.DLL');

const server = await ensureServer();
const browser = await chromium.launch({
  headless: process.env.RA2_BROWSER_HEADFUL !== '1',
  // Both games use 640 MiB of v86 RAM. The headless renderer's default V8 old-space limit can occasionally cause
  // GC starvation or Target crashed after repeated frame probes/screenshots. Raise the limit for the test process
  // so failures reflect guest behavior or assertions rather than Playwright host-memory thresholds.
  args: ['--js-flags=--max-old-space-size=4096'],
});
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript((gameId) => {
    localStorage.setItem('ra2-vm-preferred-game', gameId);
    if (!localStorage.getItem(`vm-resolution-${gameId}`)) {
      localStorage.setItem(`vm-resolution-${gameId}`, '1440x900');
    }
    localStorage.removeItem('vm-clock-rate');
  }, GAME_ID);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    const detail = error.stack ?? error.message;
    pageErrors.push(detail);
    console.error(`❌ ${GAME_LABEL} pageerror：${detail}`);
  });
  page.on('crash', () => console.error(`❌ ${GAME_LABEL} Chromium renderer crashed`));
  await page.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
  // Local resources now require explicit selection; a fresh browser context has no IndexedDB import cache.
  await selectDevelopmentGame(page, GAME_ID);

  const canvas = page.locator('#screen');
  const problem = page.locator('h3').filter({ hasText: /运行错误|接口待实现/ });
  await expectShellPage(page, 'mainmenu', 60_000);
  await waitForQuietFileReads(page, canvas);
  assert.equal(
    await page.locator('#vm-resolution').inputValue(),
    '1440x900',
    `${GAME_LABEL} 网页分辨率选择没有恢复 1440×900 偏好`,
  );
  assert.equal(await page.getByText('客体状态', { exact: true }).count(), 0, '仍渲染无用的客体状态区块');
  await probeHostUi(page);
  const mainMenuProbe = await probeMainMenu(page, canvas);
  assert(
    mainMenuProbe.uniqueFrames >= 5,
    `主菜单视频未连续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${mainMenuProbe.uniqueFrames} 张不同画面，` +
      `VM帧=${mainMenuProbe.emittedFrames}，Bink=${await canvas.getAttribute('data-vm-bink-calls')}`,
  );
  assert(mainMenuProbe.emittedFrames >= 20, `主菜单实际输出帧过低：采样窗口只有 ${mainMenuProbe.emittedFrames} 帧`);
  if (mainMenuProbe.displayedFps > 0) {
    assert(mainMenuProbe.displayedFps >= 20, `主菜单显示帧率过低：${mainMenuProbe.displayedFps.toFixed(1)} fps`);
  }
  assert(
    mainMenuProbe.maxBatchCalls < 4_000,
    `Worker 调用批次过载：${mainMenuProbe.maxBatchCalls} calls/500ms，热点=${JSON.stringify(mainMenuProbe.maxBatchHot)}`,
  );
  assert(
    mainMenuProbe.maxReadFileCalls <= 100,
    `文件读取快速路径失效：ReadFile ${mainMenuProbe.maxReadFileCalls} calls/500ms`,
  );
  console.log(
    `🔬 主菜单视频：变化帧=${mainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，显示=${mainMenuProbe.displayedFps.toFixed(1)}fps，` +
      `VM帧=${mainMenuProbe.emittedFrames}，最大调用批次=${mainMenuProbe.maxBatchCalls}/500ms，` +
      `ReadFile=${mainMenuProbe.maxReadFileCalls}/500ms`,
  );
  assert.equal(await problem.count(), 0, '主菜单出现运行错误');
  await page.waitForTimeout(750);
  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  await page.waitForTimeout(500);
  // Returning to the main menu reopens the same LANGUAGE.MIX video through BinkOpen; checking only the first screen is insufficient.
  // Do not use Esc to leave ordinary menus: RA2's legacy KillTimer/CallWindowProc chain can re-enter alongside
  // Pointer Lock release messages at that point. Clicking the game's own Back button is the stable native path.
  const menuAudioBeforeReturn = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  await clickUntilShellPage(page, canvas, 'mainmenu', ...SINGLE_PLAYER_BACK);
  await waitForQuietFileReads(page, canvas);
  let returnedMainMenuProbe = await probeMainMenu(page, canvas);
  // SetWindowText/MainMenu precedes full decoder recovery on return. If the first window still includes BinkOpen
  // initialization, wait one tick and remeasure steady state without lowering the performance threshold.
  if (returnedMainMenuProbe.emittedFrames < 20) {
    await page.waitForTimeout(1_000);
    returnedMainMenuProbe = await probeMainMenu(page, canvas);
  }
  assert(
    returnedMainMenuProbe.uniqueFrames >= 5,
    `返回主菜单后视频未继续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${returnedMainMenuProbe.uniqueFrames} 张不同画面`,
  );
  assert(
    returnedMainMenuProbe.emittedFrames >= 20,
    `返回主菜单后实际输出帧过低：采样窗口只有 ${returnedMainMenuProbe.emittedFrames} 帧`,
  );
  if (returnedMainMenuProbe.displayedFps > 0) {
    assert(
      returnedMainMenuProbe.displayedFps >= 20,
      `返回主菜单后显示帧率过低：${returnedMainMenuProbe.displayedFps.toFixed(1)} fps`,
    );
  }
  console.log(
    `🔬 返回主菜单视频：变化帧=${returnedMainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，` +
      `显示=${returnedMainMenuProbe.displayedFps.toFixed(1)}fps，VM帧=${returnedMainMenuProbe.emittedFrames}`,
  );

  const menuAudioAfterReturn = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  assert(
    (menuAudioAfterReturn['DSOUND.COM!IDirectSoundBuffer.Release'] ?? 0) >
      (menuAudioBeforeReturn['DSOUND.COM!IDirectSoundBuffer.Release'] ?? 0),
    `${GAME_LABEL} 菜单切换没有释放原版视频音频缓冲`,
  );
  assert.deepEqual(callsOf(await canvas.getAttribute('data-vm-bink-calls')), {}, 'Bink 应直接调用客体 DLL');

  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForTimeout(1_000);
  const campaignHoverPlayBefore =
    callsOf(await canvas.getAttribute('data-vm-audio-calls'))['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await clickUntilShellPage(page, canvas, 'campaign', ...SINGLE_PLAYER_CAMPAIGN);
  await page.waitForTimeout(1_000);
  await probeCampaignHover(page, canvas, campaignHoverPlayBefore);
  const campaignVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  // Leaving the shell means entering the campaign briefing, not necessarily the battlefield. Wait for both the sidebar and
  // map to render before checking Pointer Lock. Click only once per round, then wait for the original game to finish
  // synchronously destroying CampaignMenu. Do not add a click before the retry loop, which turns a normal click into
  // an artificial double-click and enters the reentrant region between old-window destruction and new-window creation.
  const alliedOffsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [0, -10],
    [0, 10],
  ] as const;
  for (const [offsetX, offsetY] of alliedOffsets) {
    if (!(await canvas.getAttribute('data-shell-page'))) break;
    await clickGuest(page, canvas, 454 + offsetX, 188 + offsetY);
    try {
      await page.waitForFunction(
        () => !document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage,
        undefined,
        { timeout: 4_000 },
      );
      break;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`选择阵营中断：${status.phase}：${status.detail}`);
        }
      }
      // Retry clicks swallowed by CampaignMenu repainting only while a shell title remains.
    }
  }
  assert.equal(await canvas.getAttribute('data-shell-page'), null, '选择盟军后仍停在 CampaignMenu');
  await probeCampaignVideo(page, canvas, campaignVideoAudioBefore);
  // Allow the complete original campaign intro to finish; no synthetic Escape or frame changes.
  const battlefieldVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  // YR keeps the shell/campaign briefing at 800x600 and reads RA2MD.INI to switch to the selected mode only on
  // entering the actual battlefield. Wait for the resolution change to avoid treating the briefing as a playable battlefield.
  await page.waitForFunction(
    () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmResolution === '1440x900',
    undefined,
    { timeout: 240_000 },
  );
  const playable = await waitForPlayableBattle(page, canvas, 240_000);
  console.log(
    `🔬 可操作战场：等待=${(playable.elapsedMs / 1_000).toFixed(1)}s，` +
      `右栏=${playable.signal.rightEdgeRatio.toFixed(3)}，地图=${playable.signal.fieldRatio.toFixed(3)}`,
  );
  // Check native audio cleanup across the campaign transition and continued PCM output.
  // These aggregate counters do not identify the top-right briefing movie's handle;
  // DLL Open/Close calls stay entirely within guest execution.
  await page.waitForTimeout(8_000);
  const battlefieldVideoAudioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  assert(
    (battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Release'] ?? 0) >
      (battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Release'] ?? 0),
    `${GAME_LABEL} 战役切换后没有释放音频缓冲`,
  );
  assert(
    (battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0),
    `${GAME_LABEL} 战役切换期间 DirectSound PCM 没有持续写入`,
  );
  console.log(
    `🔬 战役音频生命周期：` +
      `buffer=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}，` +
      `Play=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}，` +
      `Lock=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}`,
  );
  const battleFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  const battleResolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [battleWidth, battleHeight] = battleResolution.split('x').map(Number);
  assert(
    Number.isFinite(battleWidth) && Number.isFinite(battleHeight),
    `${GAME_LABEL} 战场分辨率探针无效：${battleResolution}`,
  );
  assert.equal(battleResolution, '1440x900', `${GAME_LABEL} 未采用内存 INI 覆盖的 1440x900 战场分辨率`);
  const expectedPointer = `${battleWidth! - 1},${battleHeight! - 1}/${battleResolution}`;

  // Reacquire Pointer Lock through a real browser click if the native transition released it.
  // Headless Chromium does not generate relative movementX/Y for subsequent CDP-injected mouse.move calls,
  // so inject relative counts with a PointerEvent probe only after real document.pointerLockElement is established.
  // This covers page conversion -> Worker -> USER32 without mistaking automation limitations for product regressions.
  const battleBox = await canvas.boundingBox();
  if (!battleBox) throw new Error('战场 canvas 不可见');
  await page.mouse.click(battleBox.x + 4, battleBox.y + 4);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  assert.equal(
    await page.evaluate(() => document.pointerLockElement?.id),
    'screen',
    `${GAME_LABEL} 浏览器没有真实进入 Pointer Lock`,
  );
  await moveLockedGuest(
    page,
    canvas,
    battleWidth! - 1,
    battleHeight! - 1,
    battleWidth!,
    battleHeight!,
    battleBox.width,
    battleBox.height,
  );
  // CSS-to-logical scaling is fractional; flooring the first event can leave the cursor one pixel short of the edge.
  // A real mouse continues producing counts toward the edge. Add a positive sweep spanning the whole canvas and
  // require exact boundary clamping: neither retain the old resolution nor allow excess relative movement outside bounds.
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: battleBox.width,
    movementY: battleBox.height,
  });
  await page.waitForTimeout(500);
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    `Pointer Lock 前端未采用战场 ${battleResolution} 边界`,
  );
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmWorkerCursor === expected,
    expectedPointer,
    { timeout: 5_000 },
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-client'),
    battleResolution,
    `客体 GetClientRect 仍未采用战场 ${battleResolution} 边界`,
  );

  // The toolbar no longer has the old data-game-speed buttons. Observe edge scrolling at native speed,
  // without waiting for nonexistent UI or changing guest speed fields to manufacture performance gains.
  // Cover the previously delayed PIT/thread-context corruption after returning from Bink.
  await page.waitForTimeout(10_000);
  assert(Number((await canvas.getAttribute('data-vm-frame')) ?? 0) > battleFrame, '战场画面停止更新');
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    '战场运行 10 秒后前端鼠标边界退回旧分辨率',
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-cursor'),
    expectedPointer,
    '战场运行 10 秒后 Worker 鼠标边界退回旧分辨率',
  );
  assert.equal(await problem.count(), 0, '战场出现运行错误');
  assert.deepEqual(pageErrors, [], `浏览器页面异常：${pageErrors.join('\n')}`);
  const finalFrontPointer = await canvas.getAttribute('data-vm-cursor');
  const finalWorkerPointer = await canvas.getAttribute('data-vm-worker-cursor');
  const textOutCalls = Number((await canvas.getAttribute('data-vm-text-out-calls')) ?? 0);

  // The native select is now hidden; a custom listbox triggers change. Use real visible options to cover safe
  // VM disposal -> reload -> preference restoration, without waiting for the hidden select to become actionable.
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#vm-resolution-toggle').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    page.locator('#vm-resolution-options').getByRole('option', { name: '1024×768', exact: true }).click(),
  ]);
  // The development directory is not a player archive cache; explicitly select development resources again after reload.
  await selectDevelopmentGame(page, GAME_ID);
  await expectShellPage(page, 'mainmenu', 60_000);
  assert.equal(
    await page.locator('#vm-resolution').inputValue(),
    '1024x768',
    `${GAME_LABEL} 重启后没有恢复新选择的分辨率`,
  );
  assert.equal(
    await page.evaluate((gameId) => localStorage.getItem(`vm-resolution-${gameId}`), GAME_ID),
    '1024x768',
    `${GAME_LABEL} 分辨率没有按游戏持久化`,
  );
  assert.deepEqual(pageErrors, [], `分辨率重启后浏览器页面异常：${pageErrors.join('\n')}`);
  console.log(
    `✅ ${GAME_LABEL} Chromium Worker：主菜单视频连续播放，战役流程持续运行，` +
      `Pointer Lock 前端=${finalFrontPointer}，Worker=${finalWorkerPointer}；` +
      `禁用宿主字体时 TextOutA 调用=${textOutCalls}；` +
      `控制栏切换 1024×768 后已安全重启并恢复偏好`,
  );
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
