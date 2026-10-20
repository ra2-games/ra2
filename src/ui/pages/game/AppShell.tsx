import { t } from '../../shared/i18n/translate';
import { useEffect, useRef } from 'react';
import { BootRegion, DebugRegion, Dialogs, MainRegion, ScreenStatus, Toolbar } from './components/AppRegions';
import { bootState, gameRunning, mainPanel, sourceRequest, gameMenuRequest } from './state/uiState';
import { useStore } from '../../shared/state/useStore';
import { usePanelWheelAcceleration } from './hooks/usePanelWheelAcceleration';
import { AgentConnection } from './components/AgentConnection';
import { recordOperationIssue } from '../../../platform/browser/operationMonitoring';
import { Ra2ConsoleArtwork } from './components/ra2menu/Ra2ConsoleArtwork';

function LandscapeNotice({ id }: { id: string }) {
  return (
    <div id={id} className="landscape-notice" role="status">
      <p className="ea-notice landscape-ea-notice" lang="en">
        EA has not endorsed and does not support this product.
      </p>
      <div className="landscape-notice-content">
        <div className="landscape-notice-icon" aria-hidden="true">
          <svg viewBox="0 0 80 80" fill="none" focusable="false">
            <rect x="17" y="29" width="46" height="27" rx="5" />
            <path d="M56 39v7M25 20a24 24 0 0 1 36 3M61 14v9h-9" />
          </svg>
        </div>
        <h1>{t('转至横屏，立即开玩')}</h1>
        <p className="landscape-notice-description">{t('请将手机横向放置，以获得更好的游戏体验。')}</p>
        <p className="landscape-notice-hint">{t('旋转屏幕后即可继续')}</p>
      </div>
    </div>
  );
}

/** One React tree owns all page UI; refs only form the boundary to VM graphics/input adapters. */
export function AppShell() {
  usePanelWheelAcceleration();
  const running = useStore(gameRunning);
  const booting = useStore(bootState) !== null;
  const choosingSource = useStore(sourceRequest) !== null;
  const choosingLaunch = useStore(gameMenuRequest) !== null;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('./page')
      .then((runtime) => {
        if (cancelled) return;
        stop = runtime.stopVmPage;
        return runtime.startVmPage(canvas.current!);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') {
          recordOperationIssue('startup', undefined, error, { phase: 'error' });
          stop?.();
          mainPanel.set({ phase: 'error', detail: String(error) });
        }
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return (
    <div className={choosingSource || booting || choosingLaunch ? 'game-home' : running ? 'game-running' : undefined}>
      <LandscapeNotice id="landscape-notice" />
      <Toolbar />
      <AgentConnection />
      <div id="app-layout">
        <div id="stage">
          <div id="screen-frame">
            <canvas ref={canvas} id="screen" width="800" height="600"></canvas>
            <ScreenStatus />
            <LandscapeNotice id="landscape-fullscreen-notice" />
            <span className="lock-corner lock-corner-tl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-tr" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-bl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-br" aria-hidden="true"></span>
            <div id="client-page" aria-hidden="true">
              <Ra2ConsoleArtwork />
            </div>
          </div>
          <BootRegion />
        </div>
        <DebugRegion />
      </div>
      <div id="vm-touch-controls" hidden aria-label={t('触屏虚拟按键')}>
        <button className="touch-key touch-collapse" type="button" data-role="collapse" aria-label={t('折叠虚拟按键')}>
          <svg className="touch-keyboard-icon" viewBox="0 0 24 16" aria-hidden="true" focusable="false">
            <rect x="1" y="1" width="22" height="14" rx="2" />
            <path d="M5 5h1M9 5h1M13 5h1M17 5h1M5 9h1M9 9h1M13 9h6M7 12h10" />
          </svg>
        </button>
        <button className="touch-key" type="button" data-code="Escape" aria-label={t('Esc 键')}>
          Esc
        </button>
        <button className="touch-key" type="button" data-code="Enter" aria-label={t('Enter 键')}>
          Enter
        </button>
        <button className="touch-key" type="button" data-code="Space" aria-label={t('空格键')}>
          {t('空格')}{' '}
        </button>
        <div className="touch-dpad" aria-label={t('方向键')}>
          <button className="touch-key" type="button" data-code="ArrowUp" aria-label={t('上方向键')}>
            ▲
          </button>
          <button className="touch-key" type="button" data-code="ArrowLeft" aria-label={t('左方向键')}>
            ◀
          </button>
          <button className="touch-key" type="button" data-code="ArrowRight" aria-label={t('右方向键')}>
            ▶
          </button>
          <button className="touch-key" type="button" data-code="ArrowDown" aria-label={t('下方向键')}>
            ▼
          </button>
        </div>
      </div>
      <button
        id="vm-touch-joystick"
        type="button"
        data-role="joystick"
        hidden
        aria-label={t('摇杆：拖动摇杆向上下左右卷动地图')}
      >
        <span className="joystick-knob"></span>
      </button>
      <MainRegion />
      <Dialogs />
    </div>
  );
}
