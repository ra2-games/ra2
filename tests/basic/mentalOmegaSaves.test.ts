import { expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { createMentalOmegaLoadFiles, listMentalOmegaSaves } from '../../src/games/mentalOmega/saves';

it('lists slots at root and in Saved Games without listing unrelated files', async () => {
  const files = new MemoryGameFileProvider(
    new Map([
      ['one.sav', Uint8Array.of(1)],
      ['Saved Games/two.sav', Uint8Array.of(2)],
      ['Saved Games/saves.txt', Uint8Array.of(3)],
      ['Save/three.sav', Uint8Array.of(4)],
    ]),
  );
  expect((await listMentalOmegaSaves(files)).map((path) => path.toLowerCase()).sort()).toEqual([
    'one.sav',
    'save/three.sav',
    'saved games/two.sav',
  ]);
  const path = (await listMentalOmegaSaves(files)).find((path) => path.endsWith('two.sav'))!;
  const launch = await createMentalOmegaLoadFiles(files, path);
  expect(launch.get('Saved Games/VMLOAD.sav')).toEqual(Uint8Array.of(2));
  const ini = new TextDecoder().decode(launch.get('SPAWN.INI'));
  expect(ini).toContain('LoadSaveGame=yes');
  expect(ini).toContain('SaveGameName=VMLOAD.sav');
  expect(ini).not.toContain('Scenario=');
  expect(await files.read('Saved Games/VMLOAD.sav')).toBeNull();
});

it('rejects missing and empty saves instead of launching a new scenario', async () => {
  const files = new MemoryGameFileProvider(new Map([['empty.sav', new Uint8Array()]]));
  await expect(createMentalOmegaLoadFiles(files, '../bad.sav')).rejects.toThrow();
  await expect(createMentalOmegaLoadFiles(files, 'missing.sav')).rejects.toThrow();
  await expect(createMentalOmegaLoadFiles(files, 'empty.sav')).rejects.toThrow();
});

it('reports unsupported desktop containers before starting the VM', async () => {
  const files = new MemoryGameFileProvider(
    new Map([['desktop.sav', Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)]]),
  );
  await expect(createMentalOmegaLoadFiles(files, 'desktop.sav')).rejects.toThrow('Windows');
});
