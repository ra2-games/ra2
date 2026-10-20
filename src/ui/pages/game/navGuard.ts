import { t } from '../../shared/i18n/translate';
/**
 * Navigation guard against accidental browser back/forward during gameplay.
 *
 * Cover three sources:
 * - Mouse side buttons XButton1/XButton2, easily pressed while gaming and mapped to browser back/forward.
 * - Alt+Left / Alt+Right / Alt+Home, outside page.ts interception when the canvas lacks focus.
 * - A history trap keeping browser navigation buttons, trackpad back swipes, and Android Back on this page.
 *
 * Edge mouse gestures, where right-drag triggers back/forward and newer versions enable them by default, are browser-level behavior. Neither preventDefault nor Pointer Lock can suppress them; they can intercept map dragging. Users must disable them in edge://settings/appearance or add the site to their blocklist; see the notice below.
 *
 * Install once for the page lifetime, not on every VM restart. Disable for development with ?nav-guard=0, following the same 0/1 convention as ?fast-files=0. iOS Safari edge-back swipes cannot be controlled by the page; the trap only reduces unintended navigation and cannot fully disable them.
 */
export function installNavigationGuard(): () => void {
  if (new URLSearchParams(window.location.search).get('nav-guard') === '0') return () => {};

  // Edge gesture diagnostic: the page cannot detect when browser gestures take over because events never reach it,
  // so show one static notice explaining how players can disable them.
  if (navigator.userAgent.includes('Edg/')) {
    console.warn(
      t(
        '[导航护栏] 检测到 Edge：若右键拖动触发后退/前进，请在 edge://settings/appearance 关闭「鼠标手势」，或把本站加入「配置鼠标手势 → 阻止列表」（该手势是浏览器层行为，网页无法禁用）。',
      ),
    );
  }

  // 1. Mouse side buttons: XButton1=back(3), XButton2=forward(4). Chromium browsers such as Edge/Chrome
  // decide navigation on mouseup, so preventDefault cancels it; mousedown/auxclick cover other paths
  // (older Chromium allows mousedown cancellation, and auxclick suppresses other defaults).
  // Capture intercepts before other handlers in all regions, including canvas, toolbar, and borders.
  const blockMouseNavigation = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  window.addEventListener('mousedown', blockMouseNavigation, { capture: true });
  window.addEventListener('mouseup', blockMouseNavigation, { capture: true });
  window.addEventListener('auxclick', blockMouseNavigation, { capture: true });

  // 2. Keyboard navigation shortcuts: page.ts intercepts and forwards keys only when the canvas is focused;
  // suppress browser defaults here regardless of focus without blocking VM forwarding.
  const blockKeyboardNavigation = (event: KeyboardEvent): void => {
    if (!event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home') event.preventDefault();
  };
  window.addEventListener('keydown', blockKeyboardNavigation, { capture: true });

  // 3. History trap: add a same-URL history entry; on popstate from back/forward,
  // immediately replace the removed layer, keeping the page in place without growing history.
  // Sandboxed iframes and similar environments may deny pushState; other guard components still work.
  const guardState = { ra2VmNavGuard: true };
  const repush = (): void => {
    try {
      history.pushState(guardState, '');
    } catch {
      // If pushState is denied, abandon only the history trap; retain other protections.
    }
  };
  try {
    // On refresh/bfcache restoration, an already guarded entry needs replacement only, avoiding one extra layer per refresh.
    const prior = history.state as { ra2VmNavGuard?: boolean } | null;
    history.replaceState(guardState, '');
    if (!prior?.ra2VmNavGuard) history.pushState(guardState, '');
    window.addEventListener('popstate', repush);
  } catch {
    // If replaceState/pushState is denied, add no history layer; retain mouse/keyboard guards.
  }

  return () => {
    window.removeEventListener('mousedown', blockMouseNavigation, true);
    window.removeEventListener('mouseup', blockMouseNavigation, true);
    window.removeEventListener('auxclick', blockMouseNavigation, true);
    window.removeEventListener('keydown', blockKeyboardNavigation, true);
    window.removeEventListener('popstate', repush);
  };
}
