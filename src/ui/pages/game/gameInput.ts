import { t } from '../../shared/i18n/translate';
import type { VmShell } from '../../../adapter/runtime';
import { keyLParam, normalizePointerButton, rescaleLogicalPointer, virtualKey, win32CharacterCode } from './input';
import { calculateCanvasFit } from './canvasFit';
import { installFullscreenKeyboardLock, type KeyboardLockState } from './keyboardLock';

let canvasFitObserver: ResizeObserver | null = null;
let canvasDprQuery: MediaQueryList | null = null;
let canvasDprFitListener: (() => void) | null = null;
let canvasFullscreenFitListener: (() => void) | null = null;
let canvasWindowFitListener: (() => void) | null = null;

/**
 * Page shortcuts bypass game injection in installGameInput keydown/keyup and are handled centrally here.
 * Leave number/letter keys available for native game hotkeys.
 */
const UI_SHORTCUT_KEYS = new Set(['`', 'F11', '?', '[', ']']);

/**
 * Canvas CSS-box cache refreshed by installCanvasFit after every fit, including fullscreen changes.
 * Frequent mousemove reads no longer call getBoundingClientRect each time.
 */
interface CanvasInputRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

let canvasRectCache: CanvasInputRect | null = null;

function refreshCanvasRect(canvas: HTMLCanvasElement): CanvasInputRect {
  const rect = canvas.getBoundingClientRect();
  canvasRectCache = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  return canvasRectCache;
}

function currentCanvasRect(canvas: HTMLCanvasElement): CanvasInputRect {
  return canvasRectCache ?? refreshCanvasRect(canvas);
}

/** Fullscreen frame and lock hints, excluding toolbar/debug layers; input lifecycle owns keyboard locking. */
export async function toggleImmersiveFullscreen(canvas: HTMLCanvasElement): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    try {
      await (canvas.parentElement ?? canvas).requestFullscreen({ navigationUI: 'hide' });
    } catch (error) {
      console.warn(t('[VM UI] 全屏请求被拒绝'), error);
    }
  }
}

import { controlsCollapsed } from './state/uiState';

/** Input publishes only collapse intent; React owns toolbar classes and button text. */
export function setControlsCollapsed(collapsed: boolean): void {
  controlsCollapsed.set(collapsed);
}

/**
 * Visually scale the canvas to the largest aspect-preserving size allowed by the window. The CSS box fits exactly; physical backing uses integer scales (round up at >=1x, cap at 2x; use exact downscaling below 1x). The raster pipeline therefore has only direct 1:1, one-pass integer Nx nearest-neighbor, and one-pass bilinear downscaling, with at most one canvas resample per frame. Delegate fractional backing-to-CSS scaling to the browser compositor (Skia scaling is almost free on GPU; rounding up supersamples, and compositor downscaling is sharper than upscaling). Fractional backing causes two resamples: software-rendered 1920x1080 menus measured 32fps with a large 1.8x intermediate buffer versus 60fps at integer scales in the same window. Cap at 2x because larger nearest-neighbor scales also take 25ms+ in software rendering. Map pointer coordinates through getBoundingClientRect to current guest-frame logical coordinates.
 */
export interface GameFrameSize {
  width: number;
  height: number;
}

export type GameFrameSizeProvider = () => GameFrameSize;

export function installCanvasFit(
  canvas: HTMLCanvasElement,
  getFrameSize: GameFrameSizeProvider,
  onResized?: () => void,
): ((frameWidth?: number, frameHeight?: number) => void) & { destroy(): void } {
  // The first fit() runs during page initialization before the render loop exists; run silently without callbacks.
  let ready = false;
  const initialFrame = getFrameSize();
  let activeFrameWidth = initialFrame.width;
  let activeFrameHeight = initialFrame.height;
  const fit = (nextFrameWidth = activeFrameWidth, nextFrameHeight = activeFrameHeight) => {
    if (
      !Number.isFinite(nextFrameWidth) ||
      nextFrameWidth <= 0 ||
      !Number.isFinite(nextFrameHeight) ||
      nextFrameHeight <= 0
    )
      return;
    // Store frame dimensions before reading stage geometry so a first frame arriving before stage layout completes
    // still gives the next ResizeObserver callback the latest aspect ratio instead of stale 800x600.
    activeFrameWidth = nextFrameWidth;
    activeFrameHeight = nextFrameHeight;
    // Scaling reference: #stage's local layout box in normal layout;
    // in immersive fullscreen the browser expands the frame container to the viewport, so use viewport dimensions.
    // #screen-frame only wraps the canvas to position pointer-lock effects; it is not the scaling reference.
    const stage = canvas.closest('#stage');
    const isCanvasFullscreen = !!document.fullscreenElement?.contains(canvas);
    if (!stage && !isCanvasFullscreen) return;
    const rect = isCanvasFullscreen
      ? {
          width: window.innerWidth,
          height: window.innerHeight,
        }
      : { width: stage!.clientWidth, height: stage!.clientHeight };
    if (!rect.width || !rect.height) return;
    const fit = calculateCanvasFit({
      stageWidth: rect.width,
      stageHeight: rect.height,
      frameWidth: nextFrameWidth,
      frameHeight: nextFrameHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    if (!fit) return;
    const width = fit.backingWidth;
    const height = fit.backingHeight;
    const cssWidth = `${fit.cssWidth}px`;
    const cssHeight = `${fit.cssHeight}px`;
    const aspectRatio = `${activeFrameWidth} / ${activeFrameHeight}`;
    const backingChanged = canvas.width !== width || canvas.height !== height;
    const cssChanged = canvas.style.width !== cssWidth || canvas.style.height !== cssHeight;
    const aspectChanged = canvas.style.aspectRatio !== aspectRatio;
    if (backingChanged) {
      canvas.width = width;
      canvas.height = height;
    }
    if (cssChanged) {
      canvas.style.width = cssWidth;
      canvas.style.height = cssHeight;
    }
    if (aspectChanged) canvas.style.aspectRatio = aspectRatio;
    if (!backingChanged && !cssChanged && !aspectChanged) {
      // Skip resetting unchanged dimensions, such as returning to the same scale after fullscreen; even assigning the same canvas.width
      // clears its bitmap and needlessly flashes a frame. Refresh only the potentially moved rect cache.
      refreshCanvasRect(canvas);
      return;
    }
    // Refresh the rect cache synchronously for frequent mousePosition reads; see currentCanvasRect.
    // This is the only canvas-layout-box mutation point, including fullscreen transitions.
    refreshCanvasRect(canvas);
    // Only backing resets clear the bitmap and require immediate redraw; CSS-only scaling preserves it.
    if (backingChanged && ready) onResized?.();
  };
  canvasFitObserver?.disconnect();
  canvasFitObserver = new ResizeObserver(() => fit());
  const stage = canvas.closest('#stage');
  if (stage) canvasFitObserver.observe(stage);
  // Moving between displays or browser zoom can change devicePixelRatio without changing stage CSS size; track the resolution media query.
  const fitEnvironmentChange = () => fit();
  // Refresh viewport-relative input bounds on window resize as well as stage changes.
  if (canvasWindowFitListener) window.removeEventListener('resize', canvasWindowFitListener);
  window.addEventListener('resize', fitEnvironmentChange);
  canvasWindowFitListener = fitEnvironmentChange;
  if (canvasDprQuery && canvasDprFitListener) {
    canvasDprQuery.removeEventListener('change', canvasDprFitListener);
  }
  canvasDprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  canvasDprQuery.addEventListener('change', fitEnvironmentChange);
  canvasDprFitListener = fitEnvironmentChange;
  // Refit on immersive fullscreen transitions because fullscreen-box dimensions are independent of normal layout.
  if (canvasFullscreenFitListener) document.removeEventListener('fullscreenchange', canvasFullscreenFitListener);
  document.addEventListener('fullscreenchange', fitEnvironmentChange);
  canvasFullscreenFitListener = fitEnvironmentChange;
  fit();
  ready = true;
  const observer = canvasFitObserver,
    query = canvasDprQuery;
  return Object.assign(fit, {
    destroy() {
      ready = false;
      observer.disconnect();
      query.removeEventListener('change', fitEnvironmentChange);
      document.removeEventListener('fullscreenchange', fitEnvironmentChange);
      window.removeEventListener('resize', fitEnvironmentChange);
      if (canvasFitObserver === observer) canvasFitObserver = null;
      if (canvasDprQuery === query) {
        canvasDprQuery = null;
        canvasDprFitListener = null;
      }
      if (canvasFullscreenFitListener === fitEnvironmentChange) canvasFullscreenFitListener = null;
      if (canvasWindowFitListener === fitEnvironmentChange) canvasWindowFitListener = null;
    },
  });
}

export interface InstalledGameInput {
  adaptResolution(width: number, height: number): void;
  cleanup(): void;
}

export interface GamePointerPress {
  x: number;
  y: number;
  width: number;
  height: number;
  button: 'left' | 'right' | 'middle';
  pointer: 'mouse' | 'touch' | 'pen';
}

export function installGameInput(
  canvas: HTMLCanvasElement,
  vm: VmShell,
  lockDesktopMouse = true,
  onCursorPresentation?: (x: number, y: number, visible: boolean) => void,
  getFrameSize: GameFrameSizeProvider = () => ({ width: 800, height: 600 }),
  onPointerPress?: (press: GamePointerPress) => void,
): InstalledGameInput {
  // Retain system mouse acceleration/speed by default; raw counts are not the system cursor's screen displacement.
  // Only explicit ?raw-mouse=1 bypasses system adjustment; never enable it automatically on Windows.
  const rawMouse = new URLSearchParams(window.location.search).get('raw-mouse') === '1';
  // Accept keyboard focus after clicks without letting Tab draw a browser focus outline over the game.
  canvas.tabIndex = -1;
  canvas.style.outline = 'none';
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  const removers: Array<() => void> = [];
  // RA2 uses the Win32 hardware cursor on its menus. The browser is the hardware
  // cursor in this adapter, so keep it explicit when pointer lock is disabled;
  // inherited page styles or a stale game cursor must not leave the menu cursorless.
  if (!lockDesktopMouse) {
    const previousCursor = canvas.style.getPropertyValue('cursor');
    const previousCursorPriority = canvas.style.getPropertyPriority('cursor');
    canvas.style.setProperty('cursor', 'default', 'important');
    removers.push(() => {
      if (previousCursor) canvas.style.setProperty('cursor', previousCursor, previousCursorPriority);
      else canvas.style.removeProperty('cursor');
    });
  }
  let mouseFlags = 0;
  let lastMouseLParam = 0;
  const reportPress = (lParam: number, button: GamePointerPress['button'], pointer: GamePointerPress['pointer']) => {
    if (!onPointerPress) return;
    const { width, height } = getFrameSize();
    try {
      onPointerPress({ x: lParam & 0xffff, y: (lParam >>> 16) & 0xffff, width, height, button, pointer });
    } catch {
      // Optional host telemetry must never interrupt delivery of a guest input message.
    }
  };
  const initialFrame = getFrameSize();
  let logicalMouseX = initialFrame.width / 2;
  let logicalMouseY = initialFrame.height / 2;
  let logicalFrameWidth = initialFrame.width;
  let logicalFrameHeight = initialFrame.height;
  let pointerLockPending = false;
  let desktopMoveFrame: number | null = null;
  let pendingDesktopMove: { x: number; y: number; lParam: number; wParam: number } | null = null;
  // Deliver the first desktop click's complete DOWN/UP pair in the same absolute-coordinate mode.
  // Locking immediately in pointerdown makes some Chromium/Windows combinations switch to relative coordinates
  // between the events or cancel pointerup, breaking menus that rely on WM_LBUTTONUP.
  let lockAfterPointerUp = false;
  let lastCtrlPrimaryDispatch: { at: number; lParam: number } | null = null;
  let compatibilityCtrlPrimaryActive = false;
  const hostPlatform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  const normalizedPointerButtons = new Map<number, number>();
  const heldKeys = new Map<string, { vk: number; system: boolean }>();
  // Modifiers may already be held before the canvas gains focus; synthesize their missing down edges on pointerdown,
  // then release normally on keyup/blur to keep RA2's key-state table aligned with browser physical state.
  const reconciledModifiers = new Map<number, string>();

  // ---- Touch gesture state machine ----
  // Delay touch DOWN until the gesture is identified as tap, drag, or long-press right-click, ensuring:
  // 1) 400ms long press means right-click; 2) double taps retain two complete physical clicks;
  // 3) drag sends left DOWN at the original contact point. USER32 generates double-click messages from window-class styles.
  // Two-finger trackpad semantics: tap means right-click; drag holds right-click for native map panning.
  // The cursor always follows the primary finger and the map pans 1:1, leaving the cursor at the release point.
  // A second finger cancels pending single-finger long-press/tap intent; ignore it once the first finger is already dragging/right-clicking.
  const TOUCH_LONG_PRESS_MS = 400;
  // See handleTouchPointerMove for the drag threshold, expressed in game pixels and adapted to canvas scaling.
  interface TouchGesture {
    pointerId: number;
    phase: 'pending' | 'drag' | 'right' | 'two-pending' | 'two-drag';
    downX: number;
    downY: number;
    downLParam: number;
    downClientX: number;
    downClientY: number;
    /** Primary finger's client position when entering two-finger mode; anchor for detecting two-finger drags. */
    twoClientX: number;
    twoClientY: number;
    modifiers: number;
    timer: number;
  }
  let touchGesture: TouchGesture | null = null;
  const activeTouches = new Set<number>();
  /**
   * Shift+left-click repeats 10 times: dispatch the first pair immediately, then WM_LBUTTONDOWN/UP pairs every 50ms.
   * Remove Shift from repeated-click modifiers so the game receives 10 ordinary clicks. Swallow physical up while repetition runs because each pair supplies its own; physical up after completion is delivered normally and is harmless.
   */
  const SHIFT_CLICK_COUNT = 10;
  const SHIFT_CLICK_INTERVAL_MS = 50;
  let shiftBurstTimer: number | null = null;
  const cancelShiftBurst = () => {
    if (shiftBurstTimer !== null) {
      window.clearTimeout(shiftBurstTimer);
      shiftBurstTimer = null;
    }
  };
  const startShiftBurst = (lParam: number, modifiers: number) => {
    cancelShiftBurst();
    const mods = modifiers & ~0x0004;
    let remaining = SHIFT_CLICK_COUNT;
    const step = () => {
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, mods | 0x0001, lParam); // WM_LBUTTONDOWN
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, mods, lParam); // WM_LBUTTONUP
      // Capture click sequences in the ordinary left-click format so multiplayer smoke replay can reproduce repeated clicks.
      console.log(`[click-seq] ${lParam & 0xffff},${(lParam >>> 16) & 0xffff}`);
      remaining -= 1;
      shiftBurstTimer = remaining > 0 ? window.setTimeout(step, SHIFT_CLICK_INTERVAL_MS) : null;
    };
    step();
  };

  /** Dispatch taps by cursor shape: attack/move destinations use right-click; empty ground, friendly units, and UI use left-click. */
  const dispatchTapClick = (downLParam: number, modifiers: number, right: boolean) => {
    if (right) {
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, modifiers | 0x0002, downLParam); // WM_RBUTTONDOWN
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, modifiers, downLParam); // WM_RBUTTONUP
    } else {
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, modifiers | 0x0001, downLParam);
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifiers, downLParam); // WM_LBUTTONUP
      // Capture local multiplayer smoke click sequences so recorded host/join paths can replay automatically.
      console.log(`[click-seq] ${downLParam & 0xffff},${(downLParam >>> 16) & 0xffff}`);
    }
    reportPress(downLParam, right ? 'right' : 'left', 'touch');
  };

  /** Map touch taps to ordinary left-click; long presses/two-finger gestures explicitly generate right-click. */
  const scheduleTapClick = (downLParam: number, modifiers: number) => {
    dispatchTapClick(downLParam, modifiers, false);
  };

  const on = <K extends keyof (HTMLElementEventMap & WindowEventMap)>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: (HTMLElementEventMap & WindowEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener as EventListener, options);
    removers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };

  const adaptResolution = (width: number, height: number): void => {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (width !== logicalFrameWidth || height !== logicalFrameHeight) {
      [logicalMouseX, logicalMouseY] = rescaleLogicalPointer(
        logicalMouseX,
        logicalMouseY,
        logicalFrameWidth,
        logicalFrameHeight,
        width,
        height,
      );
      logicalFrameWidth = width;
      logicalFrameHeight = height;
      cancelDesktopMove();
      const x = Math.floor(logicalMouseX);
      const y = Math.floor(logicalMouseY);
      lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
      // Do not wait for the next physical mousemove: after SetDisplayMode immediately synchronize rescaled coordinates
      // to the guest and host cursor layer so the locked cursor is not clamped to old 800x600 bounds.
      vm.setCursorPosition(x, y);
      onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    }
  };

  const updateMousePosition = (event: MouseEvent): [number, number] => {
    // Use the rect cache maintained by installCanvasFit to avoid layout reads on every mousemove.
    const rect = currentCanvasRect(canvas);
    // Map to guest logical coordinates independently of backing-store physical dimensions.
    const frame = getFrameSize();
    const width = frame.width;
    const height = frame.height;
    adaptResolution(width, height);
    if (document.pointerLockElement === canvas) {
      logicalMouseX = Math.max(0, Math.min(width - 1, logicalMouseX + (event.movementX * width) / (rect.width || 1)));
      logicalMouseY = Math.max(
        0,
        Math.min(height - 1, logicalMouseY + (event.movementY * height) / (rect.height || 1)),
      );
    } else {
      logicalMouseX = Math.max(0, Math.min(width - 1, ((event.clientX - rect.left) * width) / (rect.width || 1)));
      logicalMouseY = Math.max(0, Math.min(height - 1, ((event.clientY - rect.top) * height) / (rect.height || 1)));
    }
    return [Math.floor(logicalMouseX), Math.floor(logicalMouseY)];
  };
  const mousePosition = (event: MouseEvent): [number, number] => {
    const [x, y] = updateMousePosition(event);
    vm.setCursorPosition(x, y);
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    return [x, y];
  };
  const mouseLParam = (event: MouseEvent): number => {
    const [x, y] = mousePosition(event);
    lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    return lastMouseLParam;
  };
  const heldModifier = (genericVk: number): boolean => {
    for (const state of heldKeys.values()) {
      if (
        state.vk === genericVk ||
        (genericVk === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
        (genericVk === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3))
      )
        return true;
    }
    return false;
  };
  const modifierFlags = (event: MouseEvent): number => {
    // Some browsers briefly lose PointerEvent.ctrlKey/shiftKey during Pointer Lock;
    // heldKeys maintained by keyboard listeners is authoritative for the same input sequence. Take their union
    // so Ctrl+click reaches the original game with MK_CONTROL, required for force attack.
    return (
      mouseFlags |
      (event.shiftKey || heldModifier(0x10) ? 0x0004 : 0) |
      (event.ctrlKey || heldModifier(0x11) ? 0x0008 : 0)
    );
  };

  // Dispatch the first movement immediately to avoid an extra input frame of latency; coalesce subsequent high-frequency events at frame end.
  // Still accumulate relative movement per event; flush pending MOVE before DOWN/UP/WHEEL to preserve distance and order.
  const flushDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    const move = pendingDesktopMove;
    pendingDesktopMove = null;
    if (!move) return;
    vm.setCursorPosition(move.x, move.y);
    vm.postMessage(0x0200, move.wParam, move.lParam);
  };
  const scheduleDesktopMove = (event: PointerEvent) => {
    const [x, y] = updateMousePosition(event);
    const lParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    lastMouseLParam = lParam;
    // The local cursor follows input immediately, without waiting for the VM-message rAF coalescing window.
    // Send leading/trailing movements to the guest to avoid Worker-message buildup with high-polling-rate mice.
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    pendingDesktopMove = {
      x,
      y,
      lParam,
      wParam: modifierFlags(event),
    };
    if (desktopMoveFrame === null) {
      flushDesktopMove();
      desktopMoveFrame = requestAnimationFrame(() => {
        desktopMoveFrame = null;
        flushDesktopMove();
      });
    }
  };
  const cancelDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    pendingDesktopMove = null;
  };

  const pointerButton = (button: number) => {
    if (button === 0) return { down: 0x0201, up: 0x0202, flag: 0x0001, vk: 0x01 };
    if (button === 1) return { down: 0x0207, up: 0x0208, flag: 0x0010, vk: 0x04 };
    if (button === 2) return { down: 0x0204, up: 0x0205, flag: 0x0002, vk: 0x02 };
    return null;
  };

  const releaseMouseButtons = (lParam = lastMouseLParam) => {
    for (const button of [0, 1, 2]) {
      const info = pointerButton(button)!;
      if (!(mouseFlags & info.flag)) continue;
      mouseFlags &= ~info.flag;
      vm.setKeyState(info.vk, false);
      vm.postMessage(info.up, mouseFlags, lParam);
    }
  };

  const syncKeyState = (code: string, vk: number, down: boolean) => {
    vm.setKeyState(vk, down);
    const modifiers: Record<string, [number, number]> = {
      ShiftLeft: [0x10, 0xa0],
      ShiftRight: [0x10, 0xa1],
      ControlLeft: [0x11, 0xa2],
      ControlRight: [0x11, 0xa3],
      AltLeft: [0x12, 0xa4],
      AltRight: [0x12, 0xa5],
    };
    const pair = modifiers[code];
    if (!pair) return;
    const [generic, sided] = pair;
    vm.setKeyState(sided, down);
    const genericDown = [...heldKeys.keys()].some((heldCode) => modifiers[heldCode]?.[0] === generic);
    vm.setKeyState(generic, genericDown);
  };

  const reconcileMouseModifiers = (event: MouseEvent) => {
    const modifiers: Array<{ active: boolean; generic: number; code: string; scanCode: number }> = [
      { active: event.shiftKey, generic: 0x10, code: 'ShiftLeft', scanCode: 0x2a },
      { active: event.ctrlKey, generic: 0x11, code: 'ControlLeft', scanCode: 0x1d },
    ];
    for (const modifier of modifiers) {
      if (!modifier.active) continue;
      const alreadyForwarded = [...heldKeys.values()].some(
        (state) =>
          state.vk === modifier.generic ||
          (modifier.generic === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
          (modifier.generic === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3)),
      );
      if (alreadyForwarded) continue;
      heldKeys.set(modifier.code, { vk: modifier.generic, system: false });
      reconciledModifiers.set(modifier.generic, modifier.code);
      syncKeyState(modifier.code, modifier.generic, true);
      vm.postMessage(0x0100, modifier.generic, 1 | (modifier.scanCode << 16)); // WM_KEYDOWN
    }
  };

  const releaseKeys = () => {
    for (const [code, state] of heldKeys) {
      heldKeys.delete(code);
      syncKeyState(code, state.vk, false);
      vm.postMessage(state.system ? 0x0105 : 0x0101, state.vk, 0xc000_0001);
    }
    reconciledModifiers.clear();
  };

  const clearTouchTimer = () => {
    if (touchGesture) window.clearTimeout(touchGesture.timer);
  };

  /** Unified cleanup for all touch cancellation paths: send UP as required by the current phase and leave no fingerless timers running. */
  const cancelTouchGesture = (lParam = lastMouseLParam) => {
    const state = touchGesture;
    if (!state) return;
    clearTouchTimer();
    touchGesture = null;
    if (state.phase === 'drag') {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, state.modifiers, lParam);
    } else if (state.phase === 'right' || state.phase === 'two-drag') {
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, state.modifiers, lParam);
    }
    // pending / two-pending phases have sent no button down and need no compensating up.
  };

  const touchHoldTimer = () => {
    const state = touchGesture;
    if (!state || state.phase !== 'pending') return;
    state.phase = 'right';
    mouseFlags |= 0x0002;
    vm.setKeyState(0x02, true);
    vm.postMessage(0x0204, state.modifiers | 0x0002, state.downLParam); // WM_RBUTTONDOWN
    reportPress(state.downLParam, 'right', 'touch');
    if (typeof navigator.vibrate === 'function') navigator.vibrate(40);
  };

  const handleTouchPointerDown = (event: PointerEvent) => {
    // On hybrid devices the expanded controls may cover the left touch area; collapse them on contact with the game.
    setControlsCollapsed(true);
    canvas.focus({ preventScroll: true });
    activeTouches.add(event.pointerId);
    const state = touchGesture;
    if (!state) {
      // First finger starts a single-finger gesture; require all other fingers released before starting another to avoid residual contacts.
      if (activeTouches.size !== 1) {
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      const x = lParam & 0xffff;
      const y = (lParam >>> 16) & 0xffff;
      touchGesture = {
        pointerId: event.pointerId,
        phase: 'pending',
        downX: x,
        downY: y,
        downLParam: lParam,
        downClientX: event.clientX,
        downClientY: event.clientY,
        twoClientX: 0,
        twoClientY: 0,
        modifiers: modifierFlags(event),
        timer: window.setTimeout(touchHoldTimer, TOUCH_LONG_PRESS_MS),
      };
    } else if (state.phase === 'pending') {
      // Second finger: cancel long-press/tap intent and upgrade to a two-finger gesture.
      clearTouchTimer();
      state.phase = 'two-pending';
      state.twoClientX = state.downClientX;
      state.twoClientY = state.downClientY;
    }
    // Ignore extra fingers after single-finger drag/right or during two-finger phases.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The browser may have canceled the pointer before delivery; pointercancel performs unified cleanup.
    }
    event.preventDefault();
  };

  const handleTouchPointerMove = (event: PointerEvent) => {
    const state = touchGesture;
    if (!state) return;
    const rect = currentCanvasRect(canvas);
    const slopCss = Math.max(3, (5 * (rect.width || 1)) / getFrameSize().width);
    if (state.phase === 'pending') {
      if (event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.downClientX;
      const dy = event.clientY - state.downClientY;
      // Express the threshold in game pixels, about 5px, independently of canvas CSS scale; avoid false drags when enlarged
      // and sluggish gestures when reduced or on phones.
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      // Beyond the drag threshold, send left DOWN at the contact origin; the common path has already sent this WM_MOUSEMOVE.
      clearTouchTimer();
      state.phase = 'drag';
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, state.modifiers | 0x0001, state.downLParam); // WM_LBUTTONDOWN
      reportPress(state.downLParam, 'left', 'touch');
      return;
    }
    if (state.phase === 'two-pending') {
      // If either finger exceeds the movement threshold, press right to begin panning. The cursor is already at the primary finger
      // through the common path; subsequent movement invokes native right-drag map scrolling.
      const dx = event.clientX - state.twoClientX;
      const dy = event.clientY - state.twoClientY;
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      state.phase = 'two-drag';
      const lParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, state.modifiers | 0x0002, lParam); // WM_RBUTTONDOWN
      reportPress(lParam, 'right', 'touch');
      if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
      return;
    }
    // In drag/right/two-drag phases, the common path and cleanup logic handle cursor and button state.
  };

  const handleTouchPointerUp = (event: PointerEvent) => {
    activeTouches.delete(event.pointerId);
    const state = touchGesture;
    if (!state) return;
    const single = state.phase === 'pending' || state.phase === 'drag' || state.phase === 'right';
    if (single) {
      if (event.pointerId !== state.pointerId) return;
      clearTouchTimer();
      // Clear state before releasing capture; lostpointercapture then sees an empty gesture and cannot clean up twice.
      touchGesture = null;
      const upLParam = mouseLParam(event);
      const modifiers = modifierFlags(event);
      if (state.phase === 'pending') {
        // Match desktop click sequences: MOVE/DOWN/UP all use the contact origin. Small finger movement must not
        // turn a tap into a drag; otherwise the game sees different start/end positions,
        // moves only the cursor, and ignores the click. Double taps likewise send a complete second physical click.
        vm.postMessage(0x0200, modifiers, state.downLParam); // Return the cursor to the contact origin.
        // Mobile adaptation: move to the target, read memory to confirm cursor shape, then press the button;
        // attack/move destinations use right-click, while empty ground, friendly units, and UI use left-click.
        scheduleTapClick(state.downLParam, modifiers);
      } else if (state.phase === 'drag') {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifiers, upLParam);
      } else {
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam);
      }
    } else {
      // In two-finger mode, release either finger to finish.
      clearTouchTimer();
      touchGesture = null;
      if (state.phase === 'two-pending') {
        // Two-finger tap means right-click: MOVE/RDOWN/RUP all use the primary contact origin, matching trackpads.
        const modifiers = modifierFlags(event);
        vm.postMessage(0x0200, modifiers, state.downLParam);
        vm.postMessage(0x0204, modifiers | 0x0002, state.downLParam);
        vm.postMessage(0x0205, modifiers, state.downLParam);
        reportPress(state.downLParam, 'right', 'touch');
      } else {
        // two-drag ends panning: release right-click and leave the cursor at the primary finger, even if the secondary finger was released.
        const modifiers = modifierFlags(event);
        const upLParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
        vm.postMessage(0x0200, modifiers, upLParam);
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam); // WM_RBUTTONUP
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };

  const releaseInput = () => {
    lockAfterPointerUp = false;
    compatibilityCtrlPrimaryActive = false;
    cancelDesktopMove();
    cancelTouchGesture();
    cancelShiftBurst();
    releaseMouseButtons();
    releaseKeys();
    mouseFlags = 0;
  };

  const requestMouseLock = async () => {
    if (pointerLockPending || document.pointerLockElement === canvas) return;
    pointerLockPending = true;
    try {
      // Windows Chromium does not allow the same pointer in Pointer Capture and Pointer Lock simultaneously.
      // The initial locking click releases capture before pointerup; locked events remain directed to the canvas.
      // Request unadjustedMovement only when raw counts are explicitly enabled; if the platform rejects it,
      // retry without options because ordinary pointer locking remains available.
      try {
        await canvas.requestPointerLock(rawMouse ? { unadjustedMovement: true } : undefined);
      } catch (error) {
        if (!rawMouse || !(error instanceof DOMException)) throw error;
        await canvas.requestPointerLock();
      }
    } catch (error) {
      console.warn(t('[VM input] 浏览器拒绝鼠标锁定'), error);
    } finally {
      pointerLockPending = false;
    }
  };

  const finishDesktopPointerUp = (event: PointerEvent, desktopMouse: boolean) => {
    if (!mouseFlags && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!desktopMouse || mouseFlags || !lockAfterPointerUp) return;
    lockAfterPointerUp = false;
    if (document.pointerLockElement === canvas) return;
    // releasePointerCapture must precede Pointer Lock; the call is still inside the trusted pointerup
    // user gesture, so Chromium permits acquiring the lock.
    void requestMouseLock();
  };

  on(
    canvas,
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') {
        // Every finger enters the gesture machine, since either may trigger a two-finger drag; only the primary finger uses the common path
        // to send WM_MOUSEMOVE. During two-finger panning, the edge-cursor timer instead
        // drives position here, avoiding movement that conflicts with the panning direction.
        // The cursor always follows the primary finger; two-finger drags hold right-click so the map pans with it.
        if (event.isPrimary) vm.postMessage(0x0200, modifierFlags(event), mouseLParam(event));
        handleTouchPointerMove(event);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      scheduleDesktopMove(event);
      if (mouseFlags || event.pointerType !== 'mouse') event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerdown',
    (event) => {
      // Every touch finger enters the gesture machine; the second upgrades to a two-finger gesture.
      if (event.pointerType === 'touch') {
        handleTouchPointerDown(event);
        return;
      }
      if (!event.isPrimary) return;
      const controlDown = event.ctrlKey || heldModifier(0x11);
      const button = normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons);
      const info = pointerButton(button);
      if (!info) return;
      normalizedPointerButtons.set(event.pointerId, button);
      flushDesktopMove();
      canvas.focus({ preventScroll: true });
      reconcileMouseModifiers(event);
      const lParam = mouseLParam(event);
      if (button === 0 && controlDown) {
        lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
      }
      const desktopMouse = event.pointerType === 'mouse';
      if (lockDesktopMouse && desktopMouse && document.pointerLockElement !== canvas) lockAfterPointerUp = true;
      mouseFlags |= info.flag;
      vm.setKeyState(info.vk, true);
      if (desktopMouse && info.vk === 0x01 && event.shiftKey) {
        startShiftBurst(lParam, modifierFlags(event));
      } else {
        vm.postMessage(info.down, modifierFlags(event), lParam);
      }
      reportPress(
        lParam,
        button === 2 ? 'right' : button === 1 ? 'middle' : 'left',
        event.pointerType === 'pen' ? 'pen' : 'mouse',
      );
      // Always capture before locking so the initial pointerup returns to the same canvas before Pointer Lock;
      // after locking, events already remain directed to the canvas.
      if (!desktopMouse || document.pointerLockElement !== canvas) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // The browser may have canceled the pointer before delivery; later pointercancel releases state consistently.
        }
      }
      event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerup',
    (event) => {
      // Every touch finger must enter the gesture machine; the secondary finger may finish a two-finger gesture.
      if (event.pointerType === 'touch') {
        handleTouchPointerUp(event);
        return;
      }
      if (!event.isPrimary) return;
      const button =
        normalizedPointerButtons.get(event.pointerId) ??
        normalizePointerButton(event.button, event.ctrlKey || heldModifier(0x11), hostPlatform, event.buttons);
      normalizedPointerButtons.delete(event.pointerId);
      const info = pointerButton(button);
      if (!info) return;
      flushDesktopMove();
      const desktopMouse = event.pointerType === 'mouse';
      if (info.vk === 0x01 && shiftBurstTimer !== null) {
        // During Shift-repeat, the repeater already sends each down/up pair; physical up only clears state without another event.
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        finishDesktopPointerUp(event, desktopMouse);
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      // blur/releaseInput may already have sent UP; dispatch only for buttons still recorded as held.
      if ((mouseFlags & info.flag) !== 0) {
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        vm.postMessage(info.up, modifierFlags(event), lParam);
      }
      // With multiple mouse buttons, Pointer Events guarantee only the first pointerdown and final pointerup;
      // the last released event.button may differ from the initially recorded button, so use buttons=0 for unified cleanup.
      if (event.buttons === 0) releaseMouseButtons(lParam);
      finishDesktopPointerUp(event, desktopMouse);
      event.preventDefault();
    },
    { passive: false },
  );
  // macOS Edge may downgrade Ctrl+primary entirely to compatibility MouseEvents, with no corresponding
  // PointerEvent. Normal PointerEvent handling records lastCtrlPrimaryDispatch first,
  // so supplement only when absent to avoid duplicate DOWN/UP on other browsers.
  on(canvas, 'mousedown', (event) => {
    const controlDown = event.ctrlKey || heldModifier(0x11);
    if (!controlDown || normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 250 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      event.preventDefault();
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    mouseFlags |= 0x0001;
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifierFlags(event), lParam);
    reportPress(lParam, 'left', 'mouse');
    compatibilityCtrlPrimaryActive = true;
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
    event.preventDefault();
  });
  on(canvas, 'mouseup', (event) => {
    if (!compatibilityCtrlPrimaryActive) return;
    compatibilityCtrlPrimaryActive = false;
    const lParam = mouseLParam(event);
    if ((mouseFlags & 0x0001) !== 0) {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifierFlags(event), lParam);
    }
    event.preventDefault();
  });
  on(
    canvas,
    'pointercancel',
    (event) => {
      if (event.pointerType === 'touch') {
        activeTouches.delete(event.pointerId);
        cancelTouchGesture(mouseLParam(event));
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      normalizedPointerButtons.delete(event.pointerId);
      lockAfterPointerUp = false;
      cancelShiftBurst();
      flushDesktopMove();
      releaseMouseButtons(mouseLParam(event));
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'lostpointercapture', (event) => {
    // Cancel pending touch timers here, or a right-click could fire after every finger has left.
    if (touchGesture && event.pointerId === touchGesture.pointerId) cancelTouchGesture();
    // Pointer Lock actively ends capture; this does not mean the player released the button.
    if (document.pointerLockElement !== canvas) releaseMouseButtons();
  });
  on(canvas, 'dblclick', (event) => {
    // USER32 already generates Win32 double-clicks from two physical clicks and class styles; suppress only browser defaults here.
    event.preventDefault();
  });
  on(
    canvas,
    'wheel',
    (event) => {
      if (!event.deltaY) return;
      flushDesktopMove();
      const delta = event.deltaY < 0 ? 120 : -120;
      const wParam = ((delta & 0xffff) << 16) | modifierFlags(event);
      vm.postMessage(0x020a, wParam, mouseLParam(event));
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'contextmenu', (event) => {
    event.preventDefault();
    // macOS/WebKit may promote Ctrl+primary directly to contextmenu without a usable
    // left pointerdown. Deduplicate by position/time when the normal pointer path already dispatched it.
    if (!event.ctrlKey || normalizePointerButton(2, true, hostPlatform) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 1_000 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      // Edge/macOS may omit pointerup after showing contextmenu following DOWN.
      // Send the missing UP immediately; a later physical pointerup is skipped because mouseFlags is already cleared.
      if ((mouseFlags & 0x0001) !== 0) {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifierFlags(event), lParam);
      }
      compatibilityCtrlPrimaryActive = false;
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    const modifiers = modifierFlags(event);
    vm.postMessage(0x0200, modifiers, lParam); // WM_MOUSEMOVE
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifiers | 0x0001, lParam); // WM_LBUTTONDOWN
    reportPress(lParam, 'left', 'mouse');
    vm.setKeyState(0x01, false);
    vm.postMessage(0x0202, modifiers, lParam); // WM_LBUTTONUP
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
  });
  on(canvas, 'dragstart', (event) => event.preventDefault());
  on(canvas, 'auxclick', (event) => event.preventDefault());

  on(
    window,
    'keydown',
    (event) => {
      // Page shortcuts (` debug / [ ] speed / F11 fullscreen / ? help) are not injected into the game.
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      if (document.activeElement !== canvas || event.isComposing) return;
      const vk = virtualKey(event);
      if (!vk) return;
      const wasDown = heldKeys.has(event.code);
      const system = event.altKey || event.code === 'AltLeft' || event.code === 'AltRight';
      heldKeys.set(event.code, { vk, system });
      syncKeyState(event.code, vk, true);
      const lParam = keyLParam(event, false, wasDown);
      vm.postMessage(system ? 0x0104 : 0x0100, vk, lParam); // WM_SYSKEYDOWN / WM_KEYDOWN
      const character = win32CharacterCode(event);
      if (character !== null) vm.postMessage(0x0102, character, lParam); // WM_CHAR
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(
    window,
    'keyup',
    (event) => {
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      const genericModifier =
        event.code === 'ShiftLeft' || event.code === 'ShiftRight'
          ? 0x10
          : event.code === 'ControlLeft' || event.code === 'ControlRight'
            ? 0x11
            : 0;
      const reconciledCode = genericModifier ? reconciledModifiers.get(genericModifier) : undefined;
      const state = heldKeys.get(event.code) ?? (reconciledCode ? heldKeys.get(reconciledCode) : undefined);
      if (document.activeElement !== canvas && !state) return;
      const vk = state?.vk ?? virtualKey(event);
      if (!vk) return;
      const system = state?.system || event.altKey || event.code === 'AltLeft' || event.code === 'AltRight';
      if (reconciledCode) {
        heldKeys.delete(reconciledCode);
        reconciledModifiers.delete(genericModifier);
        syncKeyState(reconciledCode, genericModifier, false);
      }
      heldKeys.delete(event.code);
      syncKeyState(event.code, vk, false);
      vm.postMessage(system ? 0x0105 : 0x0101, vk, keyLParam(event, true, true)); // WM_SYSKEYUP / WM_KEYUP
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(canvas, 'blur', releaseInput);
  on(window, 'blur', releaseInput);
  on(window, 'resize', releaseInput);
  const visibilityChanged = () => {
    if (document.hidden) releaseInput();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  removers.push(() => document.removeEventListener('visibilitychange', visibilityChanged));

  // Pointer-lock effect: an amber outer border and four viewfinder corners pulse while locked
  // (#screen-frame.pointer-locked), with a temporary top hint to press Esc to unlock.
  // The hint fades after a few seconds; the border/corners remain because the browser hides the cursor.
  const lockHint = document.createElement('div');
  lockHint.className = 'pointer-lock-hint';
  canvas.parentElement?.appendChild(lockHint);
  removers.push(() => lockHint.remove());
  let keyboardLockState: KeyboardLockState = 'inactive';
  const showLockHint = () => {
    lockHint.textContent =
      keyboardLockState === 'active'
        ? t('Esc 已交给游戏 · 长按 Esc 退出锁定 · F11 退出全屏')
        : keyboardLockState === 'pending'
          ? t('正在申请 Esc 捕获权限…')
          : keyboardLockState === 'unavailable'
            ? t('浏览器不支持 Esc 捕获，Esc 仍由浏览器优先处理')
            : keyboardLockState === 'denied'
              ? t('Esc 捕获未获授权，Esc 仍由浏览器优先处理')
              : t('鼠标已锁定 · Esc 解锁 · 全屏可申请将 Esc 交给游戏');
    lockHint.classList.remove('show');
    void lockHint.offsetWidth;
    lockHint.classList.add('show');
  };
  removers.push(
    installFullscreenKeyboardLock(canvas, (state) => {
      keyboardLockState = state;
      if (state !== 'inactive' || document.pointerLockElement === canvas) showLockHint();
      else lockHint.classList.remove('show');
    }),
  );

  const pointerLockChanged = () => {
    if (document.pointerLockElement === canvas) {
      // Toolbar collapse, resolution changes, and canvas fitting may occur in one layout cycle without a stage ResizeObserver
      // callback. Read the actual CSS box before Pointer Lock switches from absolute to relative coordinates,
      // avoiding stale 800x600/height ratios that slow edge movement and prevent reaching the boundary.
      refreshCanvasRect(canvas);
      lockAfterPointerUp = false;
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), true);
      canvas.focus({ preventScroll: true });
      canvas.parentElement?.classList.add('pointer-locked');
      showLockHint();
    } else {
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), false);
      cancelTouchGesture();
      releaseMouseButtons();
      canvas.parentElement?.classList.remove('pointer-locked');
      lockHint.classList.remove('show');
      // Tab switching, blur, and script exits also release Pointer Lock; never infer that the user pressed Esc.
      // Game keystrokes come only from real keyboard events; fullscreen Keyboard Lock captures Esc.
    }
  };
  document.addEventListener('pointerlockchange', pointerLockChanged);
  removers.push(() => document.removeEventListener('pointerlockchange', pointerLockChanged));

  return {
    adaptResolution,
    cleanup() {
      releaseInput();
      removers.splice(0).forEach((remove) => remove());
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    },
  };
}
