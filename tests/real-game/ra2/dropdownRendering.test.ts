import { describeVmSmoke, type VmSmokeOptions } from '../helpers/runVmSmoke';
import { RECORDED_ROUTE_RESOLUTION } from '../helpers/sessionIni';
import { expect } from 'vitest';
import type { VmFrame } from '../../../src/vm86/win32';

function assertScrollbar(frame: VmFrame, x: number, top: number, bottom: number): void {
  expect(frame.rgba).toBeDefined();
  for (const y of [top, bottom]) {
    let bright = 0;
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -5; dx <= 5; dx++) {
        const offset = ((y + dy) * frame.width + x + dx) * 4;
        if (frame.rgba![offset]! > 200 && frame.rgba![offset + 1]! > 150) bright++;
      }
    expect(bright, '上下箭头必须出现在最终画面').toBeGreaterThan(5);
  }
}

const options: VmSmokeOptions = {
  ini: { resolution: RECORDED_ROUTE_RESOLUTION },
  gameId: 'ra2',
  memoryBytes: 768 * 1024 * 1024,
  timeoutMs: 60_000,
  targetCalls: 4_000,
  waitMenuReady: true,
  clickGapMessages: 1_000,
  settleMessages: 200,
};

describeVmSmoke('RA2 国家下拉绘制', {
  ...options,
  clicks: [
    [1034, 370],
    [1034, 454],
    [778, 238],
    [710, 310],
  ],
  clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'skirmish'],
  finalHoverOnly: true,
  assertFinalFrame: (frame) => assertScrollbar(frame, 778, 262, 403),
});

describeVmSmoke('RA2 地图列表滚动条绘制', {
  ...options,
  clicks: [
    [1034, 370],
    [1034, 454],
    [1042, 454],
    [100, 100],
  ],
  clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'choosemap'],
  assertFinalFrame: (frame) => assertScrollbar(frame, 837, 347, 588),
});

describeVmSmoke('RA2 地图列表翻页后选择隐藏条目', {
  ...options,
  clicks: [
    [1034, 370],
    [1034, 454],
    [1042, 454],
    [837, 560],
    [680, 350],
    [100, 100],
  ],
  clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'choosemap', 'choosemap', 'choosemap'],
  assertFinalState(shim) {
    const list = shim
      .inspectControlItems()
      .find((control) => control.className.toLowerCase() === 'listbox' && control.items.length > 13)!;
    expect(list.selection).toBeGreaterThanOrEqual(13);
  },
});

describeVmSmoke('RA2 国家下拉滚到最后一项', {
  ...options,
  finalHoverOnly: true,
  clicks: [
    [1034, 370],
    [1034, 454],
    [778, 238],
    [778, 403],
    [778, 403],
    [778, 403],
    [710, 400],
    [100, 100],
  ],
  clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'skirmish', 'skirmish', 'skirmish', 'skirmish', 'skirmish'],
  assertFinalState(shim) {
    const hwnd = shim.inspectWindowState().find((window) => window.id === 1697)!.hwnd;
    expect(shim.inspectControlItems().find((control) => control.hwnd === hwnd)?.selection).toBe(9);
  },
});

describeVmSmoke('RA2 拖动地图滚动条到底部后选择', {
  ...options,
  clicks: [
    [1034, 370],
    [1034, 454],
    [1042, 454],
    [837, 367],
    [680, 350],
    [100, 100],
  ],
  dragTargets: { 3: [837, 577] },
  clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'choosemap', 'choosemap', 'choosemap'],
  finalHoverOnly: true,
  assertFinalState(shim) {
    const list = shim
      .inspectControlItems()
      .find((control) => control.className.toLowerCase() === 'listbox' && control.items.length > 13)!;
    expect(list.selection).toBe(list.items.length - 13);
  },
});
