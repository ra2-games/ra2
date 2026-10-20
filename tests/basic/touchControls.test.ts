import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAdaptiveTouchControls, installTouchControls } from '../../src/ui/pages/game/touchControls';
import type { KeyStrokeTarget } from '../../src/ui/pages/game/input';

type EventHandler = (event: Record<string, unknown>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Map<EventListenerOrEventListenerObject, EventHandler>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const handler =
      typeof listener === 'function'
        ? (event: Record<string, unknown>) => listener(event as unknown as Event)
        : (event: Record<string, unknown>) => listener.handleEvent(event as unknown as Event);
    const handlers = this.listeners.get(type) ?? new Map<EventListenerOrEventListenerObject, EventHandler>();
    handlers.set(listener, handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    handlers.delete(listener);
    if (!handlers.size) this.listeners.delete(type);
  }

  dispatch(type: string, fields: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault: vi.fn(),
      ...fields,
    };
    for (const handler of [...(this.listeners.get(type)?.values() ?? [])]) handler(event);
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement extends FakeEventTarget {
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly style: { transform: string } = { transform: '' };
  hidden = true;
  type = '';
  readonly setPointerCapture = vi.fn<(pointerId: number) => void>();

  constructor(
    readonly id: string,
    readonly selectorChildren: FakeElement[] = [],
  ) {
    super();
  }

  querySelectorAll<T extends Element = Element>(selector: string): T[] {
    if (selector === '[data-code]') return this.selectorChildren as unknown as T[];
    return [];
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    if (selector === '.joystick-knob') return (this.selectorChildren[0] as unknown as T) ?? null;
    if (selector === '[data-role="collapse"]') {
      return (this.selectorChildren.find((child) => child.id === 'collapse') as unknown as T) ?? null;
    }
    return null;
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  }
}

class FakeDocument extends FakeEventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  constructor(private readonly elements: Map<string, FakeElement>) {
    super();
  }

  getElementById<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return (this.elements.get(id) as unknown as T) ?? null;
  }
}

function createFixture() {
  const left = new FakeElement('left');
  left.dataset.code = 'ArrowLeft';
  const right = new FakeElement('right');
  right.dataset.code = 'ArrowRight';
  const collapse = new FakeElement('collapse');
  const container = new FakeElement('vm-touch-controls', [left, right, collapse]);
  const knob = new FakeElement('knob');
  const joystick = new FakeElement('vm-touch-joystick', [knob]);
  const document = new FakeDocument(
    new Map([
      [container.id, container],
      [joystick.id, joystick],
    ]),
  );
  const window = new FakeEventTarget() as FakeEventTarget & {
    setInterval: typeof globalThis.setInterval;
    clearInterval: typeof globalThis.clearInterval;
  };
  window.setInterval = ((handler: TimerHandler, timeout?: number) =>
    globalThis.setInterval(handler, timeout) as unknown as number) as typeof globalThis.setInterval;
  window.clearInterval = ((id: number) => {
    globalThis.clearInterval(id as unknown as ReturnType<typeof globalThis.setInterval>);
  }) as typeof globalThis.clearInterval;
  const values = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const setKeyState = vi.fn<(virtualKey: number, down: boolean) => void>();
  const postMessage = vi.fn<(message: number, wParam?: number, lParam?: number) => void>();

  vi.stubGlobal('document', document as unknown as Document);
  vi.stubGlobal('window', window as unknown as Window & typeof globalThis);
  vi.stubGlobal('localStorage', localStorage);

  return {
    container,
    left,
    right,
    collapse,
    joystick,
    knob,
    document,
    window,
    localStorage,
    vm: { setKeyState, postMessage } satisfies KeyStrokeTarget,
    setKeyState,
    postMessage,
  };
}

describe('touch controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('触控能力为真也不预先显示控件，触碰画布后才启用', () => {
    const fixture = createFixture();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    vi.stubGlobal('navigator', { maxTouchPoints: 10 });
    const canvas = new FakeElement('screen');
    const cleanup = installAdaptiveTouchControls(canvas as unknown as HTMLElement, fixture.vm);
    canvas.dispatch('pointerdown', { pointerType: 'mouse' });
    canvas.dispatch('pointerdown', { pointerType: 'pen' });
    expect(fixture.container.hidden).toBe(true);
    expect(fixture.joystick.hidden).toBe(true);

    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    expect(fixture.container.hidden).toBe(false);
    expect(fixture.joystick.hidden).toBe(false);
    fixture.left.dispatch('pointerdown', { pointerId: 1 });
    expect(fixture.setKeyState).toHaveBeenCalledExactlyOnceWith(0x25, true);
    cleanup();
    expect(fixture.setKeyState).toHaveBeenLastCalledWith(0x25, false);
    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    expect(fixture.container.hidden).toBe(true);
  });

  it('切回鼠标时释放虚拟按键、停止摇杆，下一次触摸可恢复', () => {
    const fixture = createFixture();
    const canvas = new FakeElement('screen');
    const cleanup = installAdaptiveTouchControls(canvas as unknown as HTMLElement, fixture.vm);
    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    fixture.collapse.dispatch('click');
    fixture.left.dispatch('pointerdown', { pointerId: 1 });
    fixture.joystick.dispatch('pointerdown', { pointerId: 7 });
    fixture.joystick.dispatch('pointermove', { pointerId: 7, clientX: 84, clientY: 50 });
    canvas.dispatch('pointerdown', { pointerType: 'mouse' });
    expect(fixture.container.hidden).toBe(true);
    expect(fixture.joystick.hidden).toBe(true);
    expect(fixture.setKeyState.mock.calls.slice(-2)).toEqual([
      [0x25, false],
      [0x27, false],
    ]);
    const calls = fixture.setKeyState.mock.calls.length;
    vi.advanceTimersByTime(200);
    expect(fixture.setKeyState).toHaveBeenCalledTimes(calls);

    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    expect(fixture.container.hidden).toBe(false);
    expect(fixture.container.classList.contains('collapsed')).toBe(true);
    fixture.left.dispatch('pointerdown', { pointerId: 2 });
    expect(fixture.setKeyState).toHaveBeenCalledTimes(calls + 1);
    cleanup();
  });

  it('鼠标实际移动才隐藏触屏控件，零位移重新命中不改变模式', () => {
    const fixture = createFixture();
    const canvas = new FakeElement('screen');
    const cleanup = installAdaptiveTouchControls(canvas as unknown as HTMLElement, fixture.vm);
    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    canvas.dispatch('pointermove', { pointerType: 'mouse', movementX: 0, movementY: 0 });
    expect(fixture.container.hidden).toBe(false);
    canvas.dispatch('pointermove', { pointerType: 'touch', movementX: 1, movementY: 1 });
    expect(fixture.container.hidden).toBe(false);
    canvas.dispatch('pointermove', { pointerType: 'mouse', movementX: 1, movementY: 0 });
    expect(fixture.container.hidden).toBe(true);
    cleanup();
  });

  it('maps independent button pointers and releases every held key on blur/visibility changes', () => {
    const fixture = createFixture();
    const cleanup = installTouchControls(fixture.vm);

    fixture.left.dispatch('pointerdown', { pointerId: 1 });
    fixture.right.dispatch('pointerdown', { pointerId: 2 });
    fixture.left.dispatch('pointerup', { pointerId: 1 });

    expect(fixture.setKeyState.mock.calls.map(([vk, down]) => [vk, down])).toEqual([
      [0x25, true],
      [0x27, true],
      [0x25, false],
    ]);

    (globalThis.window as unknown as FakeEventTarget).dispatch('blur');
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x27, false]);

    fixture.left.dispatch('pointerdown', { pointerId: 3 });
    fixture.document.visibilityState = 'hidden';
    fixture.document.dispatch('visibilitychange');
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x25, false]);
    expect(fixture.postMessage.mock.calls.filter(([message]) => message === 0x0100)).toHaveLength(3);
    expect(fixture.postMessage.mock.calls.filter(([message]) => message === 0x0101)).toHaveLength(3);

    cleanup();
    expect(fixture.container.hidden).toBe(true);
    expect(fixture.joystick.hidden).toBe(true);
  });

  it('persists collapse state and removes the collapse listener during cleanup', () => {
    const fixture = createFixture();
    const cleanup = installTouchControls(fixture.vm);

    expect(fixture.container.classList.contains('collapsed')).toBe(false);
    fixture.collapse.dispatch('click');
    expect(fixture.container.classList.contains('collapsed')).toBe(true);
    expect(fixture.localStorage.setItem).toHaveBeenLastCalledWith('ra2-vm-touch-controls-hidden', '1');

    cleanup();
    fixture.collapse.dispatch('click');
    expect(fixture.container.classList.contains('collapsed')).toBe(true);
    expect(fixture.localStorage.setItem).toHaveBeenCalledTimes(2);
  });

  it('drives joystick directions, repeats keydown, and resets on pointer release or resize', () => {
    const fixture = createFixture();
    const cleanup = installTouchControls(fixture.vm);

    fixture.joystick.dispatch('pointerdown', { pointerId: 7 });
    fixture.joystick.dispatch('pointermove', { pointerId: 7, clientX: 84, clientY: 50 });
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x27, true]);
    expect(fixture.knob.style.transform).toBe('translate(34px, 0px)');

    vi.advanceTimersByTime(100);
    expect(fixture.setKeyState.mock.calls.filter(([vk, down]) => vk === 0x27 && down)).toHaveLength(3);

    fixture.joystick.dispatch('pointermove', { pointerId: 7, clientX: 50, clientY: 20 });
    expect(fixture.setKeyState.mock.calls.slice(-2)).toEqual([
      [0x27, false],
      [0x26, true],
    ]);
    fixture.joystick.dispatch('pointerup', { pointerId: 7 });
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x26, false]);
    expect(fixture.knob.style.transform).toBe('translate(0px, 0px)');

    fixture.joystick.dispatch('pointerdown', { pointerId: 8 });
    fixture.joystick.dispatch('pointermove', { pointerId: 8, clientX: 50, clientY: 20 });
    fixture.window.dispatch('resize');
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x26, false]);
    expect(fixture.knob.style.transform).toBe('translate(0px, 0px)');
    const calls = fixture.setKeyState.mock.calls.length;
    fixture.joystick.dispatch('pointermove', { pointerId: 8, clientX: 84, clientY: 50 });
    vi.advanceTimersByTime(100);
    expect(fixture.setKeyState).toHaveBeenCalledTimes(calls);

    cleanup();
    vi.advanceTimersByTime(100);
    expect(fixture.setKeyState.mock.calls.at(-1)).toEqual([0x26, false]);
  });
});
