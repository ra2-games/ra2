import { gameResourceExe } from '../helpers/gameDir';
import { supportedGame } from '../../../src/games/catalog';
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { describeVmSmoke, type VmSmokeOptions } from '../helpers/runVmSmoke';
import { RECORDED_ROUTE_RESOLUTION } from '../helpers/sessionIni';

const options: VmSmokeOptions = {
  ini: { resolution: RECORDED_ROUTE_RESOLUTION, playIntro: false },
  executablePath: gameResourceExe('yr'),
  gameId: 'yr',
  memoryBytes: 768 * 1024 * 1024,
  timeoutMs: 60000,
  targetCalls: 4000,
  waitMenuReady: false,
  clicks: [[100, 100]],
  hoverOnly: true,
  clickPageTitles: ['skirmish'],
  settleMessages: 200,
  prepareGuest(memory, exe, reserve) {
    supportedGame('yr').runtimeHooks!.resolve!(memory, exe).prepareStartupPage!(
      memory,
      'skirmish',
      createHash('sha256').update(exe).digest('hex'),
      reserve,
    );
  },
};
describeVmSmoke('YR 启动直达遭遇战', {
  ...options,
  assertFinalState(shim) {
    expect(shim.inspectShellPageTitle()).toContain('Skirmish');
  },
});
describeVmSmoke('YR 直达后选图并返回单人菜单和主菜单', {
  ...options,
  hoverOnly: false,
  finalHoverOnly: true,
  clickGapMessages: 1000,
  // YR settings stay at 800x600; do not reuse absolute 1440x900 coordinates from the RA2 test directory.
  clicks: [
    [722, 304],
    [360, 215],
    [720, 220],
    [714, 556],
    [714, 556],
    [100, 100],
  ],
  clickPageTitles: ['skirmish', 'choosemap', 'choosemap', 'skirmish', 'singleplayer', 'mainmenu'],
  assertFinalState(shim) {
    expect(shim.inspectShellPageTitle()).toContain('MainMenu');
  },
});
