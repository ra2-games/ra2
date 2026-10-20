import { ResourceUploadDialog } from './ResourceUploadDialog';
import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalHost } from '../../../shared/portalHost';
import { Modal } from './Modal';
import { GameGuideDialog } from './GameGuideDialog';
import { parseRa2RelayUrl } from '../../../../games/ra2/networkTransport';
import type { GameSource } from '../../../../games/source';
import { useGameSourcePicker } from '../hooks/useGameSourcePicker';
import { openGroupJoinDialog } from '../joinGroupDialog';
import { Ra2Screen } from './ra2menu/Ra2Screen';
import { Ra2MenuPanel } from './ra2menu/Ra2MenuPanel';
import { Ra2MenuHeader } from './ra2menu/Ra2MenuHeader';
import { Ra2MenuNav } from './ra2menu/Ra2MenuNav';
import { Ra2MenuButton } from './ra2menu/Ra2MenuButton';
import './GameSourcePicker.css';
import { Ra2LoadingView, Ra2MenuFooter } from './ra2menu/Ra2LoadingView';
import { CONTACT_EMAIL } from '../branding';

/** First screen uses the shared classic-console backdrop, command column, and footer. */
export function GameSourcePickerView({ onSelected }: { onSelected(source: GameSource): void }) {
  const portalHost = usePortalHost();
  const props = useGameSourcePicker(onSelected);
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [relay, setRelay] = useState(() => new URLSearchParams(window.location.search).get('relay') ?? '');
  const [networkEnabled, setNetworkEnabled] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('network') !== '0' && (query.get('network') === '1' || query.has('relay'));
  });
  let relayError = '';
  try {
    if (networkEnabled) parseRa2RelayUrl(relay);
  } catch (error) {
    relayError = (error as Error).message;
  }
  const updateRelay = (value: string) => {
    setRelay(value);
    try {
      const address = parseRa2RelayUrl(value);
      const url = new URL(window.location.href);
      url.searchParams.set('network', '1');
      if (address) url.searchParams.set('relay', value.trim());
      else url.searchParams.delete('relay');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* Keep invalid drafts in the input and disable startup; update configuration only after correction. */
    }
  };
  const toggleNetwork = (enabled: boolean) => {
    setNetworkEnabled(enabled);
    const url = new URL(window.location.href);
    url.searchParams.set('network', enabled ? '1' : '0');
    if (!enabled) url.searchParams.delete('relay');
    else {
      try {
        const value = parseRa2RelayUrl(relay);
        if (value) url.searchParams.set('relay', relay.trim());
      } catch {
        /* Retain the input draft and show the validation error. */
      }
    }
    window.history.replaceState(window.history.state, '', url);
  };
  const state = props.manifest;
  const reportedError = useRef(props.error);
  useEffect(() => {
    if (props.busy || props.awaitingSelection) return;
    const previous = reportedError.current;
    reportedError.current = props.error;
    // Errors already shown in the upload dialog must not open another dialog after dismissal.
    if (!resourcePickerOpen && props.error && props.error !== previous) setResourcePickerOpen(true);
  }, [props.busy, props.awaitingSelection, props.error, resourcePickerOpen]);
  const entries = state
    ? [
        ...state.manifest.playerRequired.map((file) => ({
          ...file,
          optional: false,
          ok: state.present.has(file.name.toLowerCase()),
        })),
        ...state.manifest.playerOptional.map((file) => ({
          ...file,
          optional: true,
          ok:
            state.present.has(file.name.toLowerCase()) ||
            (file.directory !== undefined && [...state.present].some((name) => name.startsWith(file.directory!))),
        })),
      ]
    : [];
  const systemStatus = props.awaitingSelection
    ? 'AWAITING INPUT'
    : props.busy
      ? 'SCANNING'
      : props.error
        ? 'RESOURCE ERROR'
        : props.hasResources
          ? 'SELECT VERSION'
          : 'STANDBY';
  return (
    <section className="game-folder-panel game-source-picker" aria-labelledby="source-picker-title">
      <input ref={props.moRef} type="file" accept=".zip,.rar,.7z" hidden onChange={props.moChanged} />
      <input ref={props.archiveRef} type="file" accept=".zip,.exe,.rar,.7z" hidden onChange={props.archiveChanged} />
      <input ref={props.folderRef} type="file" {...{ webkitdirectory: '' }} hidden onChange={props.folderChanged} />
      {props.busy && !props.awaitingSelection && !resourcePickerOpen ? (
        <Ra2LoadingView
          title={t('选择游戏资源')}
          phase={t('正在加载资源')}
          detail={localizeText(props.description)}
          progressLabel={
            props.progress
              ? props.progress.totalFiles === null
                ? t('已解压 {0} 个文件', props.progress.completedFiles)
                : t('已解压 {0}/{1} 个文件', props.progress.completedFiles, props.progress.totalFiles)
              : localizeText(props.description)
          }
          progress={
            props.progress?.totalFiles ? (props.progress.completedFiles / props.progress.totalFiles) * 100 : undefined
          }
        />
      ) : (
        <Ra2Screen>
          <Ra2MenuPanel>
            <h3 id="source-picker-title" className="source-home-title">
              {t('选择游戏资源')}
            </h3>
            <Ra2MenuHeader>
              <span className="status-terminal-label">SYSTEM STATUS</span>
              <span
                className={`status-terminal-readout ${props.error ? 'error' : props.busy && !props.awaitingSelection ? 'scanning' : ''}`}
                role="status"
              >
                <i aria-hidden="true" />
                {systemStatus}
              </span>
              <span className="status-terminal-divider" aria-hidden="true" />
              <span className="status-terminal-detail">
                {props.awaitingSelection
                  ? 'SELECT LOCAL RESOURCE'
                  : props.busy
                    ? localizeText(props.description)
                    : props.description
                      ? localizeText(props.description)
                      : 'COMMAND LINK: LOCAL'}
              </span>
            </Ra2MenuHeader>
            <Ra2MenuNav label={t('游戏菜单')}>
              <Ra2MenuButton data-monitor-action="upload-resources" onClick={() => setResourcePickerOpen(true)}>
                {t('加载游戏')}
              </Ra2MenuButton>
              <Ra2MenuButton data-monitor-action="get-resources" onClick={() => setGuideOpen(true)}>
                {t('获取游戏')}
              </Ra2MenuButton>
              <Ra2MenuButton onClick={() => setInformationOpen(true)}>{t('联机设置')}</Ra2MenuButton>
              <span className="ra2-spacer" aria-hidden="true" />
              <Ra2MenuButton data-monitor-action="open-group" onClick={openGroupJoinDialog}>
                {t('微信群')}
              </Ra2MenuButton>
              <a
                className="ra2-menu-btn"
                data-monitor-action="open-project-source"
                href="https://github.com/ra2-games/ra2"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="ra2-menu-btn-label">GitHub</span>
              </a>
            </Ra2MenuNav>
            <div className="source-home-contact">
              <span>{t('联系我们：')}</span>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </div>
          </Ra2MenuPanel>
          <Ra2MenuFooter />
        </Ra2Screen>
      )}
      {createPortal(
        <ResourceUploadDialog
          open={resourcePickerOpen}
          onClose={() => setResourcePickerOpen(false)}
          picker={props}
          launchError={relayError}
        />,
        portalHost,
      )}
      {createPortal(
        <GameGuideDialog
          open={guideOpen}
          setOpen={setGuideOpen}
          blocked={props.busy || props.awaitingSelection || informationOpen || resourcePickerOpen}
        />,
        portalHost,
      )}
      {createPortal(
        <Modal
          open={informationOpen && !props.busy}
          title={t('联机设置')}
          className="source-settings-dialog game-folder-panel"
          onClose={() => setInformationOpen(false)}
        >
          <header className="source-settings-header">
            <h2>{t('联机设置')}</h2>
            <button
              type="button"
              className="source-settings-close"
              aria-label={t('关闭')}
              onClick={() => setInformationOpen(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div className="ra2-content">
            <p className="source-picker-description" role="status" hidden={props.busy}>
              {localizeText(props.description)}
            </p>
            <div className="network-toggle-row">
              <label className="network-toggle">
                <input
                  type="checkbox"
                  checked={networkEnabled}
                  disabled={props.busy}
                  onChange={(event) => toggleNetwork(event.currentTarget.checked)}
                />
                <span className="network-toggle-led" aria-hidden="true"></span>
                {t('联机')}
              </label>
              <span className="network-toggle-hint">{t('与好友同房对战')}</span>
            </div>
            <div className="manifest-checklist" hidden={!state}>
              {entries.map((entry) => (
                <div
                  key={entry.name}
                  className={`manifest-line ${entry.ok ? 'ok' : 'missing'}${entry.optional ? ' optional' : ''}`}
                >
                  {entry.ok ? '✓' : '✗'} {entry.name} — {localizeLabel(entry.note)}
                  {entry.optional && !entry.ok ? t('（可选，不影响启动）') : ''}
                </div>
              ))}
              {state?.complete && <div className="manifest-line ok">{t('必需文件已集齐，正在启动…')}</div>}
            </div>
            {networkEnabled && (
              <div className="network-settings">
                <div className="relay-settings">
                  <label htmlFor="relay-address">{t('联机 relay 地址（可选）')}</label>
                  <input
                    id="relay-address"
                    type="text"
                    value={relay}
                    disabled={props.busy}
                    placeholder="127.0.0.1:15176"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-invalid={!!relayError}
                    aria-describedby="relay-address-help"
                    onChange={(event) => updateRelay(event.currentTarget.value)}
                  />
                  <small id="relay-address-help">{t('留空使用默认服务器；所有玩家填写同一地址即可同房。')}</small>
                  <small className="relay-tech-note">
                    {t('只需主机与端口，默认房间 /ra2；内网 IP 使用 WS，其他地址使用 WSS。')}
                  </small>
                  {relayError && <p role="alert">{localizeText(relayError)}</p>}
                </div>
              </div>
            )}
            <p className="source-picker-error" role="alert" hidden={!props.error}>
              {localizeText(props.error)}
            </p>
          </div>
        </Modal>,
        portalHost,
      )}
    </section>
  );
}
