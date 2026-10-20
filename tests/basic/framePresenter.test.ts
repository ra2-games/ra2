import { expect, it, vi } from 'vitest';
import { FramePresenter, type PresentationHooks } from '../../src/graphics/framePresenter';
import type { VmFrame } from '../../src/vm86/win32';

const frame = (): VmFrame => ({ width: 2, height: 1, pixels: new Uint8Array(2), palette: new Uint8Array(1024) });
function fixture(extra: Partial<PresentationHooks> = {}) {
  const jobs = new Map<number, FrameRequestCallback>();
  let id = 0;
  const output = { draw: vi.fn(), clear: vi.fn(), destroy: vi.fn() };
  const hooks = { targetSize: () => ({ width: 800, height: 600 }), presented: vi.fn(), tick: vi.fn(), ...extra };
  const presenter = new FramePresenter(output, hooks, {
    request: (callback) => {
      jobs.set(++id, callback);
      return id;
    },
    cancel: (value) => {
      jobs.delete(value);
    },
  });
  const flush = () => {
    const callbacks = [...jobs.values()];
    jobs.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { presenter, output, hooks, jobs, flush };
}
it('连续帧合并为一次 rAF，只呈现最新帧，不复制像素', () => {
  const { presenter, output, jobs, flush } = fixture();
  presenter.submit(frame());
  const latest = frame();
  presenter.submit(latest);
  expect(jobs.size).toBe(1);
  expect(presenter.frame).toBe(latest);
  flush();
  expect(output.draw).toHaveBeenCalledOnce();
  expect(output.draw.mock.calls[0]![0]).toBe(latest);
  presenter.schedule();
  flush();
  expect(output.draw).toHaveBeenCalledOnce();
});
it('光标同步呈现且保留排队 rAF，不同步刷新调试 UI', () => {
  const { presenter, output, hooks, jobs, flush } = fixture();
  presenter.submit(frame());
  presenter.presentCursor(10, 20, true);
  expect(output.draw).toHaveBeenCalledOnce();
  expect(hooks.tick).not.toHaveBeenCalled();
  expect(jobs.size).toBe(1);
  flush();
  expect(output.draw).toHaveBeenCalledOnce();
  expect(hooks.tick).toHaveBeenCalledOnce();
  presenter.presentCursor(10, 20, false);
  expect(output.draw).toHaveBeenCalledTimes(2);
  presenter.presentCursor(20, 30, false);
  expect(output.draw).toHaveBeenCalledTimes(2);
});
it('增强结果使用最新原帧光标，尺寸变化强制重绘', () => {
  const enhanced = frame();
  const { presenter, output, hooks, flush } = fixture({ transform: () => enhanced });
  const original = frame();
  presenter.submit(original);
  flush();
  expect(output.draw.mock.calls[0]![0]).toBe(enhanced);
  expect(output.draw.mock.calls[0]![4]).toBe(original);
  hooks.targetSize = () => ({ width: 640, height: 480 });
  presenter.invalidate();
  flush();
  expect(output.draw.mock.calls[1]!.slice(1, 3)).toEqual([640, 480]);
});
it('销毁取消排队帧并释放引用，晚到回调不会复活渲染', () => {
  const { presenter, output, jobs, flush } = fixture();
  presenter.submit(frame());
  const late = [...jobs.values()][0]!;
  presenter.destroy();
  presenter.destroy();
  late(0);
  presenter.submit(frame());
  presenter.presentCursor(1, 2, true);
  flush();
  expect(presenter.frame).toBeNull();
  expect(output.draw).not.toHaveBeenCalled();
  expect(output.destroy).toHaveBeenCalledOnce();
});
it('尚无帧时只清画布并更新低频状态', () => {
  const { presenter, output, hooks } = fixture();
  presenter.render();
  expect(output.clear).toHaveBeenCalledOnce();
  expect(hooks.tick).toHaveBeenCalledOnce();
});

it('高频光标保留首次即时反馈，帧尾使用最新坐标，不逐事件重绘整帧', () => {
  const { presenter, output, hooks, flush, jobs } = fixture();
  presenter.submit(frame());
  flush();
  output.draw.mockClear();
  presenter.presentCursor(1, 2, true);
  expect(output.draw).toHaveBeenCalledOnce();
  for (let x = 2; x <= 1000; x++) presenter.presentCursor(x, 3, true);
  expect(output.draw).toHaveBeenCalledOnce();
  expect(jobs.size).toBe(1);
  flush();
  expect(output.draw).toHaveBeenCalledTimes(2);
  expect(output.draw.mock.calls.at(-1)![3]).toEqual({ x: 1000, y: 3, visible: true });
  presenter.presentCursor(1001, 3, true);
  expect(output.draw).toHaveBeenCalledTimes(3);
  expect(hooks.tick).toHaveBeenCalledOnce();
});
