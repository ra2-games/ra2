import { useId, useState } from 'react';
import type { useGameSourcePicker } from '../hooks/useGameSourcePicker';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../../games/catalog';
import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { MENTAL_OMEGA_DOWNLOADS, MENTAL_OMEGA_ORIGINAL_FILES } from '../../../../games/mentalOmega/installation';
import { ORIGINAL_GAME_STORE_URL } from '../resourceLinks';
import { Modal } from './Modal';
import { Ra2Progress } from './ra2menu/Ra2Progress';

type Picker = ReturnType<typeof useGameSourcePicker>;

export function ResourceUploadDialog({
  open,
  onClose,
  picker,
  launchError,
}: {
  open: boolean;
  onClose(): void;
  picker: Picker;
  launchError: string;
}) {
  const editionName = useId();
  const [selectedGame, setSelectedGame] = useState<SupportedGameId>('ra2');
  const ready = picker.games.includes(selectedGame);
  const isMo = selectedGame === 'mo';
  const originalReady = isMo ? picker.moOriginalMissing.length === 0 : ready;
  const moAddonsReady =
    picker.missing.mo?.every((name) =>
      (MENTAL_OMEGA_ORIGINAL_FILES as readonly string[]).includes(name.toLowerCase()),
    ) ?? false;
  const progressPercent = picker.progress?.totalFiles
    ? Math.min(100, Math.max(0, (picker.progress.completedFiles / picker.progress.totalFiles) * 100))
    : undefined;
  const launchHintId = useId();
  const gameTitle = (game: (typeof SUPPORTED_GAMES)[number]) =>
    game.id === 'mo' ? t('心灵终结') : localizeLabel(game.title);
  const selectedTitle = gameTitle(SUPPORTED_GAMES.find((game) => game.id === selectedGame)!);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('加载游戏')}
      className="source-settings-dialog resource-upload-dialog"
      busy={picker.busy}
    >
      <header className="source-settings-header">
        <h2>{t('加载游戏')}</h2>
        <button
          type="button"
          className="source-settings-close"
          aria-label={t('关闭')}
          disabled={picker.busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="ra2-content">
        <section className="upload-editions" aria-label={t('游戏资源状态')}>
          <h3>
            {t('选择要启动的游戏')} {isMo && <span className="upload-mod-badge">{t('实验性')}</span>}
          </h3>
          <div className="upload-edition-grid" role="radiogroup" aria-label={t('选择要启动的游戏')}>
            {SUPPORTED_GAMES.map((game) => (
              <div className="upload-game-status" key={game.id} data-selected={selectedGame === game.id}>
                <label className="upload-edition-option">
                  <input
                    type="radio"
                    name={editionName}
                    value={game.id}
                    aria-label={gameTitle(game)}
                    checked={selectedGame === game.id}
                    disabled={picker.busy}
                    onChange={() => setSelectedGame(game.id)}
                  />
                  <span className="upload-edition-mark" aria-hidden="true">
                    <img src={`/icons/${game.id}.png`} alt="" />
                  </span>
                  <strong>{gameTitle(game)}</strong>
                </label>
              </div>
            ))}
          </div>
        </section>
        <div className="upload-preparation-grid upload-workflow" role="group" aria-label={t('资源加载流程')}>
          <section
            className="upload-resource-item upload-workflow-node"
            data-step="01"
            data-ready={originalReady}
            aria-label={t('添加游戏资源')}
          >
            <h3>{isMo ? t('加载尤里的复仇资源') : t('添加游戏资源')}</h3>
            {originalReady ? (
              <p className="upload-resource-ready" role="status">
                {isMo
                  ? ready
                    ? t('心灵终结资源已就绪，可以启动游戏。')
                    : t('尤里基础资源已就绪。请继续加载下方两个 MO 资源包。')
                  : t('{0}资源已就绪，可以启动游戏。', localizeLabel(selectedTitle!))}
              </p>
            ) : (
              <p>
                {isMo ? t('先选择尤里的复仇（YR）原版压缩包或完整安装文件夹。') : t('选择游戏压缩包或完整安装文件夹。')}
              </p>
            )}
            <div className="upload-resource-actions">
              <button
                type="button"
                data-monitor-action="pick-archive"
                disabled={picker.busy}
                onClick={() => picker.pick('archive')}
              >
                {t('选择文件…')}
              </button>
              <button
                type="button"
                data-monitor-action="pick-folder"
                disabled={picker.busy}
                onClick={() => picker.pick('folder')}
              >
                {t('选择文件夹…')}
              </button>
              <a
                className="resource-download-link"
                href={ORIGINAL_GAME_STORE_URL}
                aria-label={t('在 Steam 获取红警 2 / 尤里的复仇')}
                title={t('在 Steam 获取红警 2 / 尤里的复仇')}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('在 Steam 获取红警 2 / 尤里的复仇')} ↗
              </a>
            </div>
            <small>{t('支持 ZIP、EXE、RAR、7Z。重新选择会替换当前游戏资源。')}</small>
            {isMo && <small>{t('完整的 MO 3.3.6 资源已包含基础包和补丁，无需重复添加。')}</small>}
          </section>
          {isMo && (
            <section
              className="upload-resource-item upload-workflow-mod"
              data-ready={moAddonsReady}
              aria-label={t('心灵终结 MOD')}
            >
              {(['base', 'patch'] as const).map((kind) => (
                <div
                  className="upload-package upload-workflow-node"
                  key={kind}
                  data-step={kind === 'base' ? '02' : '03'}
                  data-ready={!!picker.moPackages[kind] || moAddonsReady}
                >
                  <div>
                    <div className="upload-package-heading">
                      <strong>{kind === 'base' ? t('MO 3.3.0 基础包') : t('MO 3.3.6 更新补丁（必需）')}</strong>
                      <a
                        className="resource-download-link"
                        href={MENTAL_OMEGA_DOWNLOADS[kind]}
                        aria-label={kind === 'base' ? t('下载基础包') : t('下载补丁')}
                        title={kind === 'base' ? t('下载基础包') : t('下载补丁')}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {kind === 'base' ? t('下载基础包') : t('下载补丁')} ↗
                      </a>
                    </div>
                    <p>{picker.moPackages[kind] ?? (moAddonsReady ? t('已包含在导入资源中') : t('未添加'))}</p>
                    {(picker.moPackages[kind] || moAddonsReady) && (
                      <p className="upload-resource-ready" role="status">
                        {kind === 'base' ? t('MO 基础包已导入。') : t('MO 更新补丁已导入。')}
                      </p>
                    )}
                  </div>
                  <div className="upload-resource-actions">
                    <button
                      type="button"
                      data-monitor-action={`pick-mo-${kind}`}
                      aria-label={kind === 'base' ? t('添加基础包') : t('添加补丁')}
                      disabled={picker.busy}
                      onClick={() => picker.pickMoPackage(kind)}
                    >
                      {t('添加包…')}
                    </button>
                    {picker.moPackages[kind] && (
                      <button
                        type="button"
                        aria-label={kind === 'base' ? t('移除基础包') : t('移除补丁')}
                        disabled={picker.busy}
                        onClick={() => picker.removeMoPackage(kind)}
                      >
                        {t('移除')}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div
                className="upload-package upload-language-package upload-workflow-node"
                data-step="04"
                data-optional="true"
                data-ready={!!picker.moPackages.language}
              >
                <div>
                  <div className="upload-package-heading">
                    <strong>{t('中文语言包（可选）')}</strong>
                    <a
                      className="resource-download-link"
                      href={MENTAL_OMEGA_DOWNLOADS.language}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('下载简体中文')} ↗
                    </a>
                    <a
                      className="resource-download-link"
                      href={MENTAL_OMEGA_DOWNLOADS.languageTraditional}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('下载繁体中文')} ↗
                    </a>
                  </div>
                  <p>
                    {t(
                      '基础包和补丁加载后，可选一个 3.3.6 简体或繁体语言包；重新添加会替换当前语言包，不添加也可启动。',
                    )}
                  </p>
                  <p>{picker.moPackages.language ?? t('未添加')}</p>
                </div>
                <div className="upload-resource-actions">
                  <button type="button" disabled={picker.busy} onClick={() => picker.pickMoPackage('language')}>
                    {t('添加语言包…')}
                  </button>
                  {picker.moPackages.language && (
                    <button type="button" disabled={picker.busy} onClick={() => picker.removeMoPackage('language')}>
                      {t('移除语言包')}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          <section
            className="upload-workflow-node upload-workflow-finish"
            data-step={isMo ? '05' : '02'}
            data-ready={ready}
          >
            <div>
              <h3>{t('启动游戏')}</h3>
              <p role="status">{ready ? t('资源已就绪') : t('请先完成上方必需的资源步骤。')}</p>
            </div>
            <div className="upload-resource-actions upload-launch-actions">
              <button
                type="button"
                className="upload-launch-button"
                data-monitor-action={`choose-${selectedGame}`}
                aria-describedby={launchHintId}
                disabled={picker.busy || !ready || !!launchError}
                onClick={() => {
                  if (ready && !picker.busy && !launchError) void picker.chooseGame(selectedGame);
                }}
              >
                {t('启动游戏')} <span aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        </div>
        {picker.hasResources && !ready && (
          <details className="upload-missing-files" key={selectedGame}>
            <summary>{t('查看缺少的文件')}</summary>
            <p>
              {picker.replaced.includes(selectedGame)
                ? t('此目录已安装 MOD，请另选原版资源。')
                : picker.missing[selectedGame]?.join('、')}
            </p>
          </details>
        )}
        {picker.busy && !picker.awaitingSelection && (
          <div className="upload-import-progress" role="status" aria-live="polite">
            <div className="upload-progress-heading">
              <strong>{t('正在加载资源')}</strong>
              {progressPercent !== undefined && (
                <span className="upload-progress-percent" aria-hidden="true">
                  {Math.round(progressPercent)}%
                </span>
              )}
            </div>
            {picker.description && <p>{localizeText(picker.description)}</p>}
            <Ra2Progress
              label={
                picker.progress
                  ? picker.progress.totalFiles === null
                    ? t('已解压 {0} 个文件', picker.progress.completedFiles)
                    : t('已解压 {0}/{1} 个文件', picker.progress.completedFiles, picker.progress.totalFiles)
                  : t('正在加载资源')
              }
              value={progressPercent}
            />
          </div>
        )}
        {!picker.busy && picker.description && <p role="status">{localizeText(picker.description)}</p>}
        {picker.error && <p role="alert">{localizeText(picker.error)}</p>}
        {launchError && <p role="alert">{localizeText(launchError)}</p>}
      </div>
      <footer className="resource-upload-footer">
        <div className="upload-launch-summary">
          <strong>{localizeLabel(selectedTitle!)}</strong>
          <small id={launchHintId}>{t('资源仅在当前浏览器中读取，不会上传至服务器。')}</small>
        </div>
        <div className="upload-resource-actions upload-launch-actions">
          <button
            type="button"
            disabled={picker.busy}
            title={t('清除资源缓存，保留存档和自定义地图')}
            onClick={() => void picker.clearCache()}
          >
            {t('清除缓存')}
          </button>
        </div>
      </footer>
    </Modal>
  );
}
