import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';
import { REPO_ROOT } from './gameDir';

/** Explicit local corpus; recursive discovery includes new distributions without a runtime version registry. */
export function executableCorpus() {
  const directory = resolve(REPO_ROOT, process.env.VM_EXE_CORPUS_DIR ?? 'ra2-exe');
  if (!existsSync(directory)) {
    throw new Error(
      `Executable corpus directory ${directory} does not exist; set VM_EXE_CORPUS_DIR to a directory containing ` +
        'game.exe/gamemd.exe (for a single installation, the game directory itself, e.g. VM_EXE_CORPUS_DIR=game/ra2)',
    );
  }
  const files: string[] = [];
  const visit = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') visit(path);
      else if (/^game(?:md)?\.exe(?:\.[a-f0-9]{64})?$/i.test(entry.name)) files.push(path);
    }
  };
  visit(directory);
  if (!files.length) throw new Error(`No original executables in ${directory}`);
  return files.sort().map((path) => {
    const bytes = new Uint8Array(readFileSync(path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const suffix = basename(path).split('.').at(-1)!;
    if (/^[a-f0-9]{64}$/i.test(suffix) && suffix.toLowerCase() !== sha256)
      throw new Error(`EXE digest mismatch: ${path}`);
    return {
      path,
      label: relative(directory, path),
      bytes,
      sha256,
      gameId: basename(path).toLowerCase().startsWith('gamemd.') ? ('yr' as const) : ('ra2' as const),
    };
  });
}
