import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullscreenKeyboardLock } from '../../src/ui/pages/game/keyboardLock';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

function setup(keyboard?: { lock: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn> }) {
  const canvas = {} as HTMLCanvasElement;
  const doc = Object.assign(new EventTarget(), {
    fullscreenElement: null as null | { contains: (element: unknown) => boolean },
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { keyboard });
  const report = vi.fn();
  cleanup = installFullscreenKeyboardLock(canvas, report);
  const fullscreen = (active: boolean) => {
    doc.fullscreenElement = active ? { contains: (element) => element === canvas } : null;
    doc.dispatchEvent(new Event('fullscreenchange'));
  };
  return { doc, report, fullscreen };
}

describe('全屏 Keyboard Lock 生命周期', () => {
  it('只在游戏全屏时锁 Escape，退出与销毁释放', async () => {
    const keyboard = { lock: vi.fn().mockResolvedValue(undefined), unlock: vi.fn() };
    const { report, fullscreen } = setup(keyboard);
    expect(keyboard.lock).not.toHaveBeenCalled();
    fullscreen(true);
    await Promise.resolve();
    expect(keyboard.lock).toHaveBeenCalledExactlyOnceWith(['Escape']);
    expect(report).toHaveBeenLastCalledWith('active');
    fullscreen(false);
    expect(report).toHaveBeenLastCalledWith('inactive');
    const count = keyboard.lock.mock.calls.length;
    cleanup!();
    fullscreen(true);
    expect(keyboard.lock).toHaveBeenCalledTimes(count);
    expect(keyboard.unlock).toHaveBeenCalled();
  });

  it('不支持时报告限制，不猜测成功', () => {
    const { report, fullscreen } = setup();
    fullscreen(true);
    expect(report).toHaveBeenLastCalledWith('unavailable');
  });

  it('权限拒绝可处理，不产生未捕获 Promise', async () => {
    const { report, fullscreen } = setup({ lock: vi.fn().mockRejectedValue(new Error('denied')), unlock: vi.fn() });
    fullscreen(true);
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith('denied');
  });

  it.each(['exit', 'cleanup'])('授权晚于 %s 时释放锁，不上报成功', async (action) => {
    let resolve!: () => void;
    const keyboard = {
      lock: vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
      unlock: vi.fn(),
    };
    const { report, fullscreen } = setup(keyboard);
    fullscreen(true);
    if (action === 'exit') fullscreen(false);
    else cleanup!();
    keyboard.unlock.mockClear();
    resolve();
    await Promise.resolve();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalledWith('active');
  });

  it('退出再进入时旧请求不会解锁新会话', async () => {
    const pending: Array<() => void> = [];
    const keyboard = { lock: vi.fn(() => new Promise<void>((done) => pending.push(done))), unlock: vi.fn() };
    const { report, fullscreen } = setup(keyboard);
    fullscreen(true);
    fullscreen(false);
    fullscreen(true);
    keyboard.unlock.mockClear();
    pending[1]!();
    await Promise.resolve();
    pending[0]!();
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith('active');
    expect(keyboard.unlock).not.toHaveBeenCalled();
  });

  it('更换 VM 后旧实例迟到的授权结果不解除新实例的锁', async () => {
    let resolve!: () => void;
    const keyboard = {
      lock: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue(undefined),
      unlock: vi.fn(),
    };
    const { doc, fullscreen } = setup(keyboard);
    fullscreen(true);
    const oldCleanup = cleanup!;
    oldCleanup();
    const nextCanvas = {} as HTMLCanvasElement;
    doc.fullscreenElement = { contains: (element) => element === nextCanvas };
    const report = vi.fn();
    cleanup = installFullscreenKeyboardLock(nextCanvas, report);
    await Promise.resolve();
    keyboard.unlock.mockClear();
    resolve();
    await Promise.resolve();
    oldCleanup();
    expect(report).toHaveBeenLastCalledWith('active');
    expect(keyboard.unlock).not.toHaveBeenCalled();
  });
});
