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
  'RA2 遭遇战地图玩家席位回归',
  {
    ...options,
    clicks: [
      [1034, 370],
      [1034, 454],
      [100, 100],
    ],
    clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish'],
    assertFinalFrame: (frame) => assertPlayerRows(frame, 2),
  },
  '两人地图只显示两个玩家席位',
);

describeVmSmoke(
  'RA2 遭遇战切换四人地图',
  {
    ...options,
    clicks: [
      [1034, 370],
      [1034, 454],
      [1042, 454],
      [680, 520],
      [1040, 370],
      [100, 100],
    ],
    clickPageTitles: ['mainmenu', 'singleplayer', 'skirmish', 'choosemap', 'choosemap', 'skirmish'],
    assertFinalFrame: (frame) => assertPlayerRows(frame, 4),
  },
  '选择 South Pacific (2-4) 后显示四个完整席位',
);

function assertPlayerRows(frame: VmFrame, players: number): void {
  expect([frame.width, frame.height]).toEqual([1440, 900]);
  expect(frame.rgba).toBeDefined();
  const rgba = frame.rgba!;
  for (let slot = 0; slot < 8; slot++) {
    for (const [name, left, right] of [
      ['玩家', 453, 605],
      ['国家', 669, 789],
      ['颜色', 795, 851],
    ] as const) {
      let redPixels = 0;
      for (let y = 228 + slot * 26; y < 251 + slot * 26; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * frame.width + x) * 4;
          if (rgba[offset]! > 180 && rgba[offset + 1]! < 70 && rgba[offset + 2]! < 70) redPixels++;
        }
      }
      if (slot < players) expect(redPixels, `第 ${slot + 1} 排${name}应可见`).toBeGreaterThan(5);
      else expect(redPixels, `第 ${slot + 1} 排${name}不应绘制`).toBe(0);
    }
  }
}
