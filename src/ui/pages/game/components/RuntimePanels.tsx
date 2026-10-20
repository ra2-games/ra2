import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useState, type CSSProperties } from 'react';
import { forgetGameDirectory } from '../../../../platform/browser/files/directoryAccess';
import { clearCachedGameFiles, clearCachedImportedGameFiles } from '../../../../adapter/cachedGameFiles';
import { SUPPORTED_GAMES } from '../../../../games/catalog';
import type { BootState, StatusState } from '../state/uiState';
import { Ra2LoadingView } from './ra2menu/Ra2LoadingView';
import { Ra2MenuButton } from './ra2menu/Ra2MenuButton';

const panelStyle: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 'min(560px,calc(100vw - 40px))',
  zIndex: 35,
};
const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
export function ProblemPanel({ phase, detail }: { phase: 'blocked' | 'error'; detail: string }) {
  const [copied, setCopied] = useState(t('复制错误详情'));
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  return (
    <section className="panel game-folder-panel bad-page" style={panelStyle}>
      <h3 style={{ color: '#f00', fontSize: 24 }}>
        {phase === 'blocked' ? t('接口待实现（游戏停在此处）') : t('运行错误')}
      </h3>
      <pre
        style={{
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          userSelect: 'text',
        }}
      >
        {localizeText(detail)}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="folder-button"
          data-monitor-action="copy-error"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopied(t('复制失败'));
              return;
            }
            void navigator.clipboard.writeText(`${phase.toUpperCase()}\n${localizeText(detail)}`).then(
              () => setCopied(t('已复制')),
              () => setCopied(t('复制失败')),
            );
          }}
        >
          {localizeText(copied)}
        </button>
        <button
          type="button"
          className="folder-button"
          data-monitor-action="restart-game"
          onClick={() => window.location.reload()}
        >
          {t('重新启动游戏')}{' '}
        </button>
        <button
          type="button"
          className="folder-button"
          disabled={busy}
          data-monitor-action="reselect-game-files"
          onClick={() => {
            setBusy(true);
            void clearCachedImportedGameFiles(SUPPORTED_GAMES.map((game) => game.id)).then(
              () => window.location.reload(),
              (error) => {
                setBusy(false);
                setRecoveryError(t('无法清除资源缓存：{0}', reasonText(error)));
              },
            );
          }}
        >
          {t('重新选择游戏资源')}
        </button>
      </div>
      {recoveryError && <p role="alert">{recoveryError}</p>}
    </section>
  );
}
export function ExitPanel({ detail }: { detail: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="panel game-folder-panel" style={panelStyle}>
      <h3>{t('已回到网页')}</h3>
      <p>{error || t('原版游戏已正常退出，音频和鼠标锁定已释放。{0}', detail)}</p>
      <button
        className="folder-button"
        type="button"
        data-monitor-action="restart-game"
        onClick={() => window.location.reload()}
      >
        {t('重新启动游戏')}{' '}
      </button>{' '}
      <button
        className="folder-button"
        type="button"
        data-monitor-action="select-other-game-files"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.all([forgetGameDirectory(), clearCachedGameFiles().catch(() => {})]).then(
            () => window.location.reload(),
            (error) => {
              setBusy(false);
              setError(t('无法忘记文件夹：{0}', reasonText(error)));
            },
          );
        }}
      >
        {t('选择其他游戏文件夹')}{' '}
      </button>
    </section>
  );
}

export function BootView({ game, status, cancel }: BootState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section id="vm-boot" className="game-folder-panel game-source-picker" aria-label={t('启动中')}>
      <Ra2LoadingView
        title={localizeLabel(game.title)}
        phase={status.phase === 'running' ? t('正在加载资源') : status.phase === 'ready' ? t('内存就绪') : t('启动中')}
        detail={localizeText(error || status.detail)}
        action={
          <Ra2MenuButton
            data-monitor-action="cancel-startup"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void cancel().catch((reason) => {
                setBusy(false);
                setError(reasonText(reason));
              });
            }}
          >
            {busy ? t('正在停止…') : t('取消启动')}
          </Ra2MenuButton>
        }
      />
    </section>
  );
}
export function StatusView({ value, id, bottom }: { value: StatusState; id: string; bottom: number }) {
  return (
    <div
      id={id}
      role="status"
      data-phase={value.phase}
      title={value.title && localizeText(value.title)}
      style={{
        position: 'fixed',
        bottom,
        left: 8,
        zIndex: 50,
        maxWidth: '80vw',
        padding: '5px 8px',
        background: '#111e',
        color: ['error', 'disconnected'].includes(value.phase) ? '#ff8080' : '#ddd',
        fontSize: 12,
        pointerEvents: 'none',
      }}
    >
      {localizeText(value.text)}
    </div>
  );
}
export function ShortcutHelp({ close }: { close(): void }) {
  const rows = [
    [t('点击游戏画面'), t('锁定鼠标；全屏可授权将 Esc 交给游戏')],
    ['Esc', t('获键盘锁授权后交给游戏；长按退出锁定')],
    [t('Shift + 左键'), t('连点 ×10（50ms 间隔）')],
    ['F11', t('沉浸式全屏')],
    ['[ / ]', t('时钟倍率 慢 / 快')],
    ['`', t('开发调试面板')],
    ['?', t('本帮助')],
  ];
  return (
    <section className="panel" style={panelStyle}>
      <h3>{t('快捷键')}</h3>
      <ul>
        {rows.map(([key, description]) => (
          <li key={key}>
            <code>{key}</code> — {description}
          </li>
        ))}
      </ul>
      <button className="folder-button" type="button" data-monitor-action="close-shortcut-help" onClick={close}>
        {t('关闭')}{' '}
      </button>
    </section>
  );
}
