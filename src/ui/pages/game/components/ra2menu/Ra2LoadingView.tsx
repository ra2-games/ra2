import type { ReactNode } from 'react';
import { t } from '../../../../shared/i18n/translate';
import { Ra2Screen } from './Ra2Screen';
import { Ra2MenuPanel } from './Ra2MenuPanel';
import { Ra2MenuHeader } from './Ra2MenuHeader';
import { Ra2MenuNav } from './Ra2MenuNav';
import { Ra2Progress } from './Ra2Progress';
import { CLIENT_NAME } from '../../branding';

export function Ra2MenuFooter() {
  return (
    <footer className="ra2-footer">
      <p className="disclaimer">
        {t(
          '本项目为粉丝自制的非官方项目，仅提供游戏运行环境。请仅导入您合法拥有的游戏文件。游戏版权归原权利人所有。本项目与 Electronic Arts, Inc. 无任何关联，亦未获得其授权、认可或支持。',
        )}
      </p>
    </footer>
  );
}

/** Import and VM startup share the same layout; only their phase, measurements and available actions differ. */
export function Ra2LoadingView({
  title,
  phase,
  detail,
  progressLabel = detail,
  progress,
  action,
}: {
  title: string;
  phase: string;
  detail: string;
  progressLabel?: string;
  progress?: number;
  action?: ReactNode;
}) {
  return (
    <Ra2Screen>
      <Ra2MenuPanel>
        <Ra2MenuHeader>
          <span className="status-terminal-label">SYSTEM STATUS</span>
          <span className="status-terminal-readout scanning" role="status">
            <i aria-hidden="true" />
            {phase}
          </span>
          <span className="status-terminal-divider" aria-hidden="true" />
          <span className="status-terminal-detail">{CLIENT_NAME}</span>
        </Ra2MenuHeader>
        <Ra2MenuNav label={t('游戏菜单')}>
          <span className="ra2-spacer" aria-hidden="true" />
          {action ?? <span className="ra2-loading-action-placeholder" aria-hidden="true" />}
        </Ra2MenuNav>
        <div className="ra2-content ra2-loading-content">
          <h3 className="vm-boot-title">{title}</h3>
          <p className="source-picker-description vm-boot-detail">{detail}</p>
        </div>
        <Ra2Progress label={progressLabel} value={progress} />
      </Ra2MenuPanel>
      <Ra2MenuFooter />
    </Ra2Screen>
  );
}
