/**
 * Fake guest memory for unit tests: a plain Uint8Array implements GuestMemory so Win32Shim can run dispatch-level tests without v86.
 */
import type { GuestMemory } from '../../src/vm86/win32';
import type { PeImport, Win32Call, Win32Result } from '../../src/vm86/win32';
import type { Win32ShimOptions } from '../../src/vm86/win32';
import { Win32Shim } from '../../src/games/win32Shim';
import { RA2_SHIM_PROFILE } from '../../src/games/ra2/profile';
import { YR_SHIM_PROFILE } from '../../src/games/yr/profile';

export interface FakeGuestMemory extends GuestMemory {
  readonly bytes: Uint8Array;
}

export function createGuestMemory(size = 16 * 1024 * 1024): FakeGuestMemory {
  const bytes = new Uint8Array(size);
  return {
    bytes,
    read_memory(offset: number, length: number): Uint8Array {
      return bytes.subarray(offset, offset + length);
    },
    write_memory(data: number[] | Uint8Array, offset: number): void {
      bytes.set(data, offset);
    },
  };
}

/** Shim options with a smaller heap arena: the default 16 MB fake memory fits all test allocations. */
export function createTestShim(
  memory: FakeGuestMemory,
  options: Win32ShimOptions & { gameId?: 'ra2' | 'yr' } = {},
): Win32Shim {
  const { gameId, ...shimOptions } = options;
  const profiles = {
    ra2: RA2_SHIM_PROFILE,
    yr: YR_SHIM_PROFILE,
  } as const;
  return new Win32Shim(memory, {
    heapTop: 0x00c0_0000,
    virtualTop: 0x00c0_0000,
    ...shimOptions,
    gameProfile: shimOptions.gameProfile ?? (gameId ? profiles[gameId] : undefined),
  });
}

/** Dispatch directly by import key, bypassing the IAT/stack to test only semantics. */
export function callShim(shim: Win32Shim, key: string, args: number[] = [], stack = 0): Win32Result {
  const bang = key.indexOf('!');
  const imported: PeImport = {
    id: 1,
    dll: key.slice(0, bang),
    name: key.slice(bang + 1),
    key,
    slot: 0,
    stub: 0,
    argBytes: args.length * 4,
  };
  const call: Win32Call = { imported, stack, args };
  const result = shim.dispatch(call);
  if (!result) throw new Error(`未实现的导入: ${key}`);
  return result;
}

export function readU32(memory: FakeGuestMemory, address: number): number {
  const b = memory.read_memory(address, 4);
  return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
}

export function writeU32(memory: FakeGuestMemory, address: number, value: number): void {
  memory.write_memory([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff], address);
}

export function writeAsciiZ(memory: FakeGuestMemory, address: number, value: string): void {
  const bytes = new Uint8Array(value.length + 1);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0x7f;
  memory.write_memory(bytes, address);
}
