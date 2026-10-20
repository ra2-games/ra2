import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { V86 } from 'v86';
import { VmCore } from '../../../src/adapter/vmCore';
import type { VmStatus } from '../../../src/app/session/runtimeEvents';
import { supportedGame } from '../../../src/games/catalog';
import { gameVmConfiguration } from '../../../src/games/vmConfiguration';
import type { Win32Shim } from '../../../src/games/win32Shim';
import { loadPe } from '../../../src/vm86/pe';
import { makeWin32ImportStub, type VmFrame } from '../../../src/vm86/win32';
import { RGB565_TO_RGBA32 } from '../../../src/vm86/pixels';
import { REPO_ROOT, resolveGameDir } from './gameDir';
import { InstallationFiles, silentAudio } from './installationFiles';
import { patchSessionIni, sessionIniName } from './sessionIni';
import type { VmSmokeOptions } from './runVmSmoke';

/** Observe and interact with the production session; never create launcher state in the test. */
export async function runProductionVmSmoke(options: VmSmokeOptions): Promise<void> {
  const GAME_ID = options.gameId;
  const original = options.gameDefinition ?? supportedGame(GAME_ID);
  if (original.id !== GAME_ID) throw new Error('Smoke game definition does not match requested game');
  const files = new InstallationFiles(resolveGameDir(GAME_ID), true);
  const exe = options.executablePath
    ? new Uint8Array(readFileSync(options.executablePath))
    : await files.read(original.executable);
  if (!exe) throw new Error(`Missing executable: ${original.executable}`);
  await files.write(original.executable, exe);
  for (const [path, bytes] of options.guestFiles ?? []) await files.write(path, bytes.slice());
  if (options.ini) {
    const name = sessionIniName(GAME_ID);
    await files.write(name, patchSessionIni((await files.read(name)) ?? new Uint8Array(), options.ini));
  }
  // Retain the old PE identity assertions independently of the production loader.
  const image = loadPe(
    new Uint8Array(16 * 1024 * 1024),
    exe,
    (() => {
      let next = 0x80000;
      return (size: number) => {
        const address = next;
        next = (next + size + 15) & ~15;
        return address;
      };
    })(),
    original.argBytes,
    makeWin32ImportStub,
  );
  if (original.smokeEntry !== undefined && image.entry !== original.smokeEntry) throw new Error('Unexpected PE entry');
  const imports = image.importList.filter((entry) => !(GAME_ID === 'ra2' && entry.key === 'XWIS.DLL!ord1')).length;
  if (original.smokeImports !== undefined && imports !== original.smokeImports)
    throw new Error('Unexpected PE imports');

  const baseHooks = original.runtimeHooks;
  const GAME = {
    ...original,
    guestMemoryBytes: options.memoryBytes ?? original.guestMemoryBytes,
    // Explicit probes still use VmCore's reserved startup allocator, after native initialization.
    ...(options.prepareGuest
      ? {
          runtimeHooks: {
            ...baseHooks,
            resolve: (memory: V86, bytes: Uint8Array) => {
              const resolved = baseHooks?.resolve?.(memory, bytes) ?? baseHooks;
              return {
                ...resolved,
                prepareStartupPage: (vm: V86, _page: string, reserve: (size: number) => number) => {
                  if (options.startupPage) {
                    if (!resolved?.prepareStartupPage) throw new Error('Unsupported startup navigation');
                    resolved.prepareStartupPage(vm, options.startupPage, reserve);
                  }
                  options.prepareGuest!(vm, bytes, reserve);
                },
              };
            },
          },
        }
      : {}),
  };
  let shim!: Win32Shim;
  let emulator!: V86;
  let status: VmStatus | undefined;
  let frames = 0;
  let lastFrame: VmFrame | undefined;
  let calls = 0;
  let first = '';
  const callCounts = new Map<string, number>();
  const dpSeen = { created: 0, hosting: false, joined: false, players: 0 };
  const observeDplay = () => {
    if (!process.env.VM_DP_PROBE || !shim) return;
    const state = shim.inspectDplayState();
    dpSeen.created = Math.max(dpSeen.created, state.created);
    dpSeen.hosting ||= state.session?.hosting === true;
    dpSeen.joined ||= state.session?.hosting === false;
    dpSeen.players = Math.max(dpSeen.players, state.players.length);
  };
  let reachedMainLoop = false;
  let complete = false;
  let inputPhase = 0;
  let inputIndex = 0;
  let clickGap = 0;
  let keyIndex = 0;
  let keyDownPosted = false;
  let keyUpPosted = false;
  let charPosted = false;
  let dragPosted = false;
  const dispatchedInput: number[] = [];
  const dispatchedKey: number[] = [];
  const hoverOnly = options.hoverOnly === true;
  const finalHoverOnly = options.finalHoverOnly === true;
  const inputPoints = (options.clicks ?? [[1, 1]]).map(
    ([x, y]) => [Math.max(-0x8000, Math.min(0x7fff, x! | 0)), Math.max(-0x8000, Math.min(0x7fff, y! | 0))] as const,
  );
  if (!inputPoints.length) throw new Error('Empty input route');
  const inputDispatchBases: number[] = [];
  let expectedInputDispatches = 0;
  for (let index = 0; index < inputPoints.length; index++) {
    inputDispatchBases.push(expectedInputDispatches);
    expectedInputDispatches +=
      hoverOnly || (finalHoverOnly && index === inputPoints.length - 1) ? 1 : options.dragTargets?.[index] ? 4 : 3;
  }
  const clickGapMessages = Math.max(0, options.clickGapMessages ?? 12);
  const clickGaps = (options.clickGaps ?? []).map((value) => Math.max(0, value | 0));
  const clickPageTitles = (options.clickPageTitles ?? []).map((value) => value.trim().toLowerCase());
  const targetCalls = Math.max(0, options.targetCalls ?? 0);
  const batchPointerClick = options.batchPointerClick === true;
  const waitMenuReady = options.waitMenuReady ?? GAME.menuReadyGate === true;
  const firstClickAfter = Date.now() + Math.max(0, options.firstClickAfterMs ?? 0);
  const keySequence = [...(options.keys ?? [])];
  const keysAfterCalls = Math.max(0, options.keysAfterCalls ?? 0);
  let settleMessages = Math.max(0, options.settleMessages ?? 0);
  const configuration = gameVmConfiguration(GAME);
  const core = new VmCore(
    {
      onStatus: (value) => {
        status = value;
      },
      onFrame: (frame) => {
        frames++;
        lastFrame = frame;
      },
      onCall: ({ imported, args }, ordinal) => {
        // VmCore forwards only the game process here; parent calls cannot satisfy smoke assertions.
        calls = ordinal;
        callCounts.set(imported.key, (callCounts.get(imported.key) ?? 0) + 1);
        observeDplay();
        if (complete) return;
        if (!first) first = imported.key;
        if (process.env.VM_TRACE) console.log(calls, imported.key);
        if (
          options.completeAtTargetCalls &&
          targetCalls &&
          calls >= targetCalls &&
          (options.readyToFinish?.(shim, emulator) ?? true)
        ) {
          complete = true;
          return;
        }
        if (imported.key === 'USER32.DLL!GetMessageA' || imported.key === 'USER32.DLL!PeekMessageA') {
          reachedMainLoop = true;
          const [currentX, currentY] = inputPoints[inputIndex]!;
          const pointHoverOnly = hoverOnly || (finalHoverOnly && inputIndex === inputPoints.length - 1);
          const point = (currentY << 16) | currentX;
          const drag = options.dragTargets?.[inputIndex];
          const releasePoint = drag ? (drag[1] << 16) | drag[0] : point;
          const shellPageTitle = shim.inspectShellPageTitle().toLowerCase();
          const expectedPageTitle = clickPageTitles[inputIndex] ?? '';
          // RA2 enters PeekMessage early, so a running message pump does not imply menu readiness.
          // Inject the first click only after the GUI:MainMenu title control is actually created from the dialog template.
          // Main-menu buttons then exist too, allowing hit testing to find a Button rather than the top-level window.
          const ra2FirstMenuReady =
            GAME_ID !== 'ra2' ||
            inputIndex > 0 ||
            options.clickPageTitles?.[inputIndex] === '' ||
            shellPageTitle.includes(expectedPageTitle || 'mainmenu');
          const expectedShellPageReady = !expectedPageTitle || shellPageTitle.includes(expectedPageTitle);
          if (inputPhase === 0 && clickGap > 0) {
            clickGap--;
          } else if (inputPhase === 0 && Date.now() < firstClickAfter) {
            // Wall-clock gate: do not click during the startup cutscene.
          } else if (
            inputPhase === 0 &&
            ra2FirstMenuReady &&
            (options.readyForInput?.(shim, emulator) ?? true) &&
            expectedShellPageReady &&
            ((GAME_ID !== 'ra2' && inputIndex === inputPoints.length - 1) ||
              ((readU32(emulator, 0x004a_c0a8) & 0xff) === 6 && readU32(emulator, 0x004a_84f4) > 0) ||
              !waitMenuReady ||
              readU32(emulator, 0x004a_f1a4) >= 25)
          ) {
            // Pre-click frame dump for screen-transition detection (title -> menu, etc.) and comparison with the final frame.
            if (process.env.VM_FRAME_PPM_BEFORE && inputIndex === 0 && lastFrame) {
              writePpm(process.env.VM_FRAME_PPM_BEFORE, lastFrame);
            }
            shim.setCursorPosition(currentX, currentY);
            shim.postMessage(0x0200, 0, point); // WM_MOUSEMOVE
            if (batchPointerClick && !pointHoverOnly && !drag) {
              // Browsers do not wait for WndProc to return before producing pointerup. The original game may enter a
              // modal message pump inside WM_LBUTTONDOWN, so enqueue the release in advance.
              shim.setKeyState(0x01, true);
              shim.postMessage(0x0201, 0x0001, point); // WM_LBUTTONDOWN
              shim.setKeyState(0x01, false);
              shim.postMessage(0x0202, 0, point); // WM_LBUTTONUP
              inputPhase = 3;
            } else {
              inputPhase = 1;
            }
          } else if (
            inputPhase === 1 &&
            pointHoverOnly &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 1 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 1)
          ) {
            if (
              (!targetCalls || calls >= targetCalls) &&
              settleMessages-- <= 0 &&
              (options.readyToFinish?.(shim, emulator) ?? true)
            ) {
              complete = true;
              return;
            }
          } else if (
            inputPhase === 1 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 1 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 1)
          ) {
            shim.setKeyState(0x01, true);
            shim.postMessage(0x0201, 0x0001, point); // WM_LBUTTONDOWN
            inputPhase = 2;
          } else if (
            inputPhase === 2 &&
            drag &&
            !dragPosted &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + 2 ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + 2)
          ) {
            shim.setCursorPosition(drag[0], drag[1]);
            shim.postMessage(0x0200, 1, releasePoint);
            dragPosted = true;
          } else if (
            inputPhase === 2 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + (drag ? 3 : 2) ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + (drag ? 3 : 2))
          ) {
            shim.setKeyState(0x01, false);
            // Closing a popup on press consumes the release; that input is complete and must not wait for another guest dispatch.
            if (shim.postMessage(0x0202, 0, releasePoint) === false) dispatchedInput.push(0x0202);
            inputPhase = 3;
          } else if (
            inputPhase === 3 &&
            (dispatchedInput.length >= inputDispatchBases[inputIndex]! + (drag ? 4 : 3) ||
              shim.getHostInputDispatchCount() >= inputDispatchBases[inputIndex]! + (drag ? 4 : 3))
          ) {
            if (inputIndex + 1 < inputPoints.length) {
              inputIndex++;
              dragPosted = false;
              inputPhase = 0;
              clickGap = clickGaps[inputIndex] ?? clickGapMessages;
            } else if (keyIndex < keySequence.length) {
              // After the click route finishes, inject keys in sequence (VM_KEYS is a list of VK codes).
              inputPhase = 4;
            } else if (
              (!targetCalls || calls >= targetCalls) &&
              settleMessages-- <= 0 &&
              (options.readyToFinish?.(shim, emulator) ?? true)
            ) {
              complete = true;
              return;
            }
          } else if (inputPhase === 4 && calls >= keysAfterCalls) {
            // Key injection sends DOWN/CHAR/UP only once each; several GetMessageA ticks may occur before observed dispatch,
            // so unguarded injection would queue duplicates. Add WM_CHAR for printable ASCII keys because game text fields
            // may consume only TranslateMessage output; real key CHAR messages are generated by TranslateMessage in the loop.
            const vk = keySequence[keyIndex]!;
            const printable = vk >= 0x20 && vk <= 0x7e;
            const lastDispatched = dispatchedKey.at(-1);
            if (lastDispatched === 0x0100) {
              if (printable && !charPosted) {
                shim.postMessage(0x0102, vk, 0x001c_0001); // WM_CHAR
                charPosted = true;
              } else if (!keyUpPosted) {
                shim.postMessage(0x0101, 0, 0xc000_0001); // WM_KEYUP
                keyUpPosted = true;
              }
            } else if (lastDispatched === 0x0102) {
              if (!keyUpPosted) {
                shim.postMessage(0x0101, 0, 0xc000_0001); // WM_KEYUP
                keyUpPosted = true;
              }
            } else if (!keyDownPosted) {
              shim.postMessage(0x0100, vk, 0x001c_0001); // WM_KEYDOWN
              keyDownPosted = true;
            }
            if (dispatchedKey.length >= 2 && dispatchedKey.at(-1) === 0x0101) {
              dispatchedKey.length = 0;
              keyIndex++;
              inputPhase = 3;
              keyDownPosted = false;
              keyUpPosted = false;
              charPosted = false;
            }
          }
        }
        if (imported.key === 'USER32.DLL!DispatchMessageA' && args[0]) {
          const message = readU32(emulator, args[0] + 4);
          if (message >= 0x0200 && message <= 0x0202) dispatchedInput.push(message);
          if (message === 0x0100 || message === 0x0101 || message === 0x0102) dispatchedKey.push(message);
        }
      },
    },
    { game: GAME, files, executableBytes: exe },
    {
      ...configuration,
      startupPage: options.prepareGuest ? 'smoke-probe' : options.startupPage,
      fetchBytes: async () => {
        const bios = new Uint8Array(readFileSync(join(REPO_ROOT, 'src/vm86/boot.bin')));
        if (bios.length !== 0x10000) throw new Error('boot.bin must be 64 KiB');
        return bios;
      },
      scheduleFrame: (emit) => setImmediate(emit),
      deferFrameSnapshot: true,
      packedRgb565Frames: process.env.VM_PACKED_FRAMES === '1',
      fastFileRead: options.enableFastRead !== false,
      audio: silentAudio,
      createEmulator: (config) =>
        new V86({
          ...config,
          wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm'),
          disable_jit: process.env.VM_DISABLE_JIT === '1',
        }),
      createShim: (memory, config, hooks) => {
        const instance = configuration.createShim(memory, config, hooks);
        if (config?.moduleName === GAME.executable) {
          shim = instance;
          emulator = memory;
        }
        return instance;
      },
    },
  );
  core.setGameClockRate(options.clockRate ?? 1);
  const deadline = Date.now() + Math.max(1000, options.timeoutMs ?? 60000);
  const assertRunning = () => {
    if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
  };
  try {
    await core.start();
    while (!complete && Date.now() < deadline) {
      assertRunning();
      await delay(10);
    }
    assertRunning();
    if (!complete)
      throw new Error(
        `Smoke timeout: page=${shim?.inspectShellPageTitle()}, input=${inputIndex}/${inputPhase}, calls=${calls}`,
      );
    if (!reachedMainLoop && !options.completeAtTargetCalls) throw new Error('Main message loop was not reached');
    if (GAME.smokeFirstCall && first !== GAME.smokeFirstCall) throw new Error(`Unexpected first API: ${first}`);
    if (calls < (GAME_ID === 'ra2' || GAME_ID === 'yr' ? 4000 : 10000))
      throw new Error(`Call trace too short: ${calls}`);
    if (
      !options.skipFrameCheck &&
      (!frames || (GAME_ID !== 'ra2' && GAME_ID !== 'yr' && (lastFrame?.width !== 800 || lastFrame?.height !== 600)))
    ) {
      throw new Error('Missing or unexpected primary surface frame');
    }
    const expectedInput = inputPoints.flatMap((_point, index) =>
      hoverOnly || (finalHoverOnly && index === inputPoints.length - 1)
        ? [0x200]
        : options.dragTargets?.[index]
          ? [0x200, 0x201, 0x200, 0x202]
          : [0x200, 0x201, 0x202],
    );
    if (
      !options.completeAtTargetCalls &&
      !keySequence.length &&
      !process.env.VM_DP_PROBE &&
      dispatchedInput.join(',') !== expectedInput.join(',') &&
      shim.getHostInputDispatchCount() < expectedInputDispatches
    ) {
      throw new Error(`Guest input round trip incomplete: ${dispatchedInput.join(',')}`);
    }
    if (
      GAME_ID === 'ra2' &&
      (shim.inspectGuestThreads().length < 4 || (callCounts.get('KERNEL32.DLL!CreateThread') ?? 0) < 3)
    ) {
      throw new Error('RA2 guest threads did not complete startup');
    }
    if (process.env.VM_DP_PROBE && process.env.VM_DP_EXPECT) {
      const expected = process.env.VM_DP_EXPECT;
      const matched =
        (expected === 'created' && dpSeen.created > 0) ||
        (expected === 'hosting' && dpSeen.hosting) ||
        (expected === 'join' && dpSeen.joined) ||
        (expected === 'players2' && dpSeen.players >= 2);
      if (!matched) throw new Error(`DPlay expectation was not reached: ${expected}`);
    }
    options.assertFinalState?.(shim, emulator);
    if (options.assertFinalFrame) {
      if (!lastFrame) throw new Error('No final frame');
      options.assertFinalFrame(lastFrame);
    }
    if (process.env.VM_FRAME_PPM && lastFrame) writePpm(process.env.VM_FRAME_PPM, lastFrame);
  } finally {
    // VmCore owns both VMs, timers, audio and file flushes, including assertion/timeout failures.
    await core.destroy();
  }
}

function readU32(memory: V86, address: number): number {
  const bytes = memory.read_memory(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

function writePpm(path: string, frame: VmFrame): void {
  const pixels = Buffer.alloc(frame.width * frame.height * 3);
  for (let i = 0; i < frame.width * frame.height; i++) {
    if (frame.rgba) {
      pixels.set(frame.rgba.subarray(i * 4, i * 4 + 3), i * 3);
    } else {
      const color = frame.rgb565 ? RGB565_TO_RGBA32[frame.rgb565[i]!]! : frame.palette[frame.pixels[i]!]!;
      pixels[i * 3] = color & 255;
      pixels[i * 3 + 1] = (color >>> 8) & 255;
      pixels[i * 3 + 2] = (color >>> 16) & 255;
    }
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${frame.width} ${frame.height}\n255\n`), pixels]));
}
