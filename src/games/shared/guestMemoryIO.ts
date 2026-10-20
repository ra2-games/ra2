import type { GuestMemory } from '../../vm86/win32';

/**
 * Fixed-width little-endian guest-memory access. The caller verifies readability first; GuestMemory throws on out-of-bounds access, and this layer does not swallow errors.
 */
export function readU32(memory: GuestMemory, address: number): number {
  const bytes = memory.read_memory(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

export function writeU32(memory: GuestMemory, address: number, value: number): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  memory.write_memory(bytes, address);
}
