import { t } from '../../../shared/i18n/translate';
import type { ComponentProps } from 'react';
import type { VmStatus } from '../../../../app/session/runtimeEvents';
import type { GameSource } from '../../../../games/source';
import type { SupportedGame, SupportedGameId } from '../../../../games/catalog';
import type { DebugPanel } from '../components/DebugPanel';
import type { RuntimeToolbarView } from '../components/RuntimeToolbarView';
import { createStore } from '../../../shared/state/store';

export const toolbarState = createStore<ComponentProps<typeof RuntimeToolbarView> | null>(null);
export const controlsCollapsed = createStore(false);
export const upscaleStatus = createStore<string | null>(null);
export const debugVisible = createStore(false);
export const debugState = createStore<ComponentProps<typeof DebugPanel> | null>(null);
export const helpVisible = createStore(false);
export const groupVisible = createStore(false);
export const gameRunning = createStore(false);
export const gameMenuRequest = createStore<{
  source: GameSource;
  finish(files: ReadonlyMap<string, Uint8Array> | null): void;
  cancel(): void;
} | null>(null);
export function selectGameLaunch(source: GameSource): Promise<ReadonlyMap<string, Uint8Array> | null> {
  gameMenuRequest.getSnapshot()?.cancel();
  return new Promise((resolve, reject) => {
    const request = {
      source,
      finish(files: ReadonlyMap<string, Uint8Array> | null) {
        if (gameMenuRequest.getSnapshot() !== request) return;
        gameMenuRequest.set(null);
        resolve(files);
      },
      cancel() {
        if (gameMenuRequest.getSnapshot() !== request) return;
        gameMenuRequest.set(null);
        reject(new DOMException('Page closed', 'AbortError'));
      },
    };
    gameMenuRequest.set(request);
  });
}

export const controlReady = createStore(false);
export const mainPanel = createStore<{ phase: 'blocked' | 'error' | 'exited'; detail: string } | null>(null);
export interface BootState {
  game: Pick<SupportedGame, 'id' | 'title'>;
  status: VmStatus;
  cancel(): Promise<void>;
}
export const bootState = createStore<BootState | null>(null);
export interface StatusState {
  phase: string;
  text: string;
  title?: string;
}
export const resourceStatus = createStore<StatusState | null>(null);
export const networkStatus = createStore<StatusState | null>(null);

// Services request input; App mounts components declaratively. Services create neither independent roots nor host nodes.
let requestId = 0;
export const sourceRequest = createStore<{ id: number; finish(source: GameSource): void; cancel(): void } | null>(null);
export function cancelSourceRequest(): void {
  sourceRequest.getSnapshot()?.cancel();
}
export function selectGameFiles(): Promise<GameSource> {
  cancelSourceRequest();
  return new Promise((resolve, reject) => {
    const request = {
      id: ++requestId,
      finish(source: GameSource) {
        if (sourceRequest.getSnapshot() !== request) return;
        sourceRequest.set(null);
        resolve(source);
      },
      cancel() {
        if (sourceRequest.getSnapshot() !== request) return;
        sourceRequest.set(null);
        reject(new DOMException(t('页面已关闭'), 'AbortError'));
      },
    };
    sourceRequest.set(request);
  });
}
export interface MapRequest {
  id: number;
  gameId: SupportedGameId;
  applyLive?: (files: ReadonlyMap<string, Uint8Array>) => Promise<string>;
  finish(changed: boolean): void;
}
export const mapRequest = createStore<MapRequest | null>(null);
export function editCustomMapPackages(gameId: SupportedGameId, applyLive?: MapRequest['applyLive']): Promise<boolean> {
  mapRequest.getSnapshot()?.finish(false);
  return new Promise((resolve) => {
    const request: MapRequest = {
      id: ++requestId,
      gameId,
      applyLive,
      finish(changed) {
        if (mapRequest.getSnapshot() !== request) return;
        mapRequest.set(null);
        resolve(changed);
      },
    };
    mapRequest.set(request);
  });
}
