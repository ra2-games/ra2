/** Fold DOS/Win32 paths into root-relative paths matching case-insensitive resource tables on Linux hosts. */
export function normalizeWindowsPath(path: string): string {
  const slashes = path
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of slashes.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').toLowerCase();
}
