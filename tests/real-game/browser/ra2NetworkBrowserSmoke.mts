import { nativeStealthScenario } from '../../helpers/nativeStealthScenario';
import { networkAiControl } from '../../helpers/networkAiControl';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import type { DeployQueueEntry } from '../../../src/games/shared/commandQueue';
import type { GamePerformanceSample } from '../../../src/games/performance';
import { summarizeGamePerformance } from '../../helpers/gamePerformance';
/**
 * Two independent browser sessions run real RA2/YR to verify discovery, room creation, game startup, and synchronized MCV deployment.
 * Start pnpm run dev first, with resources in game/ra2; a transport handshake does not prove game startup.
 */
import { startLatencyProxy } from '../../helpers/latencyProxy';
import { chromium, firefox, expect } from '@playwright/test';
import { decodeRelayFrame } from 'relay-package/wire';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createGameRelay } from 'relay-package/server';
import type { RelayFaultConfig } from 'relay-package/faults';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? tmpdir();
mkdirSync(screenshotDirectory, { recursive: true });
const output = mkdtempSync(join(screenshotDirectory, 'ra2-peer-discovery-'));
console.log('E2E 输出目录', output);
const room = process.env.RA2_BROWSER_ROOM;
if (room) throw new Error('请用 RA2_BROWSER_RELAY 的路径选择房间，不再使用 RA2_BROWSER_ROOM');
const originalRelayUrl = process.env.RA2_BROWSER_RELAY;
const relayDelayMs = Number(process.env.RA2_BROWSER_RELAY_DELAY_MS ?? 0);
if (!Number.isFinite(relayDelayMs) || relayDelayMs < 0 || relayDelayMs > 1000)
  throw new Error('relay 单程延迟必须为 0–1000ms');
if (relayDelayMs && !originalRelayUrl) throw new Error('延迟对照需要 RA2_BROWSER_RELAY');
let latencyProxy: Awaited<ReturnType<typeof startLatencyProxy>> | undefined;
let relayUrl = originalRelayUrl;
const relayPath = relayUrl ? new URL(relayUrl).pathname : '/ra2';
const game = process.env.RA2_BROWSER_GAME ?? 'ra2';
const stealthScenario = process.env.RA2_BROWSER_AI_STEALTH;
if (stealthScenario && process.env.RA2_BROWSER_AI_CONTROL !== '1')
  throw new Error('Stealth validation requires AI control');
const traceCommands = process.env.RA2_BROWSER_TRACE_COMMANDS === '1';
const startPage = process.env.RA2_BROWSER_START_PAGE;
if (startPage !== undefined && startPage !== 'lan') throw new Error('联机测试快速入口仅支持 lan');
const baselineRef = process.env.RA2_BROWSER_TIMING_BASELINE_REF;
if (baselineRef && !/^[0-9a-f]{7,40}$/.test(baselineRef)) throw new Error('Timing 对照基线必须是提交哈希');
const timingBaseline = new Map<string, string>();
if (baselineRef)
  for (const id of ['ra2', 'yr']) {
    const path = `src/games/${id}/networkTiming.ts`;
    const source = execFileSync('git', ['show', `${baselineRef}:${path}`], { encoding: 'utf8' });
    // Compare only the committed original-game patch modules; do not replace the EXE, resources, or game state.
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    timingBaseline.set(
      '/' + path,
      compiled.replace(
        /from (['"])(\.{1,2}\/[^'"]+)\1/g,
        (_match, _quote, specifier: string) => `from "${posix.resolve(posix.dirname('/' + path), specifier)}.ts"`,
      ),
    );
  }

const playerCount = Number(process.env.RA2_BROWSER_PLAYERS ?? 2);
const stabilitySeconds = Number(process.env.RA2_BROWSER_STABILITY_SECONDS ?? 10);
const perfWarmupMs = Number(process.env.RA2_BROWSER_PERF_WARMUP_SECONDS ?? 30) * 1000;
const minimumLogicFps = Number(process.env.RA2_BROWSER_MIN_LOGIC_FPS ?? 0);
if (!Number.isFinite(perfWarmupMs) || perfWarmupMs < 0 || !Number.isFinite(minimumLogicFps) || minimumLogicFps < 0) {
  throw new Error('性能预热时间和最低逻辑 FPS 必须是非负有限数');
}
if (minimumLogicFps && stabilitySeconds * 1000 <= perfWarmupMs + 1000)
  throw new Error('性能门槛需要在预热后保留至少两个采样点');

if (!Number.isInteger(stabilitySeconds) || stabilitySeconds < 10 || stabilitySeconds > 600)
  throw new Error('稳定性观察时长必须为 10–600 秒');
if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 8) throw new Error('玩家数必须为 2–8');
function hostMemory() {
  if (process.platform !== 'linux') return null;
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const totalMiB = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1]) / 1024;
  const availableMiB = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]) / 1024;
  let oomKills: number | null = null;
  try {
    oomKills = Number(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').match(/^oom_kill (\d+)/m)?.[1]);
  } catch {
    /* Retain host available-memory data even without cgroup v2. */
  }
  return { totalMiB, availableMiB, oomKills };
}
const memoryStart = hostMemory();
writeFileSync(join(output, 'host-memory-start.json'), JSON.stringify(memoryStart, null, 2));
if (memoryStart) {
  console.log('双端测试内存预检', memoryStart);
  // A real browser renderer, including the 640 MiB guest, uses about 1.1 GiB; allow additional browser and host headroom.
  // Check even for two VMs; admission cannot prevent other jobs on a shared machine from competing for memory later.
  const requiredMiB = playerCount * 1200 + 1024;
  if (!Number.isFinite(memoryStart.availableMiB) || memoryStart.availableMiB < requiredMiB) {
    // Local reports vanish when CI containers exit; log process names and RSS, omitting arguments that may contain credentials.
    try {
      console.error(
        execFileSync('ps', ['-eo', 'pid,ppid,rss,comm', '--sort=-rss'], { encoding: 'utf8', timeout: 2000 })
          .split('\n')
          .slice(0, 16)
          .join('\n'),
      );
    } catch {
      /* If diagnostics are unavailable, still fail under the original memory threshold. */
    }
    throw new Error(
      `${playerCount} VM 同机测试预估需要至少 ${requiredMiB} MiB 可用内存，当前 ${Math.round(memoryStart.availableMiB)} MiB；未运行，不算通过`,
    );
  }
}
const chooseEightPlayerMap = playerCount > 2 || process.env.RA2_BROWSER_MAP_PLAYERS === '8';
// Enable faults only after both players reach the battlefield, affecting one player's downlink while leaving other links normal.
const faultScenario = process.env.RA2_BROWSER_FAULT_SCENARIO;
if (relayUrl && faultScenario) throw new Error('自建 relay 回归与测试专属弱网注入须分开运行');
const faultScenarios: Record<string, RelayFaultConfig> = {
  jitter: { seed: 42, delayMs: 100, jitterMs: 80 },
  loss: { seed: 42, lossRate: 0.03 },
  stall500: { seed: 42, delayMs: 500 },
  blackhole2000: { seed: 42, blackholeMs: 2000 },
  blackhole5000: { seed: 42, blackholeMs: 5000 },
};
if (faultScenario && !faultScenarios[faultScenario]) throw new Error('未知弱网场景');
const faultRelay = faultScenario ? createGameRelay() : undefined;
const relayClients: string[] = [];
const certificate = faultRelay
  ? readFileSync(new URL('../../../node_modules/.vite/basic-ssl/_cert.pem', import.meta.url))
  : undefined;
const faultServer = faultRelay ? createServer({ key: certificate, cert: certificate }) : undefined;
let faultEndpoint: string | undefined;
if (faultServer && faultRelay) {
  faultServer.on('upgrade', (request, socket, head) => {
    relayClients.push(new URL(request.url!, 'https://localhost').searchParams.get('clientId')!);
    faultRelay.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => faultServer.listen(0, '127.0.0.1', resolve));
  faultEndpoint = `wss://127.0.0.1:${(faultServer.address() as AddressInfo).port}/ra2`;
}
if (game !== 'ra2' && game !== 'yr') throw new Error('RA2_BROWSER_GAME 必须是 ra2 或 yr');
const observed = Array.from({ length: playerCount }, () => ({ ready: false, peers: 0, datagrams: 0, closed: false }));
const engine = process.env.RA2_BROWSER_ENGINE ?? 'chromium';
if (engine !== 'chromium' && engine !== 'firefox') throw new Error('RA2_BROWSER_ENGINE 必须是 chromium 或 firefox');
const browser = await (engine === 'firefox' ? firefox : chromium).launch({
  ...(process.env.RA2_BROWSER_EXECUTABLE ? { executablePath: process.env.RA2_BROWSER_EXECUTABLE } : {}),
  args: engine === 'chromium' ? ['--no-sandbox', '--js-flags=--max-old-space-size=4096'] : [],
});
writeFileSync(
  join(output, 'test-config.json'),
  JSON.stringify(
    {
      game,
      browser: browser.version(),
      origin,
      originalRelayUrl,
      relayDelayMs,
      stabilitySeconds,
      startPage: startPage ?? 'default',
      timingBaseline: baselineRef ?? null,
      traceCommands,
      aiControl: process.env.RA2_BROWSER_AI_CONTROL === '1',
      stealthScenario: stealthScenario ?? null,
    },
    null,
    2,
  ),
);
const aiControl = process.env.RA2_BROWSER_AI_CONTROL === '1' ? await networkAiControl(origin) : undefined;
const pages: import('@playwright/test').Page[] = [];
const timingTransitions: Array<
  Array<{ frame: number; sampledAtMs: number; requestedFps: number; maxAhead: number | null }>
> = Array.from({ length: playerCount }, () => []);
const crashedPages = new Set<import('@playwright/test').Page>();
let rejectBrowserFailure!: (error: Error) => void;
const browserFailure = new Promise<never>((_, reject) => {
  rejectBrowserFailure = reject;
});
const click = async (index: number, x: number, y: number) => {
  const page = pages[index]!;
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await moveLocked(page, 360, y);
    await page.waitForTimeout(100);
    await moveLocked(page, x, y);
    await page.waitForTimeout(300);
    // Headless Chromium's locked pointer requires explicit relative deltas; retain the lock to avoid changing coordinate modes mid-test.
    for (const type of ['pointerdown', 'pointerup']) {
      await page.locator('#screen').dispatchEvent(type, {
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
      });
      await page.waitForTimeout(200);
    }
    return;
  }
  const box = (await page.locator('#screen').boundingBox())!;
  const { width, height } = await snapshot(page);
  await page.mouse.move(box.x + box.width * 0.25, box.y + (y / 900) * box.height);
  // Native controls need hover transitions and presses spanning logic frames; instantaneous clicks may be swallowed.
  await page.waitForTimeout(100);
  await page.mouse.move(
    box.x + ((x - 720 + width / 2) / width) * box.width,
    box.y + ((y - 450 + height / 2) / height) * box.height,
  );
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
};
async function moveLocked(page: import('@playwright/test').Page, x: number, y: number) {
  const { width, height } = await snapshot(page);
  if (!(await page.evaluate(() => document.pointerLockElement?.id === 'screen'))) {
    const box = (await page.locator('#screen').boundingBox())!;
    await page.mouse.move(
      box.x + ((x - 720 + width / 2) / width) * box.width,
      box.y + ((y - 450 + height / 2) / height) * box.height,
    );
    return;
  }
  await page.evaluate(
    ({ x, y, width, height }) => {
      const c = document.querySelector<HTMLCanvasElement>('#screen')!,
        b = c.getBoundingClientRect();
      // Within one task, clamp to the edge and return to the target, leaving no edge scrolling and requiring no debug URL.
      for (const [dx, dy] of [
        [10000, 10000],
        [((x - 720 - width / 2 + 1) * b.width) / width, ((y - 450 - height / 2 + 1) * b.height) / height],
      ]) {
        c.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerType: 'mouse',
            pointerId: 1,
            isPrimary: true,
            movementX: dx,
            movementY: dy,
          }),
        );
      }
    },
    { x, y, width, height },
  );
}
// Attach read-only probes only to the test-intercepted Worker entry; do not expose mutable VM debug objects.
// Separate House ABIs for RA2 1.006 and YR 1.001. YR menus stay at 800x600 until the battlefield
// switches to the selected resolution; convert coordinates using read-only surface dimensions, without requiring a debug URL.
const abi =
  game === 'yr'
    ? { vector: 0xa8022c, count: 0xa80238, local: 0xa83d4c, human: 0x1ec, units: 0x5518, size: 0x551c, dead: 0x1f5 }
    : { vector: 0xa3229c, count: 0xa322a8, local: 0xa35db4, human: 0x134, units: 0x5434, size: 0x5438, dead: 0x13d };
const probe = `const controller = installVmWorker(self);
globalThis.__ra2StealthProbe = async (id) => {
  const core = controller.core, m = core?.shim?.memory; if (!m) return null;
  const mod = await import('/src/games/${game}/control.ts');
  const p = mod.${game === 'ra2' ? 'RA2_CONTROL_PROFILE' : 'YR_CONTROL_PROFILE'};
  const u32 = a => core.shim.readU32(a), u8 = a => core.shim.readU8(a);
  const t = u32(p.viewport.tactical), vx = u32(t+0xb0)|0, vy = u32(t+0xb4)|0;
  for (const array of p.arrays) {
    const count=u32(array.address+16), vector=u32(array.address+4);
    if (count > 8192) throw new Error('Invalid oracle count');
    for(let i=0;i<count;i++) {
      const obj=u32(vector+4*i); if(String(u32(obj+p.uniqueId)) !== id || !u8(obj+p.alive) || u8(obj+p.limbo) || (u32(obj+p.health)|0)<=0) continue;
      const x=u32(obj+p.location)|0, y=u32(obj+p.location+4)|0, z=u32(obj+p.location+8)|0;
      const cell=u32(u32(p.viewport.cells)+4*(Math.floor(x/256)+512*Math.floor(y/256)));
      const b=m.read_memory(p.viewport.zScale,8); const scale=new DataView(b.buffer,b.byteOffset,8).getFloat64(0,true);
      const sx=Math.trunc(30*(x-y)/256)-vx, sy=Math.trunc(15*(x+y)/256)-Math.trunc(z*scale+(z>=728?1:0)+.5)-vy;
      const player=u32(u32(p.localHouse)+p.houseIndex), sensor=cell+0x7c+2*player;
      return {id, sensorCount:player<24?(u8(sensor)|(u8(sensor+1)<<8)):0, cell:{x:Math.floor(x/256),y:Math.floor(y/256)}, cloak:u32(obj+p.viewport.cloak),disguised:u8(obj+p.viewport.disguised),objectVisible:u8(obj+p.viewport.visible),revealed:!!(u32(cell+0x12c)&8),cellVisible:u8(cell+0x120)===255&&u8(cell+0x121)===255,inside:sx>=0&&sy>=0&&sx<u32(p.viewport.bounds+8)&&sy<u32(p.viewport.bounds+12)};
    }
  }
  return null;
};
globalThis.__ra2VisibleTerrain = async ({center,water}) => {
  const core=controller.core, m=core?.shim?.memory; if(!m) return [];
  const mod=await import('/src/games/${game}/control.ts'), p=mod.${game === 'ra2' ? 'RA2_CONTROL_PROFILE' : 'YR_CONTROL_PROFILE'};
  const u32=a=>core.shim.readU32(a), u8=a=>core.shim.readU8(a);
  const t=u32(p.viewport.tactical), vx=u32(t+0xb0)|0, vy=u32(t+0xb4)|0;
  const b=m.read_memory(p.viewport.zScale,8), scale=new DataView(b.buffer,b.byteOffset,8).getFloat64(0,true);
  const cells=u32(p.viewport.cells), result=[];
  for(let x=Math.max(0,center.x-16);x<=Math.min(511,center.x+16);x++) for(let y=Math.max(0,center.y-16);y<=Math.min(511,center.y+16);y++) {
    const c=u32(cells+4*(x+512*y)); if(!c || !(u32(c+0x12c)&8) || u8(c+0x120)!==255 || u8(c+0x121)!==255) continue;
    const land=u32(c+0xec); if(water ? land!==2 : ![0,1,5,6,7].includes(land)) continue;
    const z=u8(c+0x11b)*104, sx=30*(x-y)-vx, sy=15*(x+y+1)-Math.trunc(z*scale+(z>=728?1:0)+.5)-vy;
    if(sx>=0&&sy>=0&&sx<u32(p.viewport.bounds+8)&&sy<u32(p.viewport.bounds+12)) result.push({x,y});
  }
  return result.sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y));
};
globalThis.__ra2NetworkUi = () => { const s=controller.core?.shim; return {controls:s?.inspectControlItems().map(c=>({...c,top:s.listboxTopIndices.get(c.hwnd)||0,height:s.controlItemHeights.get(c.hwnd)||16})), windows:s?.inspectWindowState(), scrollbars:[...s.scrollbarStates].map(([hwnd,state])=>({hwnd,...state}))}; };
globalThis.__ra2NetworkSnapshot = async (includeCommands = false) => {
  const core=controller.core, s=core?.shim; if(!s) return null;
  const gamePerformance=await core.getGamePerformance();
  let commands=null;
  if(includeCommands && gamePerformance) {
    if(!core.__commandReader) {
      const module=await import('/src/games/${game}/commandQueue.ts');
      core.__commandReader=module.${game === 'ra2' ? 'createRa2CommandQueueReader' : 'createYrCommandQueueReader'}(s.memory);
    }
    commands=core.__commandReader?.()??null;
  }
  const u32=a=>s.readU32(a), vector=u32(${abi.vector}), count=u32(${abi.count}), local=u32(${abi.local}), players=[];
  if(vector && count>0 && count<=16) for(let i=0;i<count;i++) {
    const h=u32(vector+i*4); if(!h || !s.readU8(h+${abi.human})) continue;
    const units=u32(h+${abi.units}), size=u32(h+${abi.size});
    players.push({index:i,local:h===local,dead:s.readU8(h+${abi.dead}),mcv:units&&size?u32(units):-1});
  }
  const surface=s.surfaces.get(s.primarySurface); let lit=0,total=0,sidebar=0;
  if(surface?.bpp===16 && surface.width===1440 && surface.height===900) {
    const b=s.memory.read_memory(surface.pixels,surface.pitch*surface.height);
    for(let y=100;y<800;y+=10)for(let x=220;x<1200;x+=10){const at=y*surface.pitch+x*2;if(b[at]||b[at+1])lit++;total++;}
    for(let y=100;y<400;y+=10){const at=y*surface.pitch+1350*2;if(b[at]||b[at+1])sidebar++;}
  }
  const sleep = core.image?.importList.find(entry => entry.name === 'Sleep' && entry.dll.toUpperCase() === 'KERNEL32.DLL');
  const sleepOpcode = sleep ? Array.from(s.memory.read_memory(sleep.stub + 11, 4)) : null;
  const timerWorker = core.emulator?.v86 ? Boolean(core.emulator.v86.worker) : null;
  if (!core.__sleepOpcodeReported) {
    core.__sleepOpcodeReported = true;
    console.log('[ra2net probe] Sleep(0)=' + JSON.stringify(sleepOpcode) + '; timerWorker=' + timerWorker);
  }
  return {commands,cadence:{reportMask:s.readU8(${game === 'ra2' ? 0x623bd1 : 0x6476c1}),negotiation:Array.from(s.memory.read_memory(${game === 'ra2' ? 0x6240bc : 0x647bac},2))},relayRttMs:s.ra2RelayRttMs??null,network:s.inspectRa2Network(),networkTiming:${game === 'ra2' ? '{maxAhead:u32(0xa3d560),frameSendRate:u32(0xa3d564),requestedFps:u32(0xa3d568),preCalcMaxAhead:u32(0xa3d57c),preCalcFrameRate:u32(0xa3d580)}' : '{maxAhead:u32(0xa8b550),frameSendRate:u32(0xa8b554),requestedFps:u32(0xa8b558),preCalcMaxAhead:u32(0xa8b56c),preCalcFrameRate:u32(0xa8b570)}'},sleepOpcode,timerWorker,gamePerformance,sampleAt:gamePerformance?.sampledAtMs??performance.now(),logicFrame:gamePerformance?.frame??null,gameSpeed:gamePerformance?.gameSpeed??null,sessionSpeed:gamePerformance?.sessionSpeed??null,phase:core.currentPhase,shell:s.inspectShellPageTitle(),players,lit:total?lit/total:0,sidebar,calls:core.calls,
    width:surface?.width,height:surface?.height};
};`;
type Snapshot = {
  commands: DeployQueueEntry[] | null;
  cadence: { reportMask: number; negotiation: number[] };
  gamePerformance: GamePerformanceSample | null;
  relayRttMs: number | null;
  network: unknown;
  networkTiming: Record<string, number> | null;
  timerWorker: boolean | null;
  sleepOpcode: number[] | null;
  sampleAt: number;
  logicFrame: number | null;
  gameSpeed: number | null;
  sessionSpeed: number | null;
  phase: string;
  shell: string;
  lit: number;
  sidebar: number;
  calls: number;
  width: number;
  height: number;
  players: { index: number; local: boolean; dead: number; mcv: number }[];
};
async function snapshot(page: import('@playwright/test').Page, includeCommands = false): Promise<Snapshot> {
  if (page.isClosed() || crashedPages.has(page)) throw new Error('renderer 已关闭或崩溃，无法读取客体状态');
  const worker = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
  if (!worker) throw new Error('VM Worker 不存在');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const state: Snapshot = await Promise.race([
      worker.evaluate((include) => (globalThis as any).__ra2NetworkSnapshot(include), includeCommands),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('读取客体快照超时（10 秒）')), 10000);
      }),
    ]);
    // Record native target changes from the first playable battlefield; do not wait until after deployment to observe startup negotiation.
    if (
      state?.phase === 'running' &&
      !state.shell &&
      state.sidebar > 10 &&
      state.players.length === playerCount &&
      state.gamePerformance
    ) {
      const entries = timingTransitions[pages.indexOf(page)]!;
      const { frame, sampledAtMs, requestedFps } = state.gamePerformance;
      const maxAhead = state.networkTiming?.maxAhead ?? null;
      if (!entries.length || entries.at(-1)!.requestedFps !== requestedFps || entries.at(-1)!.maxAhead !== maxAhead) {
        entries.push({ frame, sampledAtMs, requestedFps, maxAhead });
        writeFileSync(join(output, 'timing-transitions.json'), JSON.stringify(timingTransitions, null, 2));
      }
    }
    return state;
  } finally {
    clearTimeout(timer);
  }
}
type CommandObservation = DeployQueueEntry & {
  player: number;
  observedMs: number;
  observedFrame: number | null;
  sampledAtMs: number;
};
const commandSamples: Array<{ player: number; observedMs: number; observations?: CommandObservation[] }> = [];
async function deploy(index: number) {
  if (aiControl) {
    await aiControl.deploy(index);
    return;
  }
  if (game === 'yr' || chooseEightPlayerMap || engine === 'firefox') {
    const page = pages[index]!;
    await moveLocked(page, 60, 40);
    if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
      await page
        .locator('#screen')
        .dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
    } else await page.mouse.down();
    await page.waitForTimeout(200);
    await moveLocked(page, 1230, 830);
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
      await page
        .locator('#screen')
        .dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0 });
    } else await page.mouse.up();
    await page.waitForTimeout(300);
  } else await click(index, 637, 427);
  const initial = await snapshot(pages[index]!, traceCommands);
  const houseIndex = initial.players.find((player) => player.local)!.index;
  if (traceCommands)
    for (const page of pages) expect((await snapshot(page, true)).commands, '原生命令队列探针不可用').not.toBeNull();
  const observations: CommandObservation[] = [],
    seen = new Set<string>();
  const sentAt = performance.now();
  await pages[index]!.keyboard.down('d');
  try {
    await expect
      .poll(
        async () => {
          const states = await Promise.all(pages.map((page) => snapshot(page, traceCommands)));
          if (traceCommands)
            for (const [player, state] of states.entries()) {
              expect(state.commands, '命令队列采样失效').not.toBeNull();
              for (const event of state.commands!) {
                if (event.house !== houseIndex || event.frame < initial.logicFrame!) continue;
                const key = JSON.stringify([player, event]);
                if (!seen.has(key)) {
                  seen.add(key);
                  observations.push({
                    ...event,
                    player,
                    observedMs: performance.now() - sentAt,
                    observedFrame: state.logicFrame,
                    sampledAtMs: state.sampleAt,
                  });
                }
              }
            }
          return states.every(
            (state) =>
              state.phase === 'running' &&
              !state.shell &&
              state.players.every((player) => !player.dead) &&
              state.players.find((player) => player.index === houseIndex)?.mcv === 0,
          );
        },
        { timeout: 30000, intervals: [20] },
      )
      .toBe(true);
    commandSamples.push({
      player: index,
      observedMs: performance.now() - sentAt,
      ...(traceCommands ? { observations } : {}),
    });
    writeFileSync(join(output, 'command-latency.json'), JSON.stringify(commandSamples, null, 2));
    if (traceCommands) {
      const outgoing = observations.find((event) => event.player === index && event.queue === 'outgoing');
      expect(outgoing, '必须观察到本机真实部署事件').toBeDefined();
      const executions = pages.map((_, player) =>
        observations.find(
          (event) =>
            event.player === player &&
            event.queue === 'scheduled' &&
            event.executed &&
            event.house === outgoing!.house &&
            event.targetId === outgoing!.targetId &&
            event.targetType === outgoing!.targetType,
        ),
      );
      for (const event of executions) expect(event, '双方必须执行同一目标的原生部署事件').toBeDefined();
      expect(new Set(executions.map((event) => event!.frame)).size, '双方事件必须在相同的计划帧执行').toBe(1);
    }
  } finally {
    await pages[index]!.keyboard.up('d');
  }
}
async function runScenario() {
  if (relayDelayMs) {
    latencyProxy = await startLatencyProxy(originalRelayUrl!, relayDelayMs);
    relayUrl = latencyProxy.url;
  }
  for (let i = 0; i < playerCount; i++) {
    const context = await browser.newContext({
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await aiControl?.prepare(context);
    // Verify authorized multiplayer connectivity; Chromium permission prompts are neither game failures nor permission-denial tests.
    if (engine === 'chromium')
      await context.grantPermissions(['local-network-access'], { origin: new URL(origin).origin });
    await context.addInitScript((game) => localStorage.setItem(`vm-resolution-${game}`, '1440x900'), game);
    if (baselineRef)
      await context.route('**/src/games/*/networkTiming.ts*', async (route) => {
        const source = timingBaseline.get(new URL(route.request().url()).pathname);
        if (!source) throw new Error('未知 Timing 模块路径');
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: source });
      });
    await context.route('**/src/adapter/vmWorker.ts?*', async (route) => {
      const response = await route.fetch(),
        source = await response.text();
      expect(source).toContain('installVmWorker(self);');
      await route.fulfill({ response, body: source.replace('installVmWorker(self);', probe) });
    });
    if (faultEndpoint)
      await context.route('**/src/games/ra2/networkTransport.ts*', async (route) => {
        const response = await route.fetch(),
          source = await response.text();
        // Change only the WS destination to use a dedicated real test relay; do not replace the game EXE or game state.
        expect(source).toContain('"/ra2"');
        await route.fulfill({ response, body: source.replace('"/ra2"', JSON.stringify(faultEndpoint)) });
      });
    const page = await context.newPage();
    pages.push(page);
    page.on('crash', () => {
      crashedPages.add(page);
      const evidence = { player: i, browser: browser.version(), memory: hostMemory() };
      console.error('Browser renderer crashed', evidence);
      writeFileSync(join(output, `renderer-crash-${i}.json`), JSON.stringify(evidence, null, 2));
      rejectBrowserFailure(new Error(`玩家 ${i} renderer 崩溃`));
    });
    page.on('pageerror', (error) => console.error('page error', error.message));
    page.on('console', (msg) => {
      if (/ra2net|relay|网络/.test(msg.text())) console.log(i, msg.text());
    });
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== relayPath) return;
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') return;
        const message = decodeRelayFrame(payload);
        if (message.t === 'welcome') observed[i]!.ready = true;
        if (message.t === 'peer-join') observed[i]!.peers++;
        if (message.t === 'datagram') observed[i]!.datagrams++;
      });
      socket.on('close', () => {
        observed[i]!.closed = true;
      });
    });
    const pageUrl = new URL('/', origin);
    pageUrl.searchParams.set('network', '1');
    if (startPage) pageUrl.searchParams.set('start-page', startPage);
    if (relayUrl) pageUrl.searchParams.set('relay', relayUrl);
    await page.goto(pageUrl.href);
    await selectDevelopmentGame(page, game);
    if (!startPage) {
      await page.waitForFunction(
        () => /mainmenu/i.test(document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage ?? ''),
        null,
        { timeout: 90000 },
      );
      await page.waitForTimeout(1000);
      await page.locator('#vm-controls-toggle').click();
      await click(i, 1034, 454);
    } else {
      await page.locator('#vm-controls-toggle').click();
    }
    await page.waitForFunction(
      () => /GUI:Lobby/i.test(document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage ?? ''),
      null,
      { timeout: 30000 },
    );
    await expect(page.locator('#vm-network-status')).toHaveAttribute('data-phase', 'connected', { timeout: 20000 });
    // Keep default random startup names so manual test renaming cannot hide identity collisions in ordinary two-tab usage.
  }
  await expect
    .poll(() => observed.every((state) => state.ready && state.peers >= playerCount - 1 && state.datagrams > 1), {
      timeout: 20000,
    })
    .toBe(true);
  // Allow time for the game to consume received datagrams; screenshots help verify native player lists.
  await pages[0]!.waitForTimeout(2000);
  for (let i = 0; i < pages.length; i++) await pages[i]!.screenshot({ path: join(output, `peer-${i}.png`) });
  console.log(game, '双浏览器 LAN 发现通过（尚未开局）', observed, '大厅截图：', output);
  await click(0, 1034, 370);
  await pages[0]!.waitForFunction(
    () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage === 'GUI:HostScreen',
    null,
    { timeout: 30000 },
  );
  if (chooseEightPlayerMap) {
    await pages[0]!.waitForTimeout(5000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await click(0, 1034, 454);
      await pages[0]!.waitForTimeout(1000);
      if ((await snapshot(pages[0]!)).shell !== 'GUI:HostScreen') break;
    }
    await pages[0]!.waitForTimeout(1500);
    const ui = await pages[0]!
      .workers()
      .find((w) => w.url().includes('/vmWorker.ts'))!
      .evaluate(() => (globalThis as any).__ra2NetworkUi());
    writeFileSync(join(output, 'map-controls.json'), JSON.stringify(ui, null, 2));
    await pages[0]!.screenshot({ path: join(output, 'map-picker.png') });
    const list = ui.controls.find((c: any) => c.items.some((text: string) => /2-8|[（(]8[)）]/.test(text)));
    if (!list) throw new Error('未找到原生八人地图列表');
    const target = list.items.findIndex((text: string) => /2-8|[（(]8[)）]/.test(text));
    const rect = ui.windows.find((w: any) => w.hwnd === list.hwnd)?.rect;
    if (!rect) throw new Error('地图列表缺少布局');
    const surface = await snapshot(pages[0]!);
    const scrollbar = ui.windows.find(
      (w: any) =>
        w.className.toLowerCase() === 'scrollbar' &&
        w.rect?.y === rect.y &&
        Math.abs(w.rect.x - rect.x - rect.width) < 4,
    );
    if (!scrollbar) throw new Error('地图列表缺少原生滚动条');
    let top = list.top;
    const rows = Math.floor(rect.height / list.height);
    for (let attempt = 0; target >= top + rows && attempt < 80; attempt++) {
      await click(
        0,
        rect.x + rect.width + 8 + 720 - surface.width / 2,
        rect.y + rect.height - 9 + 450 - surface.height / 2,
      );
      top = await pages[0]!
        .workers()
        .find((w) => w.url().includes('/vmWorker.ts'))!
        .evaluate(
          (hwnd) => (globalThis as any).__ra2NetworkUi().scrollbars.find((c: any) => c.hwnd === hwnd).pos,
          scrollbar.hwnd,
        );
    }
    if (target < top || target >= top + rows) throw new Error('原生地图滚动未到达目标');
    await click(
      0,
      rect.x + rect.width / 2 + 720 - surface.width / 2,
      rect.y + (target - top + 0.5) * list.height + 450 - surface.height / 2,
    );
    const selected = await pages[0]!
      .workers()
      .find((w) => w.url().includes('/vmWorker.ts'))!
      .evaluate(
        (hwnd) => (globalThis as any).__ra2NetworkUi().controls.find((c: any) => c.hwnd === hwnd).selection,
        list.hwnd,
      );
    expect(selected).toBe(target);
    console.log('选择八人地图', list.items[target]);
    await pages[0]!.waitForTimeout(1000);
    await click(0, 1034, 370);
    await pages[0]!.waitForTimeout(1000);
    await pages[0]!.screenshot({ path: join(output, 'map-selected.png') });
    await pages[0]!.waitForFunction(
      () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage === 'GUI:HostScreen',
      null,
      { timeout: 10000 },
    );
    const slots = await pages[0]!
      .workers()
      .find((w) => w.url().includes('/vmWorker.ts'))!
      .evaluate(
        () =>
          (globalThis as any)
            .__ra2NetworkUi()
            .windows.filter((w: any) => w.id >= 1041 && w.id <= 1048 && w.style & 0x10000000).length,
      );
    expect(slots).toBe(8);
  }
  console.log('房主已创建房间，等待大厅传播');
  await pages[1]!.waitForTimeout(5000);
  for (let i = 0; i < pages.length; i++) await pages[i]!.screenshot({ path: join(output, `created-${i}.png`) });
  // The first native list item is the lobby; the second is the newly created room. A rejected join must fail the test.
  for (let i = 1; i < playerCount; i++) {
    await click(i, 735, game === 'yr' ? 252 : 312);
    await click(i, 1034, 413);
    await pages[i]!.waitForFunction(
      () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage === 'GUI:JoinScreen',
      null,
      { timeout: 30000 },
    );
  }
  console.log('所有玩家已进入房间，等待原生地图校验');
  // Map verification/transfer may still be running when the join page appears; do not immediately treat Start as a completed game start.
  await pages[1]!.waitForTimeout(10000);
  for (let i = 1; i < playerCount; i++) await click(i, 1034, 413);
  await pages[0]!.waitForTimeout(2000);
  await click(0, 1034, 413);
  for (let attempt = 0; attempt < 4; attempt++) {
    await pages[0]!.waitForTimeout(5000);
    if ((await pages[0]!.locator('#screen').getAttribute('data-shell-page')) !== 'GUI:HostScreen') break;
    console.log('等待原生地图校验后重试开局', attempt + 1);
    for (let i = 1; i < playerCount; i++) await click(i, 1034, 413);
    await pages[0]!.waitForTimeout(1500);
    await click(0, 1034, 413);
  }
  for (const page of pages) await moveLocked(page, 720, 450);
  await expect
    .poll(
      async () =>
        (await Promise.all(pages.map((page) => snapshot(page)))).every(
          (s) =>
            s.phase === 'running' &&
            !s.shell &&
            s.sidebar > 10 &&
            s.players.length === playerCount &&
            s.players.every((p) => p.mcv === 1 && !p.dead),
        ),
      { timeout: 90000 },
    )
    .toBe(true);
  console.log('所有玩家已进入战场，原生 House 与侧栏检查通过');
  // Houses exist during loading; send battlefield commands only after the construction sidebar appears.
  await pages[0]!.waitForTimeout(2000);
  for (const page of pages) {
    await moveLocked(page, 720, 450);
    await page.keyboard.press('h', { delay: 150 });
  }
  await expect
    .poll(async () => (await Promise.all(pages.map((page) => snapshot(page)))).every((s) => s.lit > 0.05), {
      timeout: 20000,
    })
    .toBe(true);
  await pages[0]!.waitForTimeout(2000);
  for (let i = 0; i < playerCount; i++) await pages[i]!.screenshot({ path: join(output, `battlefield-${i}.png`) });
  const before = await Promise.all(pages.map((page) => snapshot(page)));
  console.log(
    '客体 Sleep(0) 桩指令',
    before.map((state) => state.sleepOpcode),
  );
  const expectedCadence = process.env.RA2_BROWSER_EXPECT_CADENCE;
  if (expectedCadence)
    for (const state of before) {
      expect(['original', 'short']).toContain(expectedCadence);
      expect(state.cadence.reportMask, '必须实际加载指定 Timing 对照版本').toBe(
        expectedCadence === 'original' ? 127 : 31,
      );
      expect(state.cadence.negotiation).toEqual(expectedCadence === 'original' ? [132, 192] : [168, 63]);
    }
  const expectedSleep = process.env.RA2_BROWSER_EXPECT_SLEEP;
  if (expectedSleep)
    for (const state of before) {
      expect(['software', 'pit']).toContain(expectedSleep);
      expect(state.sleepOpcode?.slice(0, 2)).toEqual(expectedSleep === 'software' ? [251, 205] : [251, 244]);
    }
  const expectedTimer = process.env.RA2_BROWSER_EXPECT_TIMER_WORKER;
  if (expectedTimer !== undefined)
    for (const state of before) {
      expect(['0', '1']).toContain(expectedTimer);
      expect(state.timerWorker).toBe(expectedTimer === '1');
    }
  if (aiControl) {
    await aiControl.connect(pages);
    const evidence = await aiControl.checkViews();
    writeFileSync(join(output, 'ai-views.json'), JSON.stringify(evidence, null, 2));
    console.log('CLI player visibility and local-only camera checks passed');
  }
  const guestIndex = before[1]!.players.find((p) => p.local)!.index;
  expect(before[0]!.players.find((p) => p.local)!.index).not.toBe(guestIndex);
  if (faultRelay && faultScenario) {
    expect(relayClients).toHaveLength(playerCount);
    faultRelay.setFaults({ ...faultScenarios[faultScenario], toClientId: relayClients[1] });
    console.log('已在战场启用单玩家下行弱网', faultScenario, relayClients[1]);
  }
  // YR's H key does not center the MCV before a construction yard exists, so RA2's fixed click point cannot be reused.
  // Box-select currently visible units and deploy them through native mouse/keyboard input, without writing guest state.
  await deploy(1);
  await expect
    .poll(
      async () =>
        (await Promise.all(pages.map((page) => snapshot(page)))).every(
          (s) => s.phase === 'running' && !s.shell && s.players.find((p) => p.index === guestIndex)?.mcv === 0,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  // After the first command synchronizes under poor network conditions, another player sends a new command to rule out merely stale state looking correct.
  for (const index of playerCount > 2 ? [...pages.keys()].filter((i) => i !== 1) : faultRelay || aiControl ? [0] : []) {
    const hostIndex = before[index]!.players.find((p) => p.local)!.index;
    await deploy(index);
    await expect
      .poll(
        async () =>
          (await Promise.all(pages.map((page) => snapshot(page)))).every(
            (s) =>
              s.phase === 'running' &&
              !s.shell &&
              s.players.find((p) => p.index === hostIndex)?.mcv === 0 &&
              s.players.every((p) => !p.dead),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
  }
  if (stealthScenario) await nativeStealthScenario(aiControl!, pages, output, stealthScenario);
  console.log('客机展开基地车双端同步通过，开始持续观察', stabilitySeconds);
  const perfStart = await Promise.all(pages.map((page) => snapshot(page)));
  const packets = observed.map((s) => s.datagrams);
  const timeline: Snapshot[][] = [perfStart];
  const lastProgressAt = perfStart.map((state) => state.sampleAt);
  // The explicit five-second blackhole scenario allows recovery headroom; normal LAN tests must not hide stalls behind the fault budget.
  const maxLogicStallMs = faultScenario === 'blackhole5000' ? 10000 : 5000;
  for (let second = 0; second < stabilitySeconds; second++) {
    await pages[0]!.waitForTimeout(1000);
    const sample = await Promise.all(pages.map((page) => snapshot(page)));
    for (let i = 0; i < sample.length; i++) {
      const state = sample[i]!,
        previous = timeline.at(-1)![i]!;
      expect(state.phase).toBe('running');
      expect(state.shell).toBe('');
      expect(state.players).toHaveLength(playerCount);
      expect(state.players.every((player) => !player.dead)).toBe(true);
      expect(observed[i]!.closed).toBe(false);
      expect(state.gamePerformance, '真实逻辑帧探针不可用：检查 EXE 哈希/签名').not.toBeNull();
      expect(state.gamePerformance!.status, '战场计数重置或采样失效').toBe('sample');
      console.log('[game-perf]', JSON.stringify({ player: i, ...state.gamePerformance }));
      if (state.logicFrame !== null) {
        if (state.logicFrame > previous.logicFrame!) lastProgressAt[i] = state.sampleAt;
        expect(state.sampleAt - lastProgressAt[i]!, `玩家 ${i} 逻辑停滞超过 ${maxLogicStallMs}ms`).toBeLessThan(
          maxLogicStallMs,
        );
      }
    }
    timeline.push(sample);
    // Write samples every second so evidence preceding a timeout or crash survives.
    writeFileSync(join(output, 'performance-timeline.json'), JSON.stringify(timeline, null, 2));
  }
  const after = await Promise.all(pages.map((page) => snapshot(page)));
  const rtt = await Promise.all(pages.map((page) => page.locator('#vm-network-status').textContent()));
  writeFileSync(
    join(output, 'latency.json'),
    JSON.stringify({ originalRelayUrl, relayDelayMs, addedRttMs: relayDelayMs * 2, rtt }, null, 2),
  );
  const performanceSamples = perfStart.map((start, i) => {
    const samples = timeline.map((row) => row[i]!.gamePerformance);
    if (samples.some((sample) => !sample)) throw new Error('性能采样缺少真实帧探针');
    return {
      start,
      end: timeline.at(-1)![i],
      warmupMs: perfWarmupMs,
      overall: summarizeGamePerformance(samples as GamePerformanceSample[]),
      warmed: summarizeGamePerformance(samples as GamePerformanceSample[], perfWarmupMs),
    };
  });
  writeFileSync(join(output, 'performance.json'), JSON.stringify(performanceSamples, null, 2));
  if (minimumLogicFps)
    for (const sample of performanceSamples) {
      expect(sample.warmed?.valid, '预热后性能窗口缺失或计数重置').toBe(true);
      expect(sample.warmed!.logicFps, '预热后真实逻辑 FPS 未达门槛').toBeGreaterThanOrEqual(minimumLogicFps);
    }
  for (let i = 0; i < playerCount; i++) {
    expect(after[i]!.phase).toBe('running');
    expect(after[i]!.shell).toBe('');
    expect(after[i]!.lit).toBeGreaterThan(0.05);
    expect(after[i]!.calls).toBeGreaterThan(before[i]!.calls);
    expect(after[i]!.players.every((p) => !p.dead)).toBe(true);
    expect(observed[i]!.datagrams).toBeGreaterThan(packets[i]! + 10);
    expect(observed[i]!.closed).toBe(false);
    await pages[i]!.screenshot({ path: join(output, `synchronized-${i}.png`) });
  }
  for (const state of after) expect(state.players.map((p) => p.mcv)).toEqual(after[0]!.players.map((p) => p.mcv));
  if (stabilitySeconds > 10 && !faultRelay && !aiControl && playerCount === 2) {
    const hostIndex = before[0]!.players.find((player) => player.local)!.index;
    await deploy(0);
    await expect
      .poll(
        async () =>
          (await Promise.all(pages.map((page) => snapshot(page)))).every(
            (state) =>
              state.phase === 'running' &&
              !state.shell &&
              state.players.every((player) => !player.dead) &&
              state.players.find((player) => player.index === hostIndex)?.mcv === 0,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    console.log('持续观察后房主新命令双端同步通过');
  }
  console.log(
    game,
    '双浏览器开局与基地车展开同步通过',
    JSON.stringify(
      {
        browser: browser.version(),
        origin,
        relayUrl: relayUrl ?? '同源默认',
        room: room ?? '默认公共房间',
        states: after,
        screenshots: output,
      },
      null,
      2,
    ),
  );
  if (faultRelay) {
    const evidence = {
      scenario: faultScenario,
      scope: '仅第二位玩家下行',
      states: after,
      stats: faultRelay.getStats(),
      faults: faultRelay.getFaultStats(),
      screenshots: output,
    };
    writeFileSync(join(output, 'weak-network.json'), JSON.stringify(evidence, null, 2));
    expect(evidence.faults.delayed + evidence.faults.dropped).toBeGreaterThan(0);
    console.log('弱网双端新命令同步证据', JSON.stringify(evidence));
  }
}
try {
  await Promise.race([browserFailure, runScenario()]);
} catch (error) {
  const states = await Promise.all(pages.map((page) => snapshot(page, traceCommands).catch(() => null)));
  console.error('失败时原生状态：', JSON.stringify(states, null, 2));
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify({ error: String(error), engine, browser: browser.version(), states, observed }, null, 2),
  );
  if (faultRelay)
    writeFileSync(
      join(output, 'weak-network-failure.json'),
      JSON.stringify(
        {
          scenario: faultScenario,
          error: String(error),
          states,
          observed,
          stats: faultRelay.getStats(),
          faults: faultRelay.getFaultStats(),
        },
        null,
        2,
      ),
    );
  for (let i = 0; i < pages.length; i++)
    await pages[i]!.screenshot({ path: join(output, `failure-${i}.png`), timeout: 5000 }).catch(() => {});
  console.error('失败截图：', output);
  throw error;
} finally {
  writeFileSync(join(output, 'host-memory-end.json'), JSON.stringify(hostMemory(), null, 2));
  await latencyProxy?.close();
  await browser.close();
  await aiControl?.close();
  faultRelay?.close();
  await faultRelay?.drained();
  if (faultServer) await new Promise<void>((resolve) => faultServer.close(() => resolve()));
}
