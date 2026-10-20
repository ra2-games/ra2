import { expect, it, vi } from 'vitest';
import { FrameEffectController, type FrameEffect } from '../../src/app/session/frameEffectController';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const effect = (): FrameEffect<string> => ({
  load: vi.fn(async () => {}),
  frame: vi.fn(() => null),
  status: 'ready',
  destroy: vi.fn(),
});
function fixture(create = vi.fn(async () => effect())) {
  const options = {
    create,
    currentFrame: () => ({ width: 800, height: 600, pixels: new Uint8Array(), palette: new Uint8Array() }),
    isCurrent: () => true,
    invalidate: vi.fn(),
    beforeLoad: vi.fn(),
    publish: vi.fn(),
    now: () => 600,
  };
  return { controller: new FrameEffectController<string>(options), options };
}
it('停止后晚到的工厂实例被销毁，不开始加载', async () => {
  const pending = deferred<FrameEffect<string>>();
  const instance = effect();
  const { controller } = fixture(vi.fn(() => pending.promise));
  const load = controller.set({} as File, 'nomos2x');
  controller.stop();
  pending.resolve(instance);
  await load;
  expect(instance.destroy).toHaveBeenCalledOnce();
  expect(instance.load).not.toHaveBeenCalled();
});
it('模型加载中换源，旧失败不覆盖新模型状态', async () => {
  const pending = deferred<void>(),
    first = effect(),
    second = effect();
  first.load = vi.fn(() => pending.promise);
  const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const { controller, options } = fixture(create);
  const a = controller.set({} as File, 'first');
  await Promise.resolve();
  await controller.set({} as File, 'second');
  pending.reject(new Error('旧模型取消'));
  await a;
  controller.publishStatus(null);
  expect(options.publish).toHaveBeenLastCalledWith('ready');
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(second.destroy).not.toHaveBeenCalled();
});
it('失败报告与 500ms 状态节流，停止后恢复默认状态', async () => {
  const instance = effect();
  const { controller, options } = fixture(vi.fn(async () => instance));
  await controller.set({} as File, 'nomos2x');
  controller.publishStatus(null);
  controller.publishStatus(null);
  expect(options.publish).toHaveBeenCalledOnce();
  expect(instance.load).toHaveBeenCalledWith(expect.anything(), 'nomos2x');
  controller.stop(true);
  controller.publishStatus('原图');
  expect(options.publish).toHaveBeenLastCalledWith('原图');
  const failed = fixture(
    vi.fn(async () => {
      throw new Error('加载失败');
    }),
  );
  await expect(failed.controller.set({} as File)).rejects.toThrow('加载失败');
  expect(failed.options.publish).toHaveBeenLastCalledWith('整帧实验失败：加载失败');
});
it('超过整帧上限时不创建模型', async () => {
  const { controller, options } = fixture();
  options.currentFrame = () => ({ width: 801, height: 600, pixels: new Uint8Array(), palette: new Uint8Array() });
  await expect(controller.set({} as File)).rejects.toThrow('800×600');
  expect(options.create).not.toHaveBeenCalled();
});
