import { t } from '../../shared/i18n/translate';
import type { LiveModelId } from './experiments/modelProbe';
import { FrameEffectController } from '../../../app/session/frameEffectController';
import {
  bootState,
  debugState,
  debugVisible,
  helpVisible,
  mainPanel,
  resourceStatus,
  networkStatus,
  upscaleStatus,
  selectGameFiles,
  cancelSourceRequest,
  mapRequest,
  gameRunning,
  groupVisible,
} from './state/uiState';
import { createVmShell, type VmShell } from '../../../adapter/runtime';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import { DEFAULT_MASTER_VOLUME } from '../../../adapter/audio';
import type { Win32Call } from '../../../vm86/win32';
import type { SupportedGameId } from '../../../games/catalog';
import { installAdaptiveTouchControls } from './touchControls';
import { installWakeLock } from './wakeLock';
import { createVmFrameRenderer } from './vmFrameRenderer';
import { aiUpscaleEnabled, fsrUpscaleMode, scalefxUpscaleEnabled, spatialUpscaleEnabled } from './spatialUpscale';
import { installCanvasFit, installGameInput, toggleImmersiveFullscreen } from './gameInput';
import { installRuntimeToolbar } from './runtimeToolbar';
import { restoreCachedGameSource } from './gameSourcePicker';
import { progressiveFilesOf } from '../../../adapter/progressiveFiles';
import { VmSessionController, guardVmCallbacks } from '../../../app/session/vmSessionController';
import { startSessionRuntime } from '../../../app/session/startSessionRuntime';
import { FramePresenter } from '../../../graphics/framePresenter';
import { forgetGameDirectory } from '../../../platform/browser/files/directoryAccess';
import { type GameSource } from '../../../games/source';
import { clearCachedGameFiles, loadCustomMapFiles } from '../../../adapter/cachedGameFiles';
import { createVmRuntimeCallbacks } from './vmPageRuntimeCallbacks';
import { createVmPageToolbarActions } from './vmPageToolbarActions';
import { loadStoredResolution } from './vmPageResolution';
import type { GameResolution } from '../../../games/resolution';

let activeVm: VmShell | null = null;
const pageController = new VmSessionController();
let activeKeyHandler: ((event: KeyboardEvent) => void) | null = null;
let activeInputCleanup: (() => void) | null = null;
let activeToolbarCleanup: (() => void) | null = null;
let activeResourceCleanup: (() => void) | null = null;
let activeNetworkCleanup: (() => void) | null = null;
let pageGeneration = 0;
let activeRendererCleanup: (() => void) | null = null;

// Actual frames update guest logical coordinates; 800x600 is only a compatibility default before the first frame.
let gameFrameWidth = 800;
let gameFrameHeight = 600;
let refitActiveCanvas: (frameWidth?: number, frameHeight?: number) => void = () => {};
let canvasFitInstalled = false;
let activeFitCleanup: (() => void) | null = null;

export async function startVmPage(canvas: HTMLCanvasElement): Promise<void> {
  const generation = ++pageGeneration;
  // Release the old presentation and size listeners before switching sessions so resize callbacks cannot retain prior closures.
  activeRendererCleanup?.();
  activeRendererCleanup = null;
  activeFitCleanup?.();
  activeFitCleanup = null;
  canvasFitInstalled = false;
  await pageController.destroy();
  if (generation !== pageGeneration) return;
  activeVm = null;
  if (!canvasFitInstalled) {
    canvasFitInstalled = true;
    // Backing-store resets clear the bitmap; force an immediate redraw after resizing or sparse-frame scenes such as menus
    // remain blank until the next frame, appearing broken. This callback runs only on resize,
    // after the let declarations below initialize; capturing TDZ variables is safe because they are not accessed early.
    const fit = installCanvasFit(
      canvas,
      () => ({ width: gameFrameWidth, height: gameFrameHeight }),
      () => {
        presenter.invalidate();
      },
    );
    refitActiveCanvas = fit;
    activeFitCleanup = fit.destroy;
  }
  // By default WebGL2 shaders expand 8-bit indexed frames; ?webgl=0 forces Canvas 2D
  // for comparison when hardware acceleration is unavailable or specific browsers fall back.
  const frameRenderer = createVmFrameRenderer(
    canvas,
    new URLSearchParams(window.location.search).get('webgl') !== '0',
    spatialUpscaleEnabled(window.location.search),
    fsrUpscaleMode(window.location.search),
    scalefxUpscaleEnabled(window.location.search),
    aiUpscaleEnabled(window.location.search),
    new URLSearchParams(window.location.search).get('sr-model') === 'fast' ? 'fast' : 'gan',
  );
  const calls: string[] = [];
  /** Cumulative calls per Win32 API; the backtick panel shows top hotspots for performance diagnosis. */
  const callHistogram = new Map<string, number>();
  // The probe runs from onCall, i.e. once per hypercall (tens of thousands per second in battle). Rebuilding three
  // JSON strings each time cost more CPU than the entire Win32 shim in a profile; readers poll these datasets, so
  // coalescing to 100ms keeps them fresh enough while removing the per-call cost.
  let lastRuntimeCallProbe = 0;
  const exposeRuntimeCallProbe = () => {
    if (!debugAutoOpen) return;
    const now = performance.now();
    if (now - lastRuntimeCallProbe < 100) return;
    lastRuntimeCallProbe = now;
    canvas.dataset.vmBinkCalls = JSON.stringify(
      Object.fromEntries([...callHistogram].filter(([key]) => key.startsWith('BINKW32.DLL!'))),
    );
    canvas.dataset.vmAudioCalls = JSON.stringify(
      Object.fromEntries(
        [...callHistogram].filter(([key]) => key.startsWith('DSOUND.COM!') || key.startsWith('WINMM.DLL!waveOut')),
      ),
    );
    canvas.dataset.vmTextOutCalls = String(callHistogram.get('GDI32.DLL!TextOutA') ?? 0);
  };
  // Do not create the debug panel or collect samples by default: DOM updates and guest-memory sampling cost time, and the panel obscures gameplay.
  // ?debug=1 opens it at startup; otherwise the first backtick creates it lazily, and later presses toggle visibility.
  const debugAutoOpen = new URLSearchParams(window.location.search).get('debug') === '1';
  let status: VmStatus = { phase: 'loading', detail: t('初始化…') };
  let callCount = 0;
  let lastPointerProbeAt = 0;
  let pointerProbeSeq = 0;
  let requestedClockRate = 1;
  // Default gain and initial toolbar slider values share one source: DEFAULT_VOLUME_PERCENT derives from DEFAULT_MASTER_VOLUME,
  // avoiding separate literals in page, toolbar, and Worker configuration.
  let requestedVolume = DEFAULT_MASTER_VOLUME;
  let performanceLine = t('HC --/s · 主线程阻塞 --');
  let schedulePerformanceRender = () => {};
  let exitHandled = false;
  let vm: VmShell | null = null;
  let adaptInputResolution: ((width: number, height: number) => void) | null = null;
  let gameSource: GameSource | null = null;
  let selectedGameId: SupportedGameId | null = null;
  let requestedResolution: GameResolution | null = null;
  let changeGameSource = async () => {
    await forgetGameDirectory();
    window.location.reload();
  };
  let restartForResolution = async () => {
    window.location.reload();
  };
  const presenter: FramePresenter = new FramePresenter(frameRenderer, {
    targetSize: () => ({ width: canvas.width, height: canvas.height }),
    transform: (frame) => effects.transform(frame),
    presented: () => {
      effects.publishStatus(frameRenderer.upscaleStatus);
      toolbar.recordPresentedFrame();
    },
    tick: () => renderDebug(),
  });
  const effects: FrameEffectController<LiveModelId> = new FrameEffectController<LiveModelId>({
    create: import.meta.env.DEV
      ? async (changed) => {
          const { LiveModel } = await import('./experiments/liveModel');
          return new LiveModel(changed);
        }
      : async () => {
          throw new Error(t('生产模式不开放模型实验'));
        },
    currentFrame: () => presenter.frame,
    isCurrent: () => generation === pageGeneration && !exitHandled,
    invalidate: () => presenter.invalidate(),
    beforeLoad: () => {
      // The enhancement model already upscaled by its native factor; do not stack CNN/GAN in the display stage.
      frameRenderer.setUpscaleMode('off');
      toolbar.setUpscaleMode('off');
    },
    publish: (value) => upscaleStatus.set(value),
  });
  const scheduleRender = () => presenter.schedule();
  activeToolbarCleanup?.();
  const toolbar = installRuntimeToolbar(
    createVmPageToolbarActions({
      canvas,
      debugAutoOpen,
      presenter,
      effects,
      frameRenderer,
      getToolbar: () => toolbar,
      getVm: () => vm,
      getStatus: () => status,
      getExitHandled: () => exitHandled,
      getSelectedGameId: () => selectedGameId,
      getGameSource: () => gameSource,
      setRequestedClockRate: (rate) => {
        requestedClockRate = rate;
      },
      setRequestedResolution: (resolution) => {
        requestedResolution = resolution;
      },
      setRequestedVolume: (linear) => {
        requestedVolume = linear;
      },
      setPerformanceLine: (summary) => {
        performanceLine = summary;
      },
      onRestartForResolution: () => restartForResolution(),
      onChangeGameSource: () => changeGameSource(),
      onSchedulePerformanceRender: () => schedulePerformanceRender(),
    }),
    canvas,
    frameRenderer.backend,
    frameRenderer.detail,
  );
  upscaleStatus.set(frameRenderer.upscaleStatus);
  toolbar.setUpscaleMode(frameRenderer.upscaleMode);
  activeToolbarCleanup = () => {
    toolbar.destroy();
    upscaleStatus.set(null);
  };

  let panelCreated = false;
  // The as assertion prevents TS narrowing a variable assigned only inside closures to null, then never after a null check.
  let gameTitle = 'Red Alert 2';
  let lastDebugUpdate = 0;
  const renderDebug = () => {
    if (!panelCreated || !debugVisible.getSnapshot() || performance.now() - lastDebugUpdate < 200) return;
    lastDebugUpdate = performance.now();
    debugState.set({
      title: gameTitle,
      phase: status.phase,
      calls: callCount,
      performance: performanceLine,
      detail: status.detail,
      hot: [...callHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      trace: calls.join('\n'),
      getVm: () => vm,
    });
  };
  const ensureDebugPanel = () => {
    if (panelCreated) return;
    panelCreated = true;
    vm?.setCallTracing(true);
    lastDebugUpdate = 0;
  };
  const toggleShortcutHelp = () => helpVisible.set(!helpVisible.getSnapshot());

  if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
  activeKeyHandler = (event) => {
    if (event.key === '`') {
      event.preventDefault();
      ensureDebugPanel();
      debugVisible.set(!debugVisible.getSnapshot());
      return;
    }
    // Player shortcuts: ignore while input controls are focused and do nothing before VM startup.
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (!vm) return;
    if (event.key === 'F11') {
      event.preventDefault();
      void toggleImmersiveFullscreen(canvas);
      return;
    }
    if (event.key === '[' || event.key === ']') {
      // Slower/faster clock multipliers: 1x -> 2x -> 4x with clamped endpoints; reserve number keys for native game hotkeys.
      const rates = [1, 2, 4];
      const index = rates.indexOf(requestedClockRate);
      const next = event.key === ']' ? rates[Math.min(index + 1, rates.length - 1)]! : rates[Math.max(index - 1, 0)]!;
      if (next !== requestedClockRate) toolbar.pressClockRate(next);
      event.preventDefault();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      toggleShortcutHelp();
    }
  };
  window.addEventListener('keydown', activeKeyHandler);
  if (debugAutoOpen) {
    // ?debug=1 is explicit: open even in production or on touch devices; backtick still toggles it.
    ensureDebugPanel();
    debugVisible.set(true);
  } else {
    // Without ?debug=1, keep the panel and collection inactive, with no overhead or obstruction of the game.
    debugVisible.set(false);
  }

  schedulePerformanceRender = scheduleRender;

  const refreshPointerProbe = () => {
    if (!debugAutoOpen || !vm) return;
    const seq = ++pointerProbeSeq;
    void vm.getPointerState().then(
      (state) => {
        if (seq !== pointerProbeSeq || !state) return;
        canvas.dataset.vmWorkerCursor = `${state.x},${state.y}/${state.width}x${state.height}`;
        canvas.dataset.vmWorkerClient = `${state.clientWidth}x${state.clientHeight}`;
        canvas.dataset.vmWorkerKey = `0x${state.lastKeyMessage.toString(16)}:${state.lastKeyVirtualKey}`;
        canvas.dataset.vmWorkerMouse =
          `0x${state.lastMouseMessage.toString(16)}:0x${state.lastMouseHwnd.toString(16)}:` +
          `${state.lastMouseControlId}:0x${state.lastMouseCallback.toString(16)}`;
        canvas.dataset.vmWorkerDispatch =
          `0x${state.lastMouseDispatchHwnd.toString(16)}:${state.lastMouseDispatchControlId}:` +
          `0x${state.lastMouseDispatchCallback.toString(16)}`;
        canvas.dataset.vmCampaignHoverDispatches = `${state.campaignHoverDispatches}`;
      },
      () => {
        /* Debug-probe failures must not affect input. */
      },
    );
  };

  const presentHostCursor = (x: number, y: number, visible: boolean) => {
    if (debugAutoOpen) {
      canvas.dataset.vmCursor = `${x},${y}/${gameFrameWidth}x${gameFrameHeight}`;
      const now = performance.now();
      if (vm && now - lastPointerProbeAt >= 100) {
        lastPointerProbeAt = now;
        refreshPointerProbe();
      }
    }
    presenter.presentCursor(x, y, visible);
  };

  activeRendererCleanup = () => {
    effects.stop();
    presenter.destroy();
  };
  presenter.render();
  // Restore and start directly from the last persisted complete import without showing the picker;
  // missing/incomplete caches, such as quota-reduced sets, return to the picker.
  const cachedSource = await restoreCachedGameSource().catch(() => null);
  if (generation !== pageGeneration) return;
  gameSource = cachedSource ?? (await selectGameFiles());
  if (generation !== pageGeneration) {
    progressiveFilesOf(gameSource.files)?.cancel();
    return;
  }
  activeResourceCleanup?.();
  const progressive = progressiveFilesOf(gameSource.files);
  if (progressive) {
    const indicator = resourceStatus;
    const unsubscribe = progressive.subscribe((status) =>
      indicator.set({
        phase: status.phase,
        text:
          status.phase === 'loading'
            ? t('启动层已就绪 · 其他资源 {0}/{1}：{2}', status.loaded, status.total, status.detail)
            : status.detail,
      }),
    );
    activeResourceCleanup = () => {
      unsubscribe();
      indicator.set(null);
      progressive.cancel();
    };
  } else activeResourceCleanup = null;
  // Base-game caches and add-ons are independent; development HTTP and restored caches share the same startup mount path.
  gameSource.additionalFiles = await loadCustomMapFiles(gameSource.game.id).catch((error) => {
    console.warn(t('[自定义地图] 无法读取已保存的附加包'), error);
    return new Map<string, Uint8Array>();
  });
  if (generation !== pageGeneration) return;
  gameTitle = gameSource.game.executable;
  activeNetworkCleanup?.();
  const networkIndicator = networkStatus;
  activeNetworkCleanup = () => networkIndicator.set(null);
  selectedGameId = gameSource.game.id;
  requestedResolution = loadStoredResolution(selectedGameId);
  toolbar.setResolution(requestedResolution);
  toolbar.setGameTitle(gameSource.game.title);
  mainPanel.set(null);

  bootState.set({
    game: gameSource.game,
    status: { phase: 'loading', detail: t('初始化…') },
    cancel: async () => {
      if (exitHandled) return;
      exitHandled = true;
      await releaseRuntime();
      mainPanel.set({ phase: 'exited', detail: t('启动已取消') });
    },
  });
  const hideBootOverlay = () => bootState.set(null);
  let problemPanelShown = false;
  const showProblemPanel = (phase: 'blocked' | 'error', detail: string) => {
    if (problemPanelShown) return;
    problemPanelShown = true;
    hideBootOverlay();
    mainPanel.set({ phase, detail });
  };
  const updateBootOverlay = (next: VmStatus) => {
    if (next.phase === 'blocked' || next.phase === 'error') showProblemPanel(next.phase, next.detail);
    else if (next.phase === 'exited' || next.phase === 'stopped') hideBootOverlay();
    else {
      const boot = bootState.getSnapshot();
      if (boot) bootState.set({ ...boot, status: next });
    }
  };

  const releaseRuntime = async () => {
    effects.stop();
    activeNetworkCleanup?.();
    activeNetworkCleanup = null;
    activeResourceCleanup?.();
    activeResourceCleanup = null;
    if (document.pointerLockElement === canvas) await document.exitPointerLock();
    bootState.set(null);
    helpVisible.set(false);
    activeInputCleanup?.();
    activeInputCleanup = null;
    if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
    activeKeyHandler = null;
    debugVisible.set(false);
    if (activeVm === vm) activeVm = null;
    debugState.set(null);
    await pageController.destroy();
    presenter.destroy();
    activeToolbarCleanup?.();
    activeToolbarCleanup = null;
  };

  restartForResolution = async () => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    window.location.reload();
  };

  const finishExitedRuntime = async (detail: string) => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    mainPanel.set({ phase: 'exited', detail });
  };

  changeGameSource = async () => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    await forgetGameDirectory();
    // Clear persisted file sets so switching sources returns to the picker rather than restoring automatically again.
    await clearCachedGameFiles().catch(() => {});
    window.location.reload();
  };

  const installRuntimeInput = (startedVm: VmShell) => {
    if (activeInputCleanup) activeInputCleanup();
    // Overlay RA2's Win32 hardware cursor as a small independent framebuffer texture; it remains visible after Pointer Lock
    // hides the system cursor and moves without retransmitting the whole frame. At screen edges, clamp the logical
    // cursor to current guest-frame bounds for sustained edge scrolling; ?mouse-lock=0 restores absolute coordinates.
    const mouseLock = new URLSearchParams(window.location.search).get('mouse-lock');
    const lockDesktopMouse = mouseLock === null ? true : mouseLock !== '0';
    const installedInput = installGameInput(canvas, startedVm, lockDesktopMouse, presentHostCursor, () => ({
      width: gameFrameWidth,
      height: gameFrameHeight,
    }));
    const pointerProbeTimer = debugAutoOpen ? window.setInterval(refreshPointerProbe, 250) : null;
    adaptInputResolution = installedInput.adaptResolution;
    const cleanupTouch = installAdaptiveTouchControls(canvas, startedVm);
    const cleanupWake = installWakeLock();
    activeInputCleanup = () => {
      adaptInputResolution = null;
      installedInput.cleanup();
      if (pointerProbeTimer !== null) window.clearInterval(pointerProbeTimer);
      cleanupTouch();
      cleanupWake();
    };
  };

  vm = await startSessionRuntime(
    () =>
      pageController.start(({ isCurrent }) =>
        createVmShell(
          guardVmCallbacks(
            createVmRuntimeCallbacks({
              canvas,
              debugAutoOpen,
              toolbar,
              presenter,
              effects,
              getVm: () => vm,
              getSelectedGameId: () => selectedGameId,
              setStatus: (next) => {
                status = next;
              },
              getCallCount: () => callCount,
              setCallCount: (next) => {
                callCount = next;
              },
              getPanelCreated: () => panelCreated,
              callHistogram,
              calls,
              getGameFrameSize: () => ({ width: gameFrameWidth, height: gameFrameHeight }),
              setGameFrameSize: (width, height) => {
                gameFrameWidth = width;
                gameFrameHeight = height;
              },
              getAdaptInputResolution: () => adaptInputResolution,
              getRefitActiveCanvas: () => refitActiveCanvas,
              onUpdateBootOverlay: updateBootOverlay,
              onScheduleRender: scheduleRender,
              onHideBootOverlay: hideBootOverlay,
              onFinishExited: finishExitedRuntime,
              onExposeRuntimeCallProbe: exposeRuntimeCallProbe,
              onAppendCall: appendCall,
            }),
            isCurrent,
          ),
          gameSource!,
          {
            resolution: requestedResolution,
            startupPage: new URLSearchParams(window.location.search).get('start-page') || undefined,
            recycleFrames: true,
          },
        ),
      ),
    (error, detail) => {
      console.error(t('[VM] 启动失败'), error);
      if (!problemPanelShown) showProblemPanel('error', detail);
    },
    releaseRuntime,
    installRuntimeInput,
  );
  if (!vm) {
    if (!problemPanelShown) presenter.destroy();
    return;
  }
  if (panelCreated) vm.setCallTracing(true);
  vm.setGameClockRate(requestedClockRate);
  vm.setMasterVolume(requestedVolume);
  activeVm = vm;
  toolbar.setMapsAvailable(status.phase === 'running');
  // Overlay RA2's Win32 hardware cursor as a small independent framebuffer texture; it remains visible after Pointer Lock
  // hides the system cursor and moves without retransmitting the whole frame. At screen edges, clamp the logical
  // cursor to current guest-frame bounds for sustained edge scrolling; ?mouse-lock=0 restores absolute coordinates.
  try {
    const debugRoute = readDebugRoute();
    if (debugRoute.length) {
      void playDebugRoute(vm, debugRoute, () => presenter.frame !== null).catch((error) =>
        console.warn(t('[VM] URL debug 路线失败'), error),
      );
    }
  } catch (error) {
    // Runtime already rendered a readable error through onStatus; prevent an unhandled rejection from the dynamic entry point here.
    console.error(t('[VM] 启动失败'), error);
  }
}

function readDebugRoute(): Array<[number, number]> {
  const clicks = new URLSearchParams(window.location.search).get('clicks') ?? '';
  return clicks
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const [x, y] = part.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('无效 debug 路线坐标：{0}', part));
      return [Math.max(0, Math.min(gameFrameWidth - 1, x | 0)), Math.max(0, Math.min(gameFrameHeight - 1, y | 0))];
    });
}

async function playDebugRoute(vm: VmShell, route: Array<[number, number]>, hasFrame: () => boolean): Promise<void> {
  await waitForDebugRouteReady(hasFrame);
  for (const [x, y] of route) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
    const lParam = (y << 16) | x;
    vm.setCursorPosition(x, y);
    vm.postMessage(0x0200, 0, lParam);
    vm.setKeyState(1, true);
    vm.postMessage(0x0201, 1, lParam);
    vm.setKeyState(1, false);
    vm.postMessage(0x0202, 0, lParam);
  }
}

async function waitForDebugRouteReady(hasFrame: () => boolean): Promise<void> {
  const deadline = performance.now() + 30_000;
  let stableFrames = 0;
  while (performance.now() < deadline) {
    const shellPage = (document.getElementById('screen') as HTMLCanvasElement | null)?.dataset.shellPage ?? '';
    const shellReady = shellPage.toLowerCase().includes('mainmenu');
    if (hasFrame() && shellReady) {
      stableFrames++;
      if (stableFrames >= 3) return;
    } else {
      stableFrames = 0;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(t('主菜单尚未就绪，未发送快速进入路线'));
}

/** React unmount and HMR share service destruction; the service layer no longer removes UI nodes. */
export function stopVmPage(): void {
  ++pageGeneration;
  cancelSourceRequest();
  mapRequest.getSnapshot()?.finish(false);
  activeNetworkCleanup?.();
  activeNetworkCleanup = null;
  activeResourceCleanup?.();
  activeResourceCleanup = null;
  activeVm = null;
  if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
  activeKeyHandler = null;
  activeInputCleanup?.();
  activeInputCleanup = null;
  activeToolbarCleanup?.();
  activeToolbarCleanup = null;
  activeRendererCleanup?.();
  activeRendererCleanup = null;
  activeFitCleanup?.();
  activeFitCleanup = null;
  canvasFitInstalled = false;
  bootState.set(null);
  debugState.set(null);
  debugVisible.set(false);
  helpVisible.set(false);
  groupVisible.set(false);
  gameRunning.set(false);
  void pageController.destroy();
}
if (import.meta.hot) import.meta.hot.dispose(stopVmPage);

function appendCall(lines: string[], call: Win32Call, ordinal: number, suffix = ''): void {
  const args = call.args.map((v) => `0x${v.toString(16)}`).join(', ');
  lines.push(`${String(ordinal).padStart(3, '0')}  ${call.imported.key}(${args}) ${suffix}`.trimEnd());
  if (lines.length > 36) lines.splice(0, lines.length - 36);
}
