import type { GamePerformanceSample } from '../../src/games/performance';

/** Windowed FPS distribution, not per-frame timing percentiles; stalled duration counts only complete windows with zero progress. */
export function summarizeGamePerformance(samples: readonly GamePerformanceSample[], warmupMs = 0) {
  if (samples.length < 2) return null;
  const start = samples.findIndex((sample) => sample.sampledAtMs >= samples[0]!.sampledAtMs + warmupMs);
  if (start < 0 || start >= samples.length - 1) return null;
  const windows: { fps: number; durationMs: number; frames: number }[] = [];
  let maxObservedStallMs = 0,
    stall = 0,
    invalidWindows = 0;
  for (let i = start + 1; i < samples.length; i++) {
    const previous = samples[i - 1]!,
      current = samples[i]!;
    const frames = current.frame - previous.frame,
      durationMs = current.sampledAtMs - previous.sampledAtMs;
    if (current.status !== 'sample' || frames < 0 || durationMs <= 0 || !Number.isFinite(durationMs)) {
      invalidWindows++;
      stall = 0;
      continue;
    }
    windows.push({ frames, durationMs, fps: (frames * 1000) / durationMs });
    stall = frames === 0 ? stall + durationMs : 0;
    maxObservedStallMs = Math.max(stall, maxObservedStallMs);
  }
  if (!windows.length) return null;
  const sorted = windows.map((window) => window.fps).sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  const durationMs = windows.reduce((sum, window) => sum + window.durationMs, 0);
  const frames = windows.reduce((sum, window) => sum + window.frames, 0);
  return {
    valid: invalidWindows === 0,
    invalidWindows,
    windows: windows.length,
    durationMs,
    frames,
    logicFps: (frames * 1000) / durationMs,
    windowFpsP05: percentile(0.05),
    windowFpsP50: percentile(0.5),
    windowFpsP95: percentile(0.95),
    maxObservedStallMs,
  };
}
