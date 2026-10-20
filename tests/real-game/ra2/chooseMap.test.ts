import { expect } from 'vitest';
import type { VmFrame } from '../../../src/vm86/win32';
import { describeVmSmoke, type VmSmokeOptions } from '../helpers/runVmSmoke';
import { RECORDED_ROUTE_RESOLUTION } from '../helpers/sessionIni';

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

describeVmSmoke(
  'RA2 地图列表绘制回归',
  {
    ...options,
    // Select and apply the second map, reopen the map list, and allow old paint messages time to run.
    clicks: [
      [1034, 370],
      [1034, 454],
      [1042, 454],
      [680, 365],
      [1040, 370],
      [1042, 454],
      [100, 100],
    ],
    clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'choosemap', 'choosemap', 'skirmish', 'choosemap'],
    assertFinalFrame: assertMapLists,
  },
  '选图并返回后，两侧列表文字和选中高亮正确',
);

describeVmSmoke(
  'RA2 地图类型切换绘制回归',
  {
    ...options,
    timeoutMs: 90_000,
    // Select a different map first, then repeatedly switch types to clear and repopulate the right-hand list.
    clicks: [
      [1034, 370],
      [1034, 454],
      [1042, 454],
      [680, 425],
      [465, 365],
      [465, 347],
      [465, 365],
      [465, 347],
      [465, 365],
      [465, 347],
      [100, 100],
    ],
    clickPageTitles: [
      'mainmenu',
      'singleplayer',
      'skirmish',
      'choosemap',
      'choosemap',
      'choosemap',
      'choosemap',
      'choosemap',
      'choosemap',
      'choosemap',
      'choosemap',
    ],
    assertFinalFrame: assertMapLists,
  },
  '多次切换左侧类型后，右侧各行文字完整且只有一个选中高亮',
);

function assertMapLists(frame: VmFrame): void {
  expect([frame.width, frame.height]).toEqual([1440, 900]);
  expect(frame.rgba).toBeDefined();
  const rgba = frame.rgba!;
  for (const [name, left, right, rows] of [
    ['模式', 433, 620, 2],
    ['地图', 655, 823, 13],
  ] as const) {
    // Check yellow glyphs in each row separately so a nearly empty list cannot pass on its total count alone.
    for (let row = 0; row < rows; row++) {
      let glyphPixels = 0;
      for (let y = 339 + row * 19; y < 353 + row * 19; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * frame.width + x) * 4;
          if (rgba[offset]! > 180 && rgba[offset + 1]! > 180 && rgba[offset + 2]! < 100) glyphPixels++;
        }
      }
      expect(glyphPixels, `${name}第 ${row + 1} 行文字应完整`).toBeGreaterThan(30);
    }
    // Sample vertically in the text-free row ends; one highlight is about 19 pixels, and extra red bars or ghosts must fail.
    let highlightedHeight = 0;
    for (let y = 338; y < 598; y++) {
      const offset = (y * frame.width + right) * 4;
      if (rgba[offset]! > 200 && rgba[offset + 1]! < 30 && rgba[offset + 2]! < 30) highlightedHeight++;
    }
    expect(highlightedHeight, `${name}列表应有一条选中高亮`).toBeGreaterThanOrEqual(17);
    expect(highlightedHeight, `${name}列表不能有多余高亮或残影`).toBeLessThanOrEqual(20);
  }
}
