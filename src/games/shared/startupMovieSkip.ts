import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/**
 * Skip the entire startup-movie selection block to its native shared movie-subsystem cleanup. Campaign briefings and in-game EVA use other call sites and remain unaffected. Return true idempotently if already patched; return false on signature mismatch without blindly writing. Each game supplies the overwrite point, cleanup address, and original instructions.
 */
export function skipStartupMovieBlock(
  memory: GuestMemory,
  block: number,
  continuation: number,
  signature: readonly number[],
): boolean {
  const current = memory.read_memory(block, signature.length);
  const patch = new Uint8Array([0xe9, ...le32(continuation - (block + 5))]);
  if (current.every((byte, index) => byte === patch[index])) return true;
  if (!current.every((byte, index) => byte === signature[index])) return false;
  memory.write_memory(patch, block);
  return true;
}
