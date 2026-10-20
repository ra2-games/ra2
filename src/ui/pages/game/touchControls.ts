import { syntheticKeyStroke, type KeyStrokeTarget } from './input';

/**
 * Touch virtual-key toolbar: Esc/Enter/Space/arrows plus collapse toggle.
 *
 * React owns the control nodes; this adapter owns input listeners and held keys.
 * Persist collapse state in localStorage and retain the keyboard toggle for reopening.
 */

const STORAGE_KEY = 'ra2-vm-touch-controls-hidden';

/** Show touch controls based on actual canvas input; device capability alone does not mean the player is using touch. */
export function installAdaptiveTouchControls(canvas: HTMLElement, vm: KeyStrokeTarget): () => void {
  let cleanupTouch: (() => void) | undefined;
  const hide = () => {
    cleanupTouch?.();
    cleanupTouch = undefined;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') cleanupTouch ??= installTouchControls(vm);
    else if (event.pointerType === 'mouse') hide();
  };
  const onPointerMove = (event: PointerEvent) => {
    // Zero-movement re-hit events are not mouse activity; avoid hiding newly shown keys after layout changes.
    if (event.pointerType === 'mouse' && (event.movementX || event.movementY)) hide();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    hide();
  };
}

export function installTouchControls(vm: KeyStrokeTarget): () => void {
  const container = document.getElementById('vm-touch-controls') as HTMLElement | null;
  if (!container) return () => {};
  container.hidden = false;

  const keys = [...container.querySelectorAll<HTMLButtonElement>('[data-code]')];
  const collapse = container.querySelector<HTMLButtonElement>('[data-role="collapse"]');
  const held = new Map<number, string>();
  const removers: Array<() => void> = [];

  const on = <K extends keyof (HTMLElementEventMap & WindowEventMap & DocumentEventMap)>(
    target: EventTarget,
    type: K,
    listener: (event: (HTMLElementEventMap & WindowEventMap & DocumentEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener as EventListener, options);
    removers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };

  const releaseAll = () => {
    for (const [pointerId, code] of held) {
      held.delete(pointerId);
      syntheticKeyStroke(vm, code, false);
    }
  };
  const releasePointer = (pointerId: number) => {
    const code = held.get(pointerId);
    if (code === undefined) return;
    held.delete(pointerId);
    syntheticKeyStroke(vm, code, false);
  };

  const setCollapsed = (collapsed: boolean) => {
    container.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '');
    } catch {
      // When localStorage is unavailable, as in private mode, collapse state lasts only for this session.
    }
  };
  let initialCollapsed = false;
  try {
    initialCollapsed = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // When localStorage is unavailable, as in private mode, collapse state lasts only for this session.
  }
  setCollapsed(initialCollapsed);
  if (collapse) {
    on(collapse, 'click', () => {
      setCollapsed(!container.classList.contains('collapsed'));
    });
  }

  for (const key of keys) {
    const code = key.dataset.code!;
    key.type = 'button';
    on(
      key,
      'pointerdown',
      (event) => {
        event.preventDefault();
        // Capture subsequent pointer events on the key; the browser releases capture automatically on pointerup.
        try {
          key.setPointerCapture(event.pointerId);
        } catch {
          // The browser may already have canceled the pointer; pointercancel provides fallback release.
        }
        held.set(event.pointerId, code);
        syntheticKeyStroke(vm, code, true);
      },
      { passive: false },
    );
    const release = (event: PointerEvent) => releasePointer(event.pointerId);
    on(key, 'pointerup', release);
    on(key, 'pointercancel', release);
    on(key, 'lostpointercapture', release);
  }

  // Prevent stuck guest keys after backgrounding/blur, matching page.ts releaseInput semantics.
  on(window, 'blur', releaseAll);
  on(window, 'resize', releaseAll);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAll();
  });

  // Virtual joystick: a transparent floating layer independent of the key toolbar, consuming no layout space or game area.
  // Tilting holds the corresponding arrow keys and repeats keydown frequently; the original game scrolls one step per keydown,
  // so repetition produces smooth scrolling without moving the cursor or triggering selection/drag detection.
  const joystick = document.getElementById('vm-touch-joystick') as HTMLButtonElement | null;
  const knob = joystick?.querySelector<HTMLSpanElement>('.joystick-knob');
  if (joystick && knob) {
    joystick.hidden = false;
    const RADIUS = 34; // Maximum joystick displacement in pixels.
    const DEAD = 10; // Dead zone: smaller displacement activates no direction.
    const REPEAT_MS = 50; // keydown repeat interval while holding a direction: 20 times per second.
    let joystickPointer = -1;
    let heldCodes: readonly string[] = [];
    let repeatTimer: number | undefined;

    const directionFor = (dx: number, dy: number): readonly string[] => {
      if (Math.hypot(dx, dy) < DEAD) return [];
      const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // Right=0; sectors advance clockwise every 45 degrees.
      const sectors: ReadonlyArray<readonly string[]> = [
        ['ArrowRight'],
        ['ArrowRight', 'ArrowDown'],
        ['ArrowDown'],
        ['ArrowLeft', 'ArrowDown'],
        ['ArrowLeft'],
        ['ArrowLeft', 'ArrowUp'],
        ['ArrowUp'],
        ['ArrowRight', 'ArrowUp'],
      ];
      return sectors[((sector % 8) + 8) % 8]!;
    };

    const stopHeld = () => {
      if (repeatTimer !== undefined) {
        window.clearInterval(repeatTimer);
        repeatTimer = undefined;
      }
      for (const code of heldCodes) syntheticKeyStroke(vm, code, false);
      heldCodes = [];
    };
    const startHeld = (codes: readonly string[]) => {
      heldCodes = codes;
      for (const code of codes) syntheticKeyStroke(vm, code, true);
      repeatTimer = window.setInterval(() => {
        for (const code of heldCodes) syntheticKeyStroke(vm, code, true);
      }, REPEAT_MS);
    };
    const applyDirection = (codes: readonly string[]) => {
      const key = codes.join('+');
      if (heldCodes.join('+') === key) return;
      stopHeld();
      if (codes.length) startHeld(codes);
    };
    const resetJoystick = () => {
      joystickPointer = -1;
      stopHeld();
      knob.style.transform = 'translate(0px, 0px)';
    };

    on(joystick, 'pointerdown', (event) => {
      event.preventDefault();
      joystickPointer = event.pointerId;
      try {
        joystick.setPointerCapture(event.pointerId);
      } catch {
        // The browser may already have canceled the pointer; pointercancel resets state.
      }
    });
    const track = (event: PointerEvent) => {
      if (event.pointerId !== joystickPointer) return;
      const rect = joystick.getBoundingClientRect();
      let dx = event.clientX - (rect.left + rect.width / 2);
      let dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance > RADIUS) {
        dx = (dx * RADIUS) / distance;
        dy = (dy * RADIUS) / distance;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      applyDirection(directionFor(dx, dy));
      event.preventDefault();
    };
    on(joystick, 'pointermove', track, { passive: false });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== joystickPointer) return;
      resetJoystick();
    };
    on(joystick, 'pointerup', release);
    on(joystick, 'pointercancel', release);
    on(joystick, 'lostpointercapture', release);

    // Stop panning and reset the cursor on collapse/backgrounding; never leave scrolling active without a finger.
    on(window, 'blur', resetJoystick);
    on(window, 'resize', resetJoystick);
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') resetJoystick();
    });
    removers.push(resetJoystick);
  }

  return () => {
    releaseAll();
    removers.splice(0).forEach((remove) => remove());
    container.hidden = true;
    if (joystick) joystick.hidden = true;
  };
}
