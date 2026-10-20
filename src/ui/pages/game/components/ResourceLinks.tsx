import { MENTAL_OMEGA_DOWNLOADS } from '../../../../games/mentalOmega/installation';
import { ORIGINAL_GAME_STORE_URL } from '../resourceLinks';
import { t } from '../../../shared/i18n/translate';

export function ResourceLinks() {
  return (
    <div className="resource-links-grid">
      <section className="resource-link-card">
        <h3>{t('原版游戏资源')}</h3>
        <p>{t('前往 Steam 商店，获取红色警戒 2 与尤里的复仇。')}</p>
        <a className="resource-download-link" href={ORIGINAL_GAME_STORE_URL} target="_blank" rel="noopener noreferrer">
          {t('在 Steam 获取红警 2 / 尤里的复仇')} ↗
        </a>
      </section>
      <section className="resource-link-card">
        <h3>{t('心灵终结 MOD')}</h3>
        <p>{t('前往 ModDB，下载 MO 3.3.0 基础包与 3.3.6 更新补丁。')}</p>
        <div className="resource-download-actions">
          <a
            className="resource-download-link"
            href={MENTAL_OMEGA_DOWNLOADS.base}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('下载基础包')} ↗
          </a>
          <a
            className="resource-download-link"
            href={MENTAL_OMEGA_DOWNLOADS.patch}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('下载补丁')} ↗
          </a>
        </div>
      </section>
    </div>
  );
}
