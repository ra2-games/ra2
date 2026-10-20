import { normalizeGuestPath } from '../paths';

/** Directory metadata is not mounted content; finding MIX files must not prefetch entire movie packages for enumeration. */
export interface GuestFileEntry {
  path: string;
  size: number;
  directory?: boolean;
  /** Embedded SGBYSTG1 last-save FILETIME; used when the host has no per-path Win32 timestamp. */
  lastWriteTime?: bigint;
}

export function guestFileSearch(pattern: string) {
  const normalized = normalizeGuestPath(pattern);
  const slash = normalized.lastIndexOf('/');
  const directory = slash < 0 ? '' : normalized.slice(0, slash);
  const name = normalized.slice(slash + 1);
  // Win32 *.* also matches extensionless files; wildcards apply only to filenames in the current directory.
  const wildcard = name === '*.*' ? '*' : name;
  const regex = new RegExp(
    `^${wildcard
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
      .join('')}$`,
    'i',
  );
  return { normalized, directory, matches: (entry: string) => !/[\\/]/.test(entry) && regex.test(entry) };
}
