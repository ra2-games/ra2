import { t } from '../../../shared/i18n/translate';
import { useState } from 'react';
import { Modal } from './Modal';
import { WECHAT_GROUP_QR_URL } from '../groupQr';

export function GroupDialog({ close }: { close(): void }) {
  const [failed, setFailed] = useState(false);
  return (
    <Modal open title={t('微信交流群')} className="join-group-dialog" onClose={close}>
      <header>
        <h2>{t('微信交流群')}</h2>
        <button
          className="toolbar-button"
          type="button"
          data-monitor-action="close-group-dialog"
          aria-label={t('关闭微信群二维码')}
          onClick={close}
        >
          {t('关闭')}{' '}
        </button>
      </header>
      {!failed && (
        <img
          className="join-group-qr"
          src={WECHAT_GROUP_QR_URL}
          alt={t('微信群二维码')}
          onError={() => setFailed(true)}
        />
      )}
      <p className={`join-group-hint${failed ? ' error' : ''}`}>
        {failed
          ? t('二维码图片加载失败，请稍后重试或刷新页面。')
          : t('微信扫码加入交流群，分享游戏体验、反馈问题与建议。')}
      </p>
    </Modal>
  );
}
