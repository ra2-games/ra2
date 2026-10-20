import { t } from '../../shared/i18n/translate';
import { createReShadePreset } from '../../../graphics/reshadePreset';
/**
 * Toolbar action callbacks extracted from page.ts startVmPage: quick start, resolution/volume/multiplier, network faults, save import/export, and map packages. Pass session-reassigned state through getters/setters to avoid stale captures.
 */
import type { GameSource } from '../../../games/source';
import type { SupportedGameId } from '../../../games/catalog';
import type { VmShell } from '../../../adapter/vmShell';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import type { GameResolution } from '../../../games/resolution';
import type { LiveModelId } from './experiments/modelProbe';
import { captureProbeImage } from './experiments/modelProbe';
import type { FrameEffectController } from '../../../app/session/frameEffectController';
import type { FramePresenter } from '../../../graphics/framePresenter';
import type { VmFrameRenderer } from './vmFrameRenderer';
import type { RuntimeToolbar, RuntimeToolbarCallbacks } from './runtimeToolbar';
import { parseGameResolution } from '../../../games/resolution';
import { storeResolution } from './vmPageResolution';
import { collectPerformanceReport } from './performanceDiagnostics';
import { upscaleStatus } from './state/uiState';
import { sendCheatKey, sendCheatSequence } from './input';
import { editCustomMapPackages } from './customMapDialog';
import {
  createSavePackage,
  hasPlayerSlotSaves,
  importSavePackage,
  listSavePaths,
  readSavePackage,
  summarizeSavePaths,
} from '../../../adapter/saveTransfer';

export interface VmPageToolbarActionDeps {
  canvas: HTMLCanvasElement;
  debugAutoOpen: boolean;
  presenter: FramePresenter;
  effects: FrameEffectController<LiveModelId>;
  frameRenderer: VmFrameRenderer;
  getToolbar: () => RuntimeToolbar;
  getVm: () => VmShell | null;
  getStatus: () => VmStatus;
  getExitHandled: () => boolean;
  getSelectedGameId: () => SupportedGameId | null;
  getGameSource: () => GameSource | null;
  setRequestedClockRate: (rate: number) => void;
  setRequestedResolution: (resolution: GameResolution | null) => void;
  setRequestedVolume: (linear: number) => void;
  setPerformanceLine: (summary: string) => void;
  onRestartForResolution: () => Promise<void>;
  onChangeGameSource: () => Promise<void>;
  onSchedulePerformanceRender: () => void;
}

export function createVmPageToolbarActions(deps: VmPageToolbarActionDeps): RuntimeToolbarCallbacks {
  const {
    canvas,
    debugAutoOpen,
    presenter,
    effects,
    frameRenderer,
    getToolbar,
    getVm,
    getStatus,
    getExitHandled,
    getSelectedGameId,
    getGameSource,
    setRequestedClockRate,
    setRequestedResolution,
    setRequestedVolume,
    setPerformanceLine,
    onRestartForResolution,
    onChangeGameSource,
    onSchedulePerformanceRender,
  } = deps;
  return {
    async onCollectPerformance(signal, progress) {
      const vm = getVm();
      if (!vm || getExitHandled() || getStatus().phase !== 'running') throw new Error(t('游戏尚未运行'));
      return collectPerformanceReport({
        vm,
        signal,
        progress,
        canvas,
        presenter,
        renderer: frameRenderer,
        gameId: getSelectedGameId(),
        sourceKind: getGameSource()?.files.constructor.name ?? null,
        settings: () => getToolbar().getPerformanceSettings(),
      });
    },
    onLiveModel: import.meta.env.DEV ? (file, modelId) => effects.set(file, modelId) : undefined,
    async onQuickStart() {
      const vm = getVm();
      if (!vm || getExitHandled() || getStatus().phase !== 'running') throw new Error(t('游戏尚未运行'));
      // Startup hooks are not menu functions callable at arbitrary times; release the VM normally, then consume them on the next startup.
      const url = new URL(window.location.href);
      if (getSelectedGameId() === 'mo') url.searchParams.delete('start-page');
      else url.searchParams.set('start-page', 'skirmish');
      window.history.replaceState(window.history.state, '', url);
      await onRestartForResolution();
    },
    onCaptureProbe: import.meta.env.DEV
      ? (size) => {
          if (!presenter.frame) throw new Error(t('尚无游戏画面，请启动游戏后再采样'));
          return captureProbeImage(presenter.frame, size);
        }
      : undefined,
    onClockRate(rate) {
      setRequestedClockRate(rate);
      getVm()?.setGameClockRate(rate);
    },
    onReShadeMode(mode) {
      if (getExitHandled()) return;
      frameRenderer.setPostProcess(mode === 'off' ? null : (gl) => createReShadePreset(gl, mode === 'compare'));
      getToolbar().setReShadeMode(mode);
      presenter.invalidate();
    },
    onUpscaleMode(mode) {
      effects.stop(true);
      frameRenderer.setUpscaleMode(mode);
      const toolbar = getToolbar();
      toolbar.setUpscaleMode(mode);
      toolbar.setRendererDetail(frameRenderer.detail);
      upscaleStatus.set(frameRenderer.upscaleStatus);
      presenter.invalidate();
    },
    async onResolution(value) {
      const gameId = getSelectedGameId();
      if (!gameId) return;
      const resolution = parseGameResolution(value);
      if (value && !resolution) throw new Error(t('不支持的分辨率：{0}', value));
      storeResolution(gameId, resolution);
      setRequestedResolution(resolution);
      await onRestartForResolution();
    },
    onVolume(linear) {
      setRequestedVolume(linear);
      getVm()?.setMasterVolume(linear);
    },
    onPerformance(summary) {
      setPerformanceLine(summary);
      if (debugAutoOpen) canvas.dataset.vmPerformance = summary;
      onSchedulePerformanceRender();
    },
    onSendCheatText(text) {
      const vm = getVm();
      if (!vm || getStatus().phase !== 'running') {
        throw new Error(t('游戏尚未就绪，请等待游戏进入可操作画面。'));
      }
      const result = sendCheatSequence(vm, text);
      if (!result.ok) throw new Error(result.error);
    },
    onSendCheatKey(code) {
      const vm = getVm();
      if (!vm || getStatus().phase !== 'running') {
        throw new Error(t('游戏尚未就绪，请等待游戏进入可操作画面。'));
      }
      sendCheatKey(vm, code);
    },
    onChangeSource() {
      return onChangeGameSource();
    },
    async onCustomMaps() {
      const gameId = getSelectedGameId();
      if (!gameId || getExitHandled() || !getVm() || getStatus().phase !== 'running') return;
      document.exitPointerLock?.();
      await editCustomMapPackages(gameId, async (files) => {
        const vm = getVm();
        if (!vm || getExitHandled()) throw new Error(t('VM 已退出'));
        const result = await vm.attachMapFiles(files);
        return (
          t('已动态挂载 {0} 个地图文件', result.attached.length) +
          `${result.attached.length ? `：${result.attached.join('、')}` : ''}。` +
          t('已有 {0} 个同名文件保持不变；CSF 未挂载。VM 未重启，请自行检查地图列表。', result.existing.length)
        );
      });
    },
    async onDownloadSave() {
      const gameSource = getGameSource();
      if (!gameSource) throw new Error(t('游戏目录尚未就绪'));
      await getVm()?.flushFiles();
      // An exported package missing in-game saves cannot resume gameplay:
      // the receiver hits the native divide-by-zero crash when map files are absent. Warn early instead of exporting an incomplete package.
      const paths = await listSavePaths(gameSource.files);
      if (!hasPlayerSlotSaves(paths)) {
        window.alert(
          t('游戏目录中没有局内存档（Save 目录缺失或为空）：\n') +
            t('导出的内容只有进度表文件，无法在其他浏览器继续游戏。\n') +
            t('请先在本机游戏内保存一次存档，再导出。'),
        );
      }
      const blob = await createSavePackage(gameSource.files, gameSource.game.id);
      // Show package contents before download so users can verify that the slot they played is included,
      // rather than discovering a missing-slot divide-by-zero crash only after switching browsers.
      const summary = summarizeSavePaths(paths);
      if (
        !window.confirm(
          t('导出包内容（共 {0} 个文件）：\n\n{1}\n\n', paths.length, summary) +
            t('以上按文件数量统计，不等于游戏内可见的存档槽位数。\n\n') +
            t('请确认包含你实际游玩的槽位。若没有，说明当前浏览器/网址里不存在那些存档') +
            t('（存档在各浏览器自己的 IndexedDB 里），应换到实际玩的那个浏览器重新导出。\n\n是否下载？'),
        )
      )
        return;
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      const url = URL.createObjectURL(blob);
      // Browser download API adapter: do not attach it to the page or use it to construct/update ordinary UI.
      const link = document.createElement('a');
      link.href = url;
      link.download = `${gameSource.game.id}-save-${date}.ra2-save.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    async onUploadSave(file) {
      const gameSource = getGameSource();
      if (!gameSource) throw new Error(t('游戏目录尚未就绪'));
      const archive = await readSavePackage(file, gameSource.game.id);
      const entryPaths = archive.files.map((entry) => entry.path);
      const summary = summarizeSavePaths(entryPaths);
      const warning = hasPlayerSlotSaves(entryPaths)
        ? ''
        : t('⚠ 此包没有任何槽位 1–9 的存档（只有默认槽位 0 / 进度表）。\n') +
          t('如果你玩过并存过档，这很可能是选错了导出文件（Downloads 里的旧包），') +
          t('或是从没有存档的浏览器导出的——建议取消，回到实际玩的浏览器重新导出。\n\n');
      if (
        !window.confirm(
          t(
            '{0}将覆盖 {1} 个存档文件并重新启动游戏：\n\n{2}\n\n完整清单：\n{3}\n\n是否继续？',
            warning,
            archive.files.length,
            summary,
            entryPaths.join('\n'),
          ),
        )
      )
        return false;
      await getVm()?.stop();
      await getVm()?.flushFiles();
      await importSavePackage(gameSource.files, archive);
      window.location.reload();
      return true;
    },
  };
}
