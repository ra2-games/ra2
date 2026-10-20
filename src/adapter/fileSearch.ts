import type { GameFileProvider } from '../resources/contracts';
import { guestFileSearch, type GuestFileEntry } from '../vm86/shim/fileSearch';
import { readSaveFileLastWriteTime } from './saveTransfer';

/** Obtain matches at the synchronous FindFirstFileA suspension point; subsequent CreateFile calls still load MIX content on demand. */
export async function readGuestFileSearch(files: GameFileProvider, pattern: string): Promise<GuestFileEntry[]> {
  const search = guestFileSearch(pattern);
  const entries: GuestFileEntry[] = [];
  for (const name of (await files.list(search.directory)) ?? []) {
    if (!search.matches(name)) continue;
    const path = search.directory ? `${search.directory}/${name}` : name;
    // Save headers keep their original last-write FILETIME in SGBYSTG1; retrieve enough header bytes to restore it after import.
    const saveFile = path.toLowerCase().endsWith('.sav');
    const info = files.readPrefix ? await files.readPrefix(path, saveFile ? 4096 : 1) : null;
    const data = !files.readPrefix ? await files.read(path) : null;
    if (info || data) {
      const lastWriteTime = saveFile ? readSaveFileLastWriteTime(info?.bytes ?? data!) : null;
      entries.push({
        path,
        size: info?.totalSize ?? data!.length,
        ...(lastWriteTime === null ? {} : { lastWriteTime }),
      });
    } else if ((await files.list(path))?.length) entries.push({ path, size: 0, directory: true });
  }
  return entries;
}
