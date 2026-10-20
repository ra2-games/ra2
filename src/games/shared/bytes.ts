/**
 * Split a little-endian 32-bit value into four bytes. Share this definition between trampoline constants and patch bytes; previously duplicated per-game implementations could diverge without failing tests.
 */
export const le32 = (value: number): number[] => [0, 8, 16, 24].map((shift) => (value >>> shift) & 255);
