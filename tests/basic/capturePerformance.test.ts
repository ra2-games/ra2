import { afterEach, expect, it, vi } from 'vitest';
import { capturePerformance } from '../../src/adapter/capturePerformance';
import type { VmDiagnosticAction, VmDiagnostics, VmRuntimeInfo } from '../../src/adapter/vmDiagnostics';

afterEach(() => vi.useRealTimers());

function target() {
  const runtimeInfo: VmRuntimeInfo = { mode: 'worker', reason: 'default', workerProbeMs: 45, fallbackReason: null };
  return {
    runtimeInfo,
    getDiagnostics: vi.fn(
      async (_action: VmDiagnosticAction): Promise<VmDiagnostics> => ({
        sampledAtMs: performance.now(),
        phase: 'running',
        hypercalls: 10,
        clockRate: 1,
        execution: null,
        game: null,
      }),
    ),
  };
}

it('captures serial samples and preserves unavailable counters instead of claiming zero FPS', async () => {
  vi.useFakeTimers();
  const vm = target();
  const capture = capturePerformance(vm, {
    signal: new AbortController().signal,
    progress: vi.fn(),
    sampleHost: () => ({ visible: true }),
    durationMs: 2000,
  });
  await vi.advanceTimersByTimeAsync(2000);
  const report = await capture;
  expect(report.status).toBe('complete');
  expect(report.durationMs).toBe(2000);
  expect(report.samples).toHaveLength(4);
  expect(report.samples.every((sample) => sample.vm.game === null)).toBe(true);
  expect(vm.getDiagnostics.mock.calls.map(([action]) => action)).toEqual(['start', 'sample', 'sample', 'stop']);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancellation clears the wait and always disables instrumentation', async () => {
  vi.useFakeTimers();
  const vm = target(),
    controller = new AbortController();
  const capture = capturePerformance(vm, { signal: controller.signal, progress: vi.fn(), sampleHost: () => null });
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  const report = await capture;
  expect(report.status).toBe('cancelled');
  expect(vm.getDiagnostics.mock.calls.map(([action]) => action)).toEqual(['start', 'stop']);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains partial data and cleanup failures when an RPC fails', async () => {
  vi.useFakeTimers();
  const vm = target();
  vm.getDiagnostics.mockImplementation(async (action) => {
    if (action !== 'start') throw new Error('worker request failed');
    return { sampledAtMs: 0, phase: 'running', hypercalls: 10, clockRate: 1, execution: null, game: null };
  });
  const capture = capturePerformance(vm, {
    signal: new AbortController().signal,
    progress: vi.fn(),
    sampleHost: () => null,
  });
  await vi.advanceTimersByTimeAsync(1000);
  const report = await capture;
  expect(report.status).toBe('error');
  expect(report.samples).toHaveLength(1);
  expect(report.errors).toEqual(['worker request failed', 'stop: worker request failed']);
  expect(vm.getDiagnostics).toHaveBeenLastCalledWith('stop');
});
