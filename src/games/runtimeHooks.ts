import type { GameFrameReader } from './performance';
import type { GuestMemory } from '../vm86/win32';
import type { GameControl } from './control';
import type { GuestHook } from '../vm86/guestHooks';

/**
 * Game runtime extensions callable by the VM core.
 * Keep fixed addresses and game semantics in each game's directory; the adapter sees only these optional capabilities.
 */
export interface GameRuntimeHooks {
  createControl?(memory: GuestMemory, reserve: (size: number) => number): GameControl | null;
  /** Resolve executable-local capabilities once after PE loading, before any compatibility writes. */
  resolve?(memory: GuestMemory, executableBytes: Uint8Array): GameRuntimeHooks;
  /** Install game networking code after the shim owns its allocator; false retains native timing. */
  prepareNetwork?(memory: GuestMemory, allocateCode: (code: number[]) => number): boolean;
  /** Detect a read-only native frame counter in the loaded executable; null when structural evidence is insufficient. */
  createFrameReader?(memory: GuestMemory, executableBytes: Uint8Array): GameFrameReader | null;
  /** Version-validated plans, installed after preloading and before guest execution. */
  createGuestHooks?(
    executable: Uint8Array,
    files: ReadonlyMap<string, Uint8Array>,
    memory: GuestMemory,
  ): Promise<readonly { dll: string; hooks: readonly GuestHook[] }[]>;
  /** Apply narrow version-specific compatibility patches after copying the PE image into guest memory and before executing its entry point. */
  prepareImage?(memory: GuestMemory): void;
  /** Explicit startup navigation; the game verifies the target/EXE, and the allocator exclusively owns the static-import-stub tail. */
  prepareStartupPage?(memory: GuestMemory, page: string, reserve: (size: number) => number): void;
  writeGameSpeedFlag?(memory: GuestMemory, value: number): number | null;
  crashHint?(vector: number, eip: number): string;
}
