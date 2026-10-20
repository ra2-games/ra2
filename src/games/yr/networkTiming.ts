import { makeLanStartupTiming, lanTimingCall } from '../shared/lanStartupTiming';
import type { GuestMemory } from '../../vm86/win32';

/** Independently verified YR 1.001 LAN startup paths; retain native Timing and dynamic acknowledgment windows. */
const sites = [
  { address: 0x5b6546, expected: [185, 5, 0, 0, 0, 59, 198, 137, 13, 84, 181, 168, 0] },
  {
    address: 0x5baec5,
    expected: [184, 5, 0, 0, 0, 137, 21, 96, 235, 168, 0, 139, 21, 76, 178, 168, 0, 59, 214, 163, 84, 181, 168, 0],
  },
  { address: 0x5dd2d8, expected: [184, 5, 0, 0, 0, 59, 206, 163, 84, 181, 168, 0] },
  { address: 0x5dd498, expected: [184, 5, 0, 0, 0, 59, 207, 163, 84, 181, 168, 0] },
] as const;

// Shorten native measurement/negotiation scheduling periods while awaiting real reports from both sides and calculating windows from room speed and RTT.
// test cl,127 → test cl,31；mov al,[Frame]; test al,al → test al,63。
const negotiationSites = [
  { address: 0x6476bf, expected: [246, 193, 127, 15, 133, 186, 4, 0, 0], offset: 2, replacement: [31] },
  {
    address: 0x647ba7,
    expected: [160, 132, 237, 168, 0, 132, 192, 15, 133, 130, 3, 0, 0],
    offset: 5,
    replacement: [168, 63],
  },
] as const;

export function installYrLanTiming(memory: GuestMemory, allocateCode: (code: number[]) => number): boolean {
  for (const { address, expected } of [...sites, ...negotiationSites]) {
    const bytes = memory.read_memory(address, expected.length);
    if (bytes.length !== expected.length || !bytes.every((value, i) => value === expected[i])) {
      throw new Error('YR LAN 时序：指令签名不匹配或重复安装');
    }
  }
  // The initial interval participates in native minimum-window calculation; do not change only the receive window or fabricate frame acknowledgments.
  // Allocate exclusively owned guest stubs after all signatures pass; initialize from room speed on every start, allowing negotiation to slow down later.
  const patches = sites.map(({ address, expected }) => ({
    address,
    bytes: lanTimingCall(address, allocateCode(makeLanStartupTiming(0xa8b268, 0xa8b558, expected[0], 2))),
  }));
  for (const { address, bytes } of patches) memory.write_memory(bytes, address);
  for (const { address, offset, replacement } of negotiationSites) {
    memory.write_memory([...replacement], address + offset);
  }
  return true;
}
