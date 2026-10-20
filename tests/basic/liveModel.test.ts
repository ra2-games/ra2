import '../helpers/chineseLocale';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveModel } from '../../src/ui/pages/game/experiments/liveModel';
import { decodeHalf, halfRgbTensor } from '../../src/ui/pages/game/experiments/halfFloat';
import { probeFrameOutput, isLiveModelId } from '../../src/ui/pages/game/experiments/modelProbe';
import type { VmFrame } from '../../src/vm86/win32';

class FakeWorker {
  static last: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: unknown) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.last = this;
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { hidden: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const frame = (): VmFrame => ({
  width: 2,
  height: 1,
  pixels: new Uint8Array(),
  palette: new Uint8Array(),
  rgb565: new Uint16Array([0xf800, 0x07e0]),
});
async function loaded() {
  const changed = vi.fn(),
    model = new LiveModel(changed);
  const task = model.load({ size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File);
  await Promise.resolve();
  FakeWorker.last.reply({ type: 'ready', adapter: 'test' });
  await task;
  return { model, worker: FakeWorker.last, changed };
}
it('RGB8 半精度转换误差有界，负数/非正规数/NaN 正确解码', () => {
  for (let v = 0; v < 256; v++) {
    const data = decodeHalf(halfRgbTensor(new Uint8ClampedArray([v, v, v, 255])));
    expect(Math.abs(data[0]! - v / 255)).toBeLessThanOrEqual(1 / 4096);
  }
  expect([...decodeHalf(new Uint16Array([0x3c00, 0xbc00, 1, 0x7c00, 0x7e00]))]).toEqual([
    1,
    -1,
    2 ** -24,
    Infinity,
    NaN,
  ]);
});
it('矩形整帧严格保持 4×，不把 H/W 颠倒', () => {
  const output = probeFrameOutput(new Float32Array(96), [1, 3, 4, 8], 2, 1, 4);
  expect([output.size, output.height]).toEqual([8, 4]);
  expect(() => probeFrameOutput(new Float32Array(96), [1, 3, 8, 4], 2, 1, 4)).toThrow('4×');
});
it('单任务背压、复制输入、使用最新帧、禁止重复推理同帧', async () => {
  const { model, worker } = await loaded();
  const first = frame(),
    second = frame();
  expect(model.frame(first)).toBeNull();
  const submitted = worker.postMessage.mock.calls[1]![0];
  first.rgb565!.fill(0);
  expect([...submitted.image.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  model.frame(second);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.reply({ type: 'result', image: { size: 8, height: 4, rgba: new Uint8ClampedArray(128) }, milliseconds: 10 });
  expect(model.frame(second)?.width).toBe(8);
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  worker.reply({ type: 'result', image: { size: 8, height: 4, rgba: new Uint8ClampedArray(128) }, milliseconds: 10 });
  model.frame(second);
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  model.destroy();
  worker.reply({ type: 'result' });
  expect(model.frame(first)).toBeNull();
  expect(worker.terminate).toHaveBeenCalled();
});
it('超时/超大帧恢复原图并释放 Worker', async () => {
  const { model, worker } = await loaded();
  model.frame(frame());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(model.frame(frame())).toBeNull();
  expect(model.status).toContain('120 秒');
  expect(worker.terminate).toHaveBeenCalled();
  const other = await loaded();
  other.model.frame({ ...frame(), width: 801 });
  expect(other.model.status).toContain('800×600');
  expect(other.worker.terminate).toHaveBeenCalled();
});
it('隐藏页面不提交新帧，改变分辨率不显示旧尺寸结果', async () => {
  const { model, worker } = await loaded();
  vi.stubGlobal('document', { hidden: true });
  model.frame(frame());
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  vi.stubGlobal('document', { hidden: false });
  model.frame(frame());
  expect(model.frame({ ...frame(), width: 1 })).toBeNull();
  worker.reply({ type: 'result', image: { size: 8, height: 4, rgba: new Uint8ClampedArray(128) }, milliseconds: 10 });
  expect(model.frame({ ...frame(), width: 1 })).toBeNull();
  model.destroy();
});
it('加载中取消拒绝等待者，晚到 ready 不会复活实验', async () => {
  const model = new LiveModel(vi.fn());
  const task = model.load({ size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File);
  const rejected = expect(task).rejects.toThrow('取消');
  await Promise.resolve();
  model.destroy();
  await rejected;
  FakeWorker.last.reply({ type: 'ready', adapter: 'test' });
  expect(model.frame(frame())).toBeNull();
});
it.each(['nomos2x', 'nomos2x-fp16'] as const)('整帧传递 %s 身份并保持矩形 2× 输出', async (id) => {
  const model = new LiveModel(vi.fn());
  const task = model.load({ size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File, id);
  await Promise.resolve();
  expect(FakeWorker.last.postMessage.mock.calls[0]![0]).toMatchObject({ modelId: id, locale: 'zh-CN' });
  FakeWorker.last.reply({ type: 'ready', adapter: 'test' });
  await task;
  const source = frame();
  model.frame(source);
  FakeWorker.last.reply({
    type: 'result',
    image: { size: 4, height: 2, rgba: new Uint8ClampedArray(32) },
    milliseconds: 1,
  });
  expect(model.frame(source)?.width).toBe(4);
  expect(model.status).toContain('NomosUni SPAN');
  expect(model.status).toContain('2×1 → 4×2');
  model.destroy();
});
it('不把其他探针模型自动开放为整帧', () => {
  expect(isLiveModelId('apisr2x')).toBe(false);
  expect(isLiveModelId('nomos2x-fp16')).toBe(true);
});
