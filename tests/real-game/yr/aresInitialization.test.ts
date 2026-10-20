import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectPe32 } from '../../../src/vm86/peProbe';
import { expect, it } from 'vitest';
import { supportedGame } from '../../../src/games/catalog';
import { YR_EXTENSION_ABI, yrExtensionArgBytes } from '../../../src/games/yr/extensionAbi';
import { runVmSmoke } from '../helpers/runVmSmoke';
import { resolveGameDir } from '../helpers/gameDir';

it('executes the supplied Ares PROCESS_ATTACH before original YR startup (no hooks)', async () => {
  const path = join(resolveGameDir('yr'), 'Ares.dll');
  const bytes = readFileSync(path);
  expect(inspectPe32(bytes)).not.toBeNull();
  const header = bytes.readUInt32LE(0x3c);
  expect(bytes.readUInt16LE(header + 22) & 0x2000).not.toBe(0);
  const yr = supportedGame('yr');
  await runVmSmoke({
    gameId: 'yr',
    gameDefinition: {
      ...yr,
      abi: YR_EXTENSION_ABI,
      argBytes: yrExtensionArgBytes,
      preloadFiles: [...(yr.preloadFiles ?? []), { path: 'Ares.dll', initializeBeforeEntry: true }],
    },
    timeoutMs: 45000,
    targetCalls: 4000,
    hoverOnly: true,
    memoryBytes: 768 * 1024 * 1024,
  });
}, 90000);
