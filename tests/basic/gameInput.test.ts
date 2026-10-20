import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGameInput, type InstalledGameInput } from '../../src/ui/pages/game/gameInput';
import type { VmShell } from '../../src/adapter/runtime';

let installed: InstalledGameInput | undefined;
afterEach(() => {
  installed?.cleanup();
  installed = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(search = '', locked = true) {
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    tabIndex: 0,
    parentElement: null,
    closest: () => null,
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    requestPointerLock: vi.fn().mockResolvedValue(undefined),
  });
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: locked ? canvas : null,
    activeElement: canvas,
    fullscreenElement: null,
    hidden: false,
    createElement: () => ({ remove: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } }),
    exitPointerLock: vi.fn(),
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search }, setTimeout }));
  vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const vm = { setCursorPosition: vi.fn(), postMessage: vi.fn(), setKeyState: vi.fn() };
  const present = vi.fn();
  const reportPress = vi.fn();
  installed = installGameInput(
    canvas as unknown as HTMLCanvasElement,
    vm as unknown as VmShell,
    true,
    present,
    () => ({ width: 800, height: 600 }),
    reportPress,
  );
  const pointer = (type: string, fields: Record<string, number> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: 400,
      clientY: 300,
      movementX: 0,
      movementY: 0,
      ctrlKey: false,
      shiftKey: false,
      ...fields,
    });
    canvas.dispatchEvent(event);
  };
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { canvas, doc, vm, present, reportPress, pointer, frames, flush };
}

it('reports the guest cursor position for a locked mouse click', () => {
  const { pointer, reportPress } = setup();
  pointer('pointermove', { movementX: 18, movementY: -12 });
  pointer('pointerdown', { button: 0 });
  expect(reportPress).toHaveBeenCalledExactlyOnceWith({
    x: 418,
    y: 288,
    width: 800,
    height: 600,
    button: 'left',
    pointer: 'mouse',
  });
});

describe('桌面鼠标跟手性', () => {
  it.each(['blur-first', 'unlock-first', 'unlock-only'])('失焦/隐藏/解锁不伪造 Esc：%s', (order) => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    const blur = () => {
      window.dispatchEvent(new Event('blur'));
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    };
    if (order === 'blur-first') blur();
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    if (order === 'unlock-first') blur();
    vi.advanceTimersByTime(1000);
    expect(vm.postMessage).not.toHaveBeenCalled();
    expect(vm.setKeyState).not.toHaveBeenCalled();
  });

  it('真实 Esc 只转发一组 DOWN/UP，随后解锁不补发', () => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    for (const type of ['keydown', 'keyup']) {
      window.dispatchEvent(
        Object.assign(new Event(type, { cancelable: true }), {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          altKey: false,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
        }),
      );
    }
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    vi.advanceTimersByTime(1000);
    expect(
      vm.postMessage.mock.calls
        .filter(([message]) => message === 0x100 || message === 0x101)
        .map(([message, key]) => [message, key]),
    ).toEqual([
      [0x100, 27],
      [0x101, 27],
    ]);
  });
  it('首个移动立即到达 VM，同帧后续位移合并且不丢距离', () => {
    const { vm, present, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 3, movementY: 2 });
    expect(present).toHaveBeenLastCalledWith(403, 302, true);
    expect(vm.postMessage).toHaveBeenCalledExactlyOnceWith(0x200, 0, (302 << 16) | 403);
    pointer('pointermove', { movementX: 4, movementY: -1 });
    expect(present).toHaveBeenLastCalledWith(407, 301, true);
    expect(frames.size).toBe(1);
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    flush();
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(407, 301);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (301 << 16) | 407);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledTimes(2); // flush neither presents twice nor rolls back the cursor
  });

  it('单次移动不在帧尾重复投递，下一帧的首个移动仍立即发送', () => {
    const { vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 1 });
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointermove', { movementX: 1 });
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (300 << 16) | 402);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
  });

  it('千次高频移动只发送首尾两次，点击前冲刷尾部', () => {
    const { vm, pointer, flush } = setup();
    for (let i = 0; i < 1000; i++) pointer('pointermove', { movementX: i % 2 ? -1 : 1 });
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointerdown', { buttons: 1 });
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x200, 0x201]);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x201, 1, (300 << 16) | 400);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('点击前先冲刷移动消息，保留 MOVE/DOWN/UP 的顺序', () => {
    const { vm, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x201, 0x202]);
    expect(vm.postMessage.mock.calls.every(([, , point]) => point === ((300 << 16) | 410))).toBe(true);
    expect(frames.size).toBe(0);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('失焦后取消尚未投递的移动', () => {
    const { canvas, vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    vm.postMessage.mockClear();
    pointer('pointermove', { movementX: 10 });
    canvas.dispatchEvent(new Event('blur'));
    flush();
    expect(vm.postMessage).not.toHaveBeenCalled();
  });

  it.each(['', '?raw-mouse=0', '?raw-mouse=1'])('Windows 锁定沿用系统调整，原始计数须显式开启：%s', (search) => {
    const { canvas, pointer } = setup(search, false);
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(canvas.requestPointerLock).toHaveBeenCalledExactlyOnceWith(
      search === '?raw-mouse=1' ? { unadjustedMovement: true } : undefined,
    );
  });
});
