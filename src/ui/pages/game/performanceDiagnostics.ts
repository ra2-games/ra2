import { capturePerformance } from '../../../adapter/capturePerformance';
import { FrameTimingProbe } from '../../../platform/browser/frameTimingProbe';
import type { VmShell } from '../../../adapter/vmShell';
import type { FramePresenter } from '../../../graphics/framePresenter';
import type { VmFrameRenderer } from './vmFrameRenderer';
import type { ToolbarModel } from './components/RuntimeToolbarView';

/** Build a shareable report from explicit fields; never include URLs, resource bytes, saves, or player names. */
export async function collectPerformanceReport(options: {
  vm: VmShell;
  canvas: HTMLCanvasElement;
  presenter: FramePresenter;
  renderer: VmFrameRenderer;
  gameId: string | null;
  sourceKind: string | null;
  signal: AbortSignal;
  progress: (remainingSeconds: number) => void;
  settings: () => Pick<ToolbarModel, 'rate' | 'resolution' | 'upscaleMode' | 'reshadeMode'>;
}) {
  const { canvas, presenter, renderer } = options;
  const display = new FrameTimingProbe();
  const stopDisplay = () => display.destroy();
  options.signal.addEventListener('abort', stopDisplay, { once: true });
  const startedAt = new Date().toISOString();
  try {
    const capture = await capturePerformance(options.vm, {
      signal: options.signal,
      progress: options.progress,
      sampleHost: () => ({
        ...display.sample(),
        submittedFrames: presenter.frameVersion,
        presentedFrames: presenter.presentedFrames,
        frame: presenter.frame ? { width: presenter.frame.width, height: presenter.frame.height } : null,
        canvas: { width: canvas.width, height: canvas.height },
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        settings: options.settings(),
      }),
    });
    const first = capture.samples[0];
    const last = capture.samples.at(-1);
    const native = capture.samples.flatMap(({ vm }) =>
      vm.game?.status === 'sample' && vm.game.intervalMs! > 0 ? [vm.game] : [],
    );
    const nativeMs = native.reduce((sum, sample) => sum + sample.intervalMs!, 0);
    const displayMs = first && last ? last.host.elapsedMs - first.host.elapsedMs : 0;
    const vmMs = first && last ? last.vm.sampledAtMs - first.vm.sampledAtMs : 0;
    return JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        environment: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          crossOriginIsolated: globalThis.crossOriginIsolated,
          secureContext: globalThis.isSecureContext,
          build: import.meta.env.DEV ? 'development' : 'production',
        },
        gameId: options.gameId,
        sourceKind: options.sourceKind,
        renderer: { backend: renderer.backend, detail: renderer.detail },
        summary: {
          nativeLogicFps: nativeMs
            ? native.reduce((sum, sample) => sum + sample.logicFps! * sample.intervalMs!, 0) / nativeMs
            : null,
          nativeSampleCount: native.length,
          nativeZeroProgressWindows: native.filter((sample) => sample.logicFps === 0 && sample.intervalMs! >= 500)
            .length,
          nativeResetCount: capture.samples.filter(({ vm }) => vm.game?.status === 'reset').length,
          submittedFps:
            displayMs > 0 ? ((last!.host.submittedFrames - first!.host.submittedFrames) * 1000) / displayMs : null,
          presentedFps:
            displayMs > 0 ? ((last!.host.presentedFrames - first!.host.presentedFrames) * 1000) / displayMs : null,
          rafFps: displayMs > 0 ? ((last!.host.rafCount - first!.host.rafCount) * 1000) / displayMs : null,
          hypercallsPerSecond: vmMs > 0 ? ((last!.vm.hypercalls - first!.vm.hypercalls) * 1000) / vmMs : null,
          foregroundOnly: last?.host.visibility.every((entry) => entry.state === 'visible') ?? null,
        },
        ...capture,
        notes: [
          'Opt-in instrumented capture; CPU slice time is not whole-device or whole-Worker CPU usage.',
          'VM timestamps use the execution thread clock; requestMs includes RPC latency and probe work.',
          'Native game.logicFps measures simulation; submitted/presented/rAF counts measure separate display stages.',
          'Timing aggregates are cumulative within this capture. Null means unavailable, not zero.',
        ],
      },
      null,
      2,
    );
  } finally {
    options.signal.removeEventListener('abort', stopDisplay);
    display.destroy();
  }
}
