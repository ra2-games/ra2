import { createMentalOmegaLaunchFiles, readMentalOmegaMenu } from '../../../src/games/mentalOmega/menu';
import { InstallationFiles } from '../helpers/installationFiles';
import { resolveGameDir } from '../helpers/gameDir';
import { expect, it } from 'vitest';
import { runVmSmoke } from '../helpers/runVmSmoke';

it.each(['campaign', 'skirmish'] as const)(
  'starts Mental Omega %s and advances the native simulation',
  async (mode) => {
    const files = new InstallationFiles(resolveGameDir('mo'), true);
    const menu = await readMentalOmegaMenu(files);
    const launchFiles = await createMentalOmegaLaunchFiles(files, menu, {
      mode,
      id: mode === 'campaign' ? menu.missions[0]!.id : menu.maps[0]!.id,
      side: 0,
      opponents: 1,
      difficulty: 1,
      credits: 10000,
      speed: 2,
    });
    await runVmSmoke({
      gameId: 'mo',
      clickPageTitles: [''],
      clicks: [[400, 300]],
      ini: { resolution: { width: 800, height: 600 } },
      timeoutMs: 300000,
      targetCalls: 30000,
      settleMessages: 0,
      guestFiles: launchFiles,
      readyForInput: (_shim, memory) =>
        new DataView(memory.read_memory(0xa8ed84, 4).slice().buffer).getUint32(0, true) > 0,
      readyToFinish: (_shim, memory) =>
        new DataView(memory.read_memory(0xa8ed84, 4).slice().buffer).getUint32(0, true) > 120,
      assertFinalState: (_shim, memory) => {
        const read = (address: number) =>
          new DataView(memory.read_memory(address, 4).slice().buffer).getUint32(0, true);
        expect(read(0xa8ed84)).toBeGreaterThan(120);
        const house = read(0xa83d4c);
        expect(house).toBeGreaterThan(0);
        expect(memory.read_memory(house + 0x1ec, 1)[0]).toBe(1);
        expect(memory.read_memory(house + 0x1f5, 1)[0]).toBe(0);
      },
      hoverOnly: true,
    });
  },
  330000,
);
