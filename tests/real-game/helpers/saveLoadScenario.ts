import { InstallationFiles, silentAudio } from './installationFiles';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore } from '../../../src/adapter/vmCore';
import { PortGameFileProvider, serveFileProvider } from '../../../src/adapter/fileProviderPort';
import type { VmStatus } from '../../../src/app/session/runtimeEvents';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../src/games/catalog';
import { Win32Shim } from '../../../src/games/win32Shim';
import { RA2_YR_RESOURCE_POLICY } from '../../../src/games/shared/resourcePolicy';
import type { GameFrameReader } from '../../../src/games/performance';
import { requireGameResources, REPO_ROOT, resolveGameDir } from './gameDir';
import { createMentalOmegaLaunchFiles, readMentalOmegaMenu } from '../../../src/games/mentalOmega/menu';
import { createMentalOmegaLoadFiles } from '../../../src/games/mentalOmega/saves';

class InspectableShim extends Win32Shim {
  public override isWindowVisible(hwnd: number) {
    return super.isWindowVisible(hwnd);
  }
  public override screenRect(hwnd: number) {
    return super.screenRect(hwnd);
  }
}

interface SaveSnapshot {
  executableSha256: string;
  bytes: Uint8Array;
  frame: number;
  objects: number;
}

async function runSession(gameId: SupportedGameId, saved?: SaveSnapshot): Promise<SaveSnapshot | undefined> {
  const game = SUPPORTED_GAMES.find((game) => game.id === gameId)!;
  const files = new InstallationFiles(resolveGameDir(gameId), gameId === 'mo');
  if (saved) await files.write('cold.sav', saved.bytes.slice());
  if (gameId === 'mo') {
    const menu = await readMentalOmegaMenu(files);
    const launch = saved
      ? await createMentalOmegaLoadFiles(files, 'cold.sav')
      : await createMentalOmegaLaunchFiles(files, menu, {
          mode: 'skirmish',
          id: menu.maps[0]!.id,
          side: 0,
          opponents: 1,
          difficulty: 0,
          credits: 10000,
          speed: 2,
        });
    for (const [path, bytes] of launch) await files.write(path, bytes);
  }
  const executableBytes = (await files.read(game.executable))!;
  const executableSha256 = createHash('sha256').update(executableBytes).digest('hex');
  // Exercise the supplied package executable, and require an identical executable for the cold load.
  if (saved) expect(executableSha256).toBe(saved.executableSha256);
  const channel = new MessageChannel();
  const close = serveFileProvider(files, channel.port1);
  const remote = new PortGameFileProvider('cold-load regression', channel.port2, await files.list(''));
  let shim!: InspectableShim;
  let vm!: V86;
  let frameReader: GameFrameReader | undefined;
  let status: VmStatus | undefined;
  let writingSave = false;
  let readingSave = gameId === 'mo' && !!saved;
  let restoredFrame: number | undefined;
  let savedObjects = 0;
  let loadedObjects = 0;
  const core = new VmCore(
    {
      onStatus: (next) => (status = next),
      onCall: (call) => {
        const key = call.imported.key;
        if (writingSave && key === 'OLE32.DLL!OleSaveToStream') {
          savedObjects++;
        }
        if (readingSave && key === 'OLE32.DLL!OleLoadFromStream') loadedObjects++;

        // Read-only observation: never seed the new VM with old heap addresses or game state.
        if (readingSave && loadedObjects && restoredFrame === undefined) {
          const frame = nativeFrame();
          if (frame > 0) restoredFrame = frame;
        }
      },
    },
    {
      game,
      files: remote,
      executableBytes,
    },
    {
      resourcePolicy: RA2_YR_RESOURCE_POLICY,
      fetchBytes: async () => new Uint8Array(readFileSync(join(REPO_ROOT, 'src/vm86/boot.bin'))),
      scheduleFrame: (emit) => setImmediate(emit),
      deferFrameSnapshot: true,
      fastFileRead: true,
      audio: silentAudio,
      createEmulator: (options) =>
        (vm = new V86({ ...options, wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm') })),
      createShim: (memory, options) => (shim = new InspectableShim(memory, options)),
    },
  );
  const visible = (text: string) =>
    shim.inspectWindowState().find((window) => window.text === text && shim.isWindowVisible(window.hwnd));
  const wait = async (label: string, condition: () => boolean, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
      if (condition()) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}: ${status?.detail}`);
  };
  const click = (hwnd: number) => {
    const rect = shim.screenRect(hwnd);
    const x = (rect.x + rect.width / 2) | 0;
    const y = (rect.y + rect.height / 2) | 0;
    const point = (y << 16) | x;
    core.setCursorPosition(x, y);
    core.postMessage(0x200, 0, point);
    core.setKeyState(1, true);
    core.postMessage(0x201, 1, point);
    core.setKeyState(1, false);
    core.postMessage(0x202, 0, point);
  };
  const button = async (text: string) => {
    await wait(text, () => !!visible(text));
    // Native menu transitions briefly expose controls before accepting mouse input.
    await delay(2500);
    click(visible(text)!.hwnd);
  };
  const nativeFrame = () => {
    frameReader ??= game.runtimeHooks!.createFrameReader!(vm, executableBytes)!;
    const counters = frameReader?.();
    if (!counters) throw new Error('Unsupported native frame counter');
    return counters.frame;
  };
  try {
    await core.start();
    if (gameId !== 'mo') {
      // The bundled YR startup movie is approximately four minutes long. Let a fresh
      // installation play it naturally; save/load UI operations retain the shorter timeout.
      const startupAt = performance.now();
      await wait('main menu', () => !!visible('GUI:SinglePlayer'), 300_000);
      console.log(`${gameId} native main menu reached after ${((performance.now() - startupAt) / 1000).toFixed(1)}s`);
      await delay(8000);
      await button('GUI:SinglePlayer');
    }
    if (saved) {
      if (gameId !== 'mo') {
        // No battle startup, warmup match, save, or reused shim before loading.
        await button('GUI:LoadSavedGame');
        await wait('save list', () => !!visible('GUI:Load'));
        const list = shim.inspectWindowState().find((w) => w.className === 'ListBox' && shim.isWindowVisible(w.hwnd))!;
        click(list.hwnd);
        core.postMessage(0x100, 0x24, 1);
        core.postMessage(0x101, 0x24, 0xc0000001);
        readingSave = true;
        await button('GUI:Load');
      }
      await wait('native object restoration', () => loadedObjects > 0, 300_000);
      await wait('saved simulation frame restoration', () => restoredFrame !== undefined, 300_000);
      await wait('loaded battlefield', () => shim.inspectWindowState().length === 1);
      expect(restoredFrame, 'native frame restored from the save').toBe(saved.frame);
      const before = nativeFrame();
      // A spawner has no modal load screen: one window and a restored frame can
      // appear while objects are still deserializing. Wait for simulation first.
      await wait('loaded simulation advances', () => nativeFrame() > before + 60, 300_000);
      expect(loadedObjects, 'native object restoration count').toBe(saved.objects);
      // The loaded game must still accept input; frame progression alone misses broken modal state.
      core.postMessage(0x100, 27, 1);
      core.postMessage(0x101, 27, 0xc0000001);
      await wait('loaded game pause menu', () => !!visible('GUI:SaveGame'));
      return;
    }
    if (gameId !== 'mo') {
      await button('GUI:Skirmish');
      await button('GUI:StartGame');
    }
    await wait('simulation starts', () => nativeFrame() > 0, 300_000);
    await wait('battlefield', () => shim.inspectWindowState().length === 1);
    const before = nativeFrame();
    await wait('battle simulation advances', () => nativeFrame() > before + 120);
    core.postMessage(0x100, 27, 1);
    core.postMessage(0x101, 27, 0xc0000001);
    await button('GUI:SaveGame');
    writingSave = true;
    await button('GUI:Save');
    await wait('save confirmation', () => !!visible('GUI:OK'));
    await core.flushFiles();
    const result = [...files.files].find(([path]) => path.endsWith('.sav'))?.[1];
    expect(result).toBeDefined();
    expect(savedObjects, 'native persistence must not be a successful no-op').toBeGreaterThan(0);
    const snapshot = { executableSha256, bytes: result!.slice(), frame: nativeFrame(), objects: savedObjects };
    await button('GUI:OK');
    await wait('save confirmation closes', () => !visible('GUI:OK'));
    return snapshot;
  } finally {
    try {
      await core.destroy();
    } finally {
      remote.dispose();
      close();
    }
  }
}

// Fail at collection time: missing game resources must surface as a failure, never as a silently removed suite.
export function describeSaveLoad(gameId: SupportedGameId): void {
  requireGameResources(gameId);
  describe(`${gameId} native save cold load`, () => {
    it('saves through the normal menus, then loads persisted bytes in a fresh VM through the file port', async () => {
      const saved = await runSession(gameId);
      const directory = await mkdtemp(join(tmpdir(), 'ra2-save-load-'));
      try {
        const path = join(directory, 'cold.sav');
        await writeFile(path, saved!.bytes);
        await runSession(gameId, { ...saved!, bytes: new Uint8Array(await readFile(path)) });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 720_000);
  });
}
