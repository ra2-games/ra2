import { it } from 'vitest';
import { supportedGame } from '../../../src/games/catalog';
import { YR_EXTENSION_ABI, yrExtensionArgBytes } from '../../../src/games/yr/extensionAbi';
import { runVmSmoke } from '../helpers/runVmSmoke';

it('initializes the supplied launcher module in the guest', async () => {
  const yr = supportedGame('yr');
  await runVmSmoke({
    gameId: 'yr',
    gameDefinition: {
      ...yr,
      commandLineArguments: '-SPAWN -CD -SPEEDCONTROL',
      abi: YR_EXTENSION_ABI,
      argBytes: yrExtensionArgBytes,
      preloadFiles: [...yr.preloadFiles!, { path: 'cncnet5.dll', initializeBeforeEntry: true }],
    },
    timeoutMs: 60000,
    targetCalls: 4000,
    hoverOnly: true,
    memoryBytes: 2048 * 1024 * 1024,
  });
}, 90000);
