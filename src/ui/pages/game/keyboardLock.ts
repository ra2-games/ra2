export type KeyboardLockState = 'inactive' | 'pending' | 'active' | 'unavailable' | 'denied';

interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}

let controllerGeneration = 0;

/** Capture real Esc only during game fullscreen; unlock events do not identify a source key and must never synthesize Esc. */
export function installFullscreenKeyboardLock(
  canvas: HTMLCanvasElement,
  report: (state: KeyboardLockState) => void,
): () => void {
  const generation = ++controllerGeneration;
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  let revision = 0;
  let disposed = false;
  const isFullscreen = () => !!document.fullscreenElement?.contains(canvas);
  const changed = () => {
    if (generation !== controllerGeneration) return;
    const request = ++revision;
    if (!isFullscreen()) {
      keyboard?.unlock?.();
      report('inactive');
      return;
    }
    if (!keyboard?.lock || !keyboard.unlock) {
      report('unavailable');
      return;
    }
    report('pending');
    void (async () => {
      try {
        await keyboard.lock(['Escape']);
        // A previous VM's permission result must not unlock the new VM's keyboard after switching games.
        if (generation !== controllerGeneration) return;
        // Permission dialogs may finish after fullscreen exit or VM destruction; leave no keyboard lock behind.
        // Old requests must not unlock newer fullscreen requests either.
        if (disposed || !isFullscreen()) keyboard.unlock();
        else if (revision === request) report('active');
      } catch {
        if (generation === controllerGeneration && !disposed && revision === request && isFullscreen())
          report('denied');
      }
    })();
  };
  document.addEventListener('fullscreenchange', changed);
  changed();
  return () => {
    disposed = true;
    revision++;
    document.removeEventListener('fullscreenchange', changed);
    if (generation === controllerGeneration) keyboard?.unlock?.();
  };
}
