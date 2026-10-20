import { t, localizeText } from '../../../shared/i18n/translate';
import { createPortal } from 'react-dom';
import { lazy, Suspense } from 'react';
import { useStore } from '../../../shared/state/useStore';
import * as state from '../state/uiState';
import { RuntimeToolbarView } from './RuntimeToolbarView';
import { DebugPanel } from './DebugPanel';
import { GroupDialog } from './GroupDialog';
import { BootView, ExitPanel, ProblemPanel, ShortcutHelp, StatusView } from './RuntimePanels';
import { EdgeNotice, edgeRequest } from './edgeMouseNotice';

const GameSourcePickerView = lazy(() =>
  import('./GameSourcePickerView').then((module) => ({ default: module.GameSourcePickerView })),
);
const CustomMapDialog = lazy(() => import('./CustomMapDialog').then((module) => ({ default: module.CustomMapDialog })));
const MentalOmegaMenu = lazy(() => import('./MentalOmegaMenu').then((module) => ({ default: module.MentalOmegaMenu })));

// Each region subscribes only to its own low-frequency snapshot; toolbar counters do not rerender the canvas or resource picker.
export function Toolbar() {
  const props = useStore(state.toolbarState);
  const collapsed = useStore(state.controlsCollapsed);
  return (
    <nav id="vm-controls" aria-label={t('运行状态与控制')} className={collapsed ? 'collapsed' : undefined}>
      {props && <RuntimeToolbarView {...props} />}
    </nav>
  );
}
export function DebugRegion() {
  const visible = useStore(state.debugVisible),
    props = useStore(state.debugState);
  return (
    <aside id="vm-debug" hidden={!visible} aria-label={t('调试信息')}>
      {props && <DebugPanel {...props} />}
    </aside>
  );
}
export function MainRegion() {
  const request = useStore(state.sourceRequest),
    panel = useStore(state.mainPanel);
  const help = useStore(state.helpVisible);
  const gameMenu = useStore(state.gameMenuRequest);
  return (
    <div id="ui">
      {gameMenu && (
        <Suspense fallback={<p role="status">{t('正在加载游戏菜单…')}</p>}>
          <MentalOmegaMenu source={gameMenu.source} finish={gameMenu.finish} />
        </Suspense>
      )}
      {request && (
        <Suspense fallback={<p role="status">{t('正在加载资源选择器…')}</p>}>
          <GameSourcePickerView key={request.id} onSelected={request.finish} />
        </Suspense>
      )}
      {panel &&
        (panel.phase === 'exited' ? (
          <ExitPanel detail={panel.detail} />
        ) : (
          <ProblemPanel phase={panel.phase} detail={panel.detail} />
        ))}
      {help && <ShortcutHelp close={() => state.helpVisible.set(false)} />}
    </div>
  );
}
export function BootRegion() {
  const boot = useStore(state.bootState);
  return boot && <BootView {...boot} />;
}
export function ScreenStatus() {
  const network = useStore(state.networkStatus),
    resource = useStore(state.resourceStatus);
  const upscale = useStore(state.upscaleStatus);
  return (
    <>
      <output id="vm-upscale-status" role="status" aria-live="polite" hidden={upscale === null}>
        {upscale && localizeText(upscale)}
      </output>
      {network && <StatusView id="vm-network-status" bottom={38} value={network} />}
      {resource && <StatusView id="vm-resource-status" bottom={8} value={resource} />}
    </>
  );
}
export function Dialogs() {
  const group = useStore(state.groupVisible),
    maps = useStore(state.mapRequest),
    edge = useStore(edgeRequest);
  return createPortal(
    <>
      {group && <GroupDialog close={() => state.groupVisible.set(false)} />}
      {maps && (
        <Suspense fallback={<p role="status">{t('正在加载地图管理…')}</p>}>
          <CustomMapDialog key={maps.id} gameId={maps.gameId} applyLive={maps.applyLive} finish={maps.finish} />
        </Suspense>
      )}
      {edge && <EdgeNotice close={edge.close} />}
    </>,
    document.body,
  );
}
