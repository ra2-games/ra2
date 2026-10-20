import { expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import {
  createMentalOmegaLaunchFiles,
  readMentalOmegaMenu,
  type MentalOmegaSelection,
} from '../../src/games/mentalOmega/menu';

function resources() {
  return new MemoryGameFileProvider(
    new Map(
      Object.entries({
        'INI/BattleClient.ini':
          '[Battles]\n0=heading\n1=one\n2=two\n[heading]\nDescription=Heading\n[one]\nScenario=FIRST.MAP\nDescription=First\nSide=0\n[two]\nScenario=SECOND.MAP\nDescription=Second\nSide=3\nLongDescription=Briefing@Objective',
        'INI/MentalOmegaMaps.ini':
          '[MultiMaps]\n0=MapsMO\\Standard\\test\n[MapsMO\\Standard\\test]\nDescription=Test map\nMaxPlayers=4\nGameModes=Standard,No Bases',
        'Resources/GameOptions.ini': '[General]\nSides=Alpha,Beta',
        'MapsMO/Standard/test.map': '[Map]\nSize=0,0,80,80',
      }).map(([path, value]) => [path, new TextEncoder().encode(value)]),
    ),
  );
}
const selection: MentalOmegaSelection = {
  mode: 'campaign',
  id: 'two',
  side: 0,
  opponents: 1,
  difficulty: 1,
  credits: 10000,
  speed: 2,
};

it('uses the selected mission from the installation instead of forcing mission one', async () => {
  const files = resources(),
    menu = await readMentalOmegaMenu(files);
  expect(menu.missions.map((mission) => mission.title)).toEqual(['First', 'Second']);
  const result = await createMentalOmegaLaunchFiles(files, menu, selection);
  expect(new TextDecoder().decode(result.get('SPAWN.INI'))).toContain(
    'Scenario=SECOND.MAP\r\nIsSinglePlayer=yes\r\nSide=3',
  );
  expect(await files.read('SPAWN.INI')).toBeNull();
  await expect(createMentalOmegaLaunchFiles(files, menu, { ...selection, id: 'missing' })).rejects.toThrow();
});

it('mounts the selected map and enforces its player limit without modifying the installation', async () => {
  const files = resources(),
    menu = await readMentalOmegaMenu(files);
  const choice = {
    ...selection,
    mode: 'skirmish' as const,
    id: menu.maps[0]!.id,
    side: 1,
    opponents: 3,
    credits: 20000,
  };
  const result = await createMentalOmegaLaunchFiles(files, menu, choice);
  const text = new TextDecoder().decode(result.get('SPAWN.INI'));
  expect(text).toContain('Scenario=SPAWNMAP.INI');
  expect(text).toContain('AIPlayers=3');
  expect(text).toContain('Side=1');
  expect(text).toContain('Credits=20000');
  expect(result.get('SPAWNMAP.INI')).toEqual(await files.read('MapsMO/Standard/test.map'));
  expect(await files.read('SPAWNMAP.INI')).toBeNull();
  for (const difficulty of [0, 1, 2]) {
    const launch = await createMentalOmegaLaunchFiles(files, menu, { ...choice, difficulty });
    const settings = new TextDecoder().decode(launch.get('SPAWN.INI'));
    expect(settings).toContain(`AIDifficulty=${2 - difficulty}\r\n`);
    expect(settings).toContain(`Multi4=${2 - difficulty}\r\n`);
  }
  await expect(createMentalOmegaLaunchFiles(files, menu, { ...choice, opponents: 4 })).rejects.toThrow();
  await expect(createMentalOmegaLaunchFiles(files, menu, { ...choice, side: 9 })).rejects.toThrow();
});
