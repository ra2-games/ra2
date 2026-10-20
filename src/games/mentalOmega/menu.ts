import type { GameFileProvider } from '../../resources/contracts';

type Section = Record<string, string>;
function ini(bytes: Uint8Array): Map<string, Section> {
  const sections = new Map<string, Section>();
  let section: Section = Object.create(null);
  for (const raw of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const key = header[1]!.toLowerCase();
      section = sections.get(key) ?? Object.create(null);
      sections.set(key, section);
    } else {
      const split = line.indexOf('=');
      if (split > 0) section[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
    }
  }
  return sections;
}

export interface MentalOmegaMission {
  id: string;
  title: string;
  description: string;
  scenario: string;
  side: number;
}
export interface MentalOmegaMap {
  id: string;
  title: string;
  path: string;
  players: number;
}
export interface MentalOmegaMenu {
  missions: MentalOmegaMission[];
  maps: MentalOmegaMap[];
  sides: string[];
}
export interface MentalOmegaSelection {
  mode: 'campaign' | 'skirmish';
  id: string;
  side: number;
  opponents: number;
  difficulty: number;
  credits: number;
  speed: number;
}

/** Read the release's own client catalog; never substitute a hard-coded mission. */
export async function readMentalOmegaMenu(files: GameFileProvider): Promise<MentalOmegaMenu> {
  const [battle, maps, options] = await Promise.all([
    files.read('INI/BattleClient.ini'),
    files.read('INI/MentalOmegaMaps.ini'),
    files.read('Resources/GameOptions.ini'),
  ]);
  if (!battle || !maps || !options)
    throw new Error('心灵终结目录缺少 INI/BattleClient.ini、INI/MentalOmegaMaps.ini 或 Resources/GameOptions.ini');
  const missionsIni = ini(battle),
    mapsIni = ini(maps);
  const missions = Object.values(missionsIni.get('battles') ?? {}).flatMap((id) => {
    const entry = missionsIni.get(id.toLowerCase());
    const scenario = entry?.scenario;
    if (!scenario || !/^[\w.-]+\.(map|yrm)$/i.test(scenario)) return [];
    return [
      {
        id,
        title: entry.description || id,
        description: (entry.longdescription || '').replaceAll('@', '\n'),
        scenario,
        side: Number(entry.side || 0),
      },
    ];
  });
  const mapEntries = Object.values(mapsIni.get('multimaps') ?? {}).flatMap((path) => {
    const entry = mapsIni.get(path.toLowerCase());
    if (!entry || !entry.gamemodes?.split(',').some((mode) => mode.trim() === 'Standard')) return [];
    const normalized = path.replaceAll('\\', '/');
    if (!/^MapsMO\/Standard\/[\w.-]+$/i.test(normalized)) return [];
    const players = Number(entry.maxplayers);
    if (!Number.isInteger(players) || players < 2 || players > 8) return [];
    return [{ id: path, title: entry.description || path, path: `${normalized}.map`, players }];
  });
  const sides = (ini(options).get('general')?.sides ?? '')
    .split(',')
    .map((side) => side.trim())
    .filter(Boolean);
  if (!missions.length || !mapEntries.length || !sides.length)
    throw new Error('心灵终结任务或地图列表为空，请选择完整安装目录');
  return { missions, maps: mapEntries, sides };
}

/** Build only session overlays after an explicit menu selection. */
export async function createMentalOmegaLaunchFiles(
  files: GameFileProvider,
  menu: MentalOmegaMenu,
  selection: MentalOmegaSelection,
): Promise<Map<string, Uint8Array>> {
  const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (!integer(selection.speed, 0, 6) || !integer(selection.difficulty, 0, 2)) throw new Error('无效的游戏速度或难度');
  const mission = selection.mode === 'campaign' ? menu.missions.find((entry) => entry.id === selection.id) : undefined;
  const map = selection.mode === 'skirmish' ? menu.maps.find((entry) => entry.id === selection.id) : undefined;
  if (!mission && !map) throw new Error('请选择有效的任务或地图');
  const result = new Map<string, Uint8Array>();
  const lines = ['[Settings]', 'Name=Player', `GameSpeed=${selection.speed}`, 'BuildOffAlly=yes', 'Color=0'];
  if (mission) {
    lines.push(`Scenario=${mission.scenario}`, 'IsSinglePlayer=yes', `Side=${mission.side}`);
  } else if (map) {
    if (
      !integer(selection.side, 0, menu.sides.length - 1) ||
      !integer(selection.opponents, 1, map.players - 1) ||
      !integer(selection.credits, 1000, 100000)
    )
      throw new Error('无效的遭遇战设置');
    const bytes = await files.read(map.path);
    if (!bytes?.length) throw new Error(`地图文件缺失：${map.path}`);
    // The native spawner's scenario buffer is 32 bytes; use a short session alias.
    result.set('SPAWNMAP.INI', bytes.slice());
    // CnCNet PlayerInfo.HouseHandicapAILevel: native 0=hard, 2=easy.
    const handicap = 2 - selection.difficulty;
    lines.push(
      'Scenario=SPAWNMAP.INI',
      'IsSinglePlayer=no',
      `Side=${selection.side}`,
      `AIPlayers=${selection.opponents}`,
      `AIDifficulty=${handicap}`,
      `Credits=${selection.credits}`,
      'GameMode=1',
      'Bases=yes',
      'UnitCount=0',
      'ShortGame=yes',
      'MCVRedeploy=yes',
      'Superweapons=yes',
      'Seed=' + crypto.getRandomValues(new Uint32Array(1))[0],
    );
    lines.push('', '[HouseHandicaps]');
    for (let i = 1; i <= selection.opponents; i++) lines.push(`Multi${i + 1}=${handicap}`);
  }
  result.set('SPAWN.INI', new TextEncoder().encode(lines.join('\r\n') + '\r\n'));
  return result;
}
