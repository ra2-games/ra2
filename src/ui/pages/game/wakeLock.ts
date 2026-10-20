/**
 * Keep the screen awake while the VM runs: Android Chrome, and iOS home-screen PWA only.
 * The browser releases the lock in background tabs; request it again when visible.
 * Desktop Chrome without wakeLock is a no-op.
 */
export function installWakeLock(): () => void {
  if (!('wakeLock' in navigator)) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let released = false;

  const request = (): void => {
    if (released || sentinel || document.visibilityState !== 'visible') return;
    void navigator.wakeLock
      .request('screen')
      .then((lock) => {
        if (released) {
          void lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      })
      .catch(() => {
        // The page is inactive or browser policy denied the request; retry on the next visibilitychange.
      });
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') request();
  };

  request();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    const lock = sentinel;
    sentinel = null;
    void lock?.release();
  };
}
