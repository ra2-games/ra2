import { gameResourceExe } from '../helpers/gameDir';
import { supportedGame } from '../../../src/games/catalog';
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { describeVmSmoke, type VmSmokeOptions } from '../helpers/runVmSmoke';
import { RECORDED_ROUTE_RESOLUTION } from '../helpers/sessionIni';

const options: VmSmokeOptions = {
  ini: { resolution: RECORDED_ROUTE_RESOLUTION },
  executablePath: gameResourceExe('ra2'),
  gameId: 'ra2',
  memoryBytes: 768 * 1024 * 1024,
  timeoutMs: 60000,
  targetCalls: 4000,
  clickGapMessages: 1000,
  waitMenuReady: false,
  clicks: [[100, 100]],
  hoverOnly: true,
  clickPageTitles: ['skirmish'],
  settleMessages: 200,
  prepareGuest(memory, exe, reserve) {
    supportedGame('ra2').runtimeHooks!.resolve!(memory, exe).prepareStartupPage!(
      memory,
      'skirmish',
      createHash('sha256').update(exe).digest('hex'),
      reserve,
    );
  },
};
describeVmSmoke('RA2 启动直达遭遇战', {
  ...options,
  assertFinalState(shim) {
    expect(shim.inspectWindowState().some((w) => w.id === 1684 && w.text.includes('Skirmish'))).toBe(true);
  },
});

describeVmSmoke('RA2 直达后国家下拉可以选择最后一项', {
  ...options,
  hoverOnly: false,
  finalHoverOnly: true,
  clicks: [
    [778, 238],
    [778, 403],
    [778, 403],
    [778, 403],
    [710, 400],
    [100, 100],
  ],
  clickPageTitles: Array(6).fill('skirmish'),
  assertFinalState(shim) {
    const hwnd = shim.inspectWindowState().find((w) => w.id === 1697)!.hwnd;
    expect(shim.inspectControlItems().find((c) => c.hwnd === hwnd)?.selection).toBe(9);
  },
});
describeVmSmoke('RA2 直达后选图、返回单人菜单和主菜单', {
  ...options,
  hoverOnly: false,
  finalHoverOnly: true,
  clicks: [
    [1042, 454],
    [680, 365],
    [1040, 370],
    [1034, 706],
    [1034, 706],
    [100, 100],
  ],
  clickPageTitles: ['skirmish', 'choosemap', 'choosemap', 'skirmish', 'singleplayer', 'mainmenu'],
  assertFinalState(shim) {
    expect(shim.inspectShellPageTitle()).toContain('MainMenu');
  },
});
