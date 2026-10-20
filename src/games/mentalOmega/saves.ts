import type { GameFileProvider } from '../../resources/contracts';

/** MO's CnCNet build writes slots under Saved Games; older VM saves can be at root. */
export async function listMentalOmegaSaves(files: GameFileProvider): Promise<string[]> {
  files.invalidateCache?.();
  const paths: string[] = [];
  for (const directory of ['', 'Saved Games', 'Save']) {
    for (const name of (await files.list(directory)) ?? []) {
      if (/^[^/\\\r\n\0]+\.sav$/i.test(name)) paths.push(directory ? `${directory}/${name}` : name);
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/** Use the native spawner's LoadSaveGame branch, without starting a scenario first. */
export async function createMentalOmegaLoadFiles(files: GameFileProvider, path: string) {
  if (!(await listMentalOmegaSaves(files)).includes(path)) throw new Error('请选择有效的存档');
  const bytes = await files.read(path);
  if (!bytes?.length) throw new Error('存档文件为空或已不存在');
  // The VM's OLE storage currently cannot decode Windows compound documents.
  // Reject these before boot so a desktop save does not strand the user in a failed load.
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte))
    throw new Error('暂不支持 Windows 桌面版存档，请选择在本网页中保存的存档');
  // The spawner accepts a 60-byte filename and prefixes Saved Games internally.
  // A session-only alias avoids encoding/length issues without changing the user's slot.
  return new Map([
    ['Saved Games/VMLOAD.sav', bytes],
    [
      'SPAWN.INI',
      new TextEncoder().encode(
        '[Settings]\r\nName=Player\r\nLoadSaveGame=yes\r\nSaveGameName=VMLOAD.sav\r\nIsSinglePlayer=yes\r\n',
      ),
    ],
  ]);
}
