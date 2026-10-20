/** Explore add-on subdirectories by extension, but mount only safe basenames at the guest root. */
export function archiveExtensionKey(path: string, extensions: readonly string[]): string | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || normalized.includes(':') || parts.includes('..') || /[\x00-\x1f]/.test(normalized))
    return null;
  const name = parts.at(-1) ?? '';
  return extensions.some((extension) => name.endsWith(extension.toLowerCase())) ? name : null;
}
