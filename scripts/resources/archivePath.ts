import { isAbsolute, relative, sep } from 'node:path';

export interface ArchivePathApi {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const hostPath: ArchivePathApi = { relative, isAbsolute, sep };

/** Whether the archive target is a nonempty relative path under the root directory. */
export function isArchiveTargetWithinRoot(root: string, target: string, pathApi: ArchivePathApi = hostPath): boolean {
  const relativeTarget = pathApi.relative(root, target);
  return (
    relativeTarget !== '' &&
    relativeTarget !== '..' &&
    !relativeTarget.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relativeTarget)
  );
}
