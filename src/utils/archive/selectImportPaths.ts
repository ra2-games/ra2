/** Resolve flattened import names by directory scope before reading any payload. */
export function selectImportPaths<T>(
  entries: readonly T[],
  pathOf: (entry: T) => string,
  keyOf: (path: string) => string | null,
  rejectAnyDuplicate = false,
): Map<string, T> {
  const candidates = new Map<string, { entry: T; path: string; depth: number; alternatives: string[] }>();
  for (const entry of entries) {
    const path = pathOf(entry).replaceAll('\\', '/').replace(/^\.\//, '');
    const key = keyOf(path);
    if (key === null) continue;
    const depth = path.split('/').length - key.split('/').length;
    const previous = candidates.get(key);
    if (previous && rejectAnyDuplicate) throw new Error(`压缩包存在同名文件：${key} (${previous.path}, ${path})`);
    if (!previous || depth < previous.depth) candidates.set(key, { entry, path, depth, alternatives: [] });
    else if (previous.depth === depth) previous.alternatives.push(path);
  }
  for (const [key, candidate] of candidates)
    if (candidate.alternatives.length)
      throw new Error(`Ambiguous import file ${key}: ${[candidate.path, ...candidate.alternatives].join(', ')}`);
  return new Map([...candidates].map(([key, candidate]) => [key, candidate.entry]));
}
