import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '../../../shared/i18n/translate';
import { useStore } from '../../../shared/state/useStore';
import { edgeRequest } from './edgeMouseNotice';
import { Modal } from './Modal';
import { ResourceLinks } from './ResourceLinks';

const SKIPPED_KEY = 'ra2-vm-game-guide-skipped';
let seenThisPage = false;

/** Show guidance once per page visit unless the browser explicitly remembers a skip. */
export function GameGuideDialog({
  open,
  setOpen,
  blocked,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  blocked: boolean;
}) {
  const edgeNotice = useStore(edgeRequest);
  const [pending, setPending] = useState(() => {
    try {
      return !seenThisPage && localStorage.getItem(SKIPPED_KEY) !== '1';
    } catch {
      return !seenThisPage;
    }
  });
  useEffect(() => {
    if (!pending || blocked || edgeNotice) return;
    const visible = window.matchMedia('(orientation: landscape), (min-width: 861px)');
    const show = () => {
      if (!visible.matches) return;
      seenThisPage = true;
      setPending(false);
      setOpen(true);
    };
    show();
    visible.addEventListener('change', show);
    return () => visible.removeEventListener('change', show);
  }, [pending, blocked, edgeNotice, setOpen]);
  const close = () => setOpen(false);
  const skip = () => {
    try {
      localStorage.setItem(SKIPPED_KEY, '1');
    } catch {
      /* Storage denial still allows dismissal for the current page visit. */
    }
    close();
  };
  return (
    <Modal
      open={open && !blocked && !edgeNotice}
      title={t('获取游戏')}
      className="source-settings-dialog game-folder-panel game-guide-dialog resource-links-dialog"
      onClose={close}
    >
      <header className="source-settings-header">
        <h2>{t('获取游戏')}</h2>
        <button type="button" className="source-settings-close" aria-label={t('关闭')} onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <p className="get-game-disclaimer" lang="en">
        EA has not endorsed and does not support this product.
      </p>
      <div className="ra2-content">
        <ResourceLinks />
        <p className="get-game-ownership">{t('请仅导入您合法拥有的游戏文件。MOD 需要原版游戏资源。')}</p>
        <section className="game-guide" aria-label={t('获取游戏')}>
          <ul>
            <li>{t('点击“加载游戏”，导入游戏压缩包或完整目录，也可添加心灵终结 MOD。')}</li>
            <li>{t('资源识别后，在上传窗口选择版本并点击“启动游戏”。')}</li>
            <li>{t('联机参数可在启动前设置。')}</li>
          </ul>
        </section>
      </div>
      <div className="game-guide-actions">
        <button type="button" className="dialog-button" onClick={close}>
          {t('知道了')}
        </button>
        <button type="button" className="dialog-button" onClick={skip}>
          {t('下次不再显示')}
        </button>
      </div>
    </Modal>
  );
}
