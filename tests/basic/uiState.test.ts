import { describe, expect, it } from 'vitest';
import { createStore } from '../../src/ui/shared/state/store';
import {
  cancelSourceRequest,
  editCustomMapPackages,
  mapRequest,
  selectGameFiles,
  sourceRequest,
  upscaleStatus,
} from '../../src/ui/pages/game/state/uiState';

describe('声明式 UI 状态服务', () => {
  it('连续帧相同超分状态只通知一次，关闭后清空', () => {
    upscaleStatus.set(null);
    let updates = 0;
    const unsubscribe = upscaleStatus.subscribe(() => updates++);
    for (let i = 0; i < 60; i++) upscaleStatus.set('AI 超分已启动');
    expect(updates).toBe(1);
    expect(upscaleStatus.getSnapshot()).toBe('AI 超分已启动');
    upscaleStatus.set(null);
    expect(updates).toBe(2);
    unsubscribe();
    upscaleStatus.set('等待');
    expect(updates).toBe(2);
    upscaleStatus.set(null);
  });
  it('快照替换，不把可变 UI 对象或 DOM 交给服务', () => {
    const store = createStore({ busy: false });
    const previous = store.getSnapshot();
    store.set({ busy: true });
    expect(previous.busy).toBe(false);
    expect(store.getSnapshot().busy).toBe(true);
  });
  it('页面卸载结束未完成的资源请求，迟到结果无效', async () => {
    const result = selectGameFiles();
    const request = sourceRequest.getSnapshot()!;
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    cancelSourceRequest();
    await rejected;
    request.cancel();
    expect(sourceRequest.getSnapshot()).toBeNull();
  });
  it('地图请求关闭与替换恰好结算一次，旧回调不能关闭新弹窗', async () => {
    const first = editCustomMapPackages('ra2');
    const old = mapRequest.getSnapshot()!;
    const second = editCustomMapPackages('yr');
    expect(mapRequest.getSnapshot()!.id).not.toBe(old.id);
    expect(await first).toBe(false);
    old.finish(true);
    expect(mapRequest.getSnapshot()?.gameId).toBe('yr');
    mapRequest.getSnapshot()!.finish(true);
    expect(await second).toBe(true);
    expect(mapRequest.getSnapshot()).toBeNull();
  });
});
