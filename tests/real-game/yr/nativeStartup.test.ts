import { expect, it } from 'vitest';
import { gameResourceExe } from '../helpers/gameDir';
import { runVmSmoke } from '../helpers/runVmSmoke';

it('reaches the actual YR main menu without direct-page navigation', async () => {
  const executablePath = gameResourceExe('yr');
  await runVmSmoke({
    executablePath,
    gameId: 'yr',
    ini: { playIntro: false },
    timeoutMs: 60000,
    memoryBytes: 768 * 1024 * 1024,
    hoverOnly: true,
    clicks: [[100, 100]],
    clickPageTitles: ['mainmenu'],
    targetCalls: 4000,
    settleMessages: 200,
    readyToFinish: (shim) => shim.inspectShellPageTitle().toLowerCase().includes('mainmenu'),
    assertFinalState: (shim) => expect(shim.inspectShellPageTitle().toLowerCase()).toContain('mainmenu'),
  });
}, 120000);
