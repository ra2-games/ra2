import { makeLanStartupTiming, lanTimingCall } from '../shared/lanStartupTiming';
import type { GuestMemory } from '../../vm86/win32';

/**
 * RA2 1.006's four LAN startup paths. Initial intervals also feed the native minimum-window calculation; subsequent Timing events retain original negotiation without fixing MaxAhead or bypassing acknowledgments.
 */
const sites = [
  { address: 0x597ba6, expected: [185, 5, 0, 0, 0, 59, 198, 137, 13, 100, 213, 163, 0] },
  {
    address: 0x59c4ef,
    expected: [184, 5, 0, 0, 0, 137, 21, 24, 11, 164, 0, 139, 21, 172, 210, 163, 0, 59, 214, 163, 100, 213, 163, 0],
  },
  { address: 0x5bde16, expected: [184, 5, 0, 0, 0, 59, 206, 163, 100, 213, 163, 0] },
  { address: 0x5bdfd0, expected: [184, 5, 0, 0, 0, 59, 207, 163, 100, 213, 163, 0] },
] as const;

// Shorten native measurement/negotiation scheduling periods while awaiting real reports from both sides and calculating windows from room speed and RTT.
// test cl,127 → test cl,31；mov al,[Frame]; test al,al → test al,63。
const negotiationSites = [
  { address: 0x623bcf, expected: [246, 193, 127, 15, 133, 186, 4, 0, 0], offset: 2, replacement: [31] },
  {
    address: 0x6240b7,
    expected: [160, 44, 13, 164, 0, 132, 192, 15, 133, 130, 3, 0, 0],
    offset: 5,
    replacement: [168, 63],
  },
] as const;

export function installRa2LanTiming(memory: GuestMemory, allocateCode: (code: number[]) => number): boolean {
  // Validate every target before modifying the loaded image.
  for (const { address, expected } of [...sites, ...negotiationSites]) {
    const bytes = memory.read_memory(address, expected.length);
    if (bytes.length !== expected.length || !bytes.every((value, i) => value === expected[i])) {
      throw new Error('RA2 LAN 时序：指令签名不匹配或重复安装');
    }
  }
  // The 50ms RTT comparison retains 3 frames to balance waiting and synchronization margin; clocks and acknowledgments stay unchanged.
  // Allocate exclusively owned guest stubs after all signatures pass; initialize from room speed on every start, allowing negotiation to slow down later.
  const patches = sites.map(({ address, expected }) => ({
    address,
    bytes: lanTimingCall(address, allocateCode(makeLanStartupTiming(0xa3d2c8, 0xa3d568, expected[0], 3))),
  }));
  for (const { address, bytes } of patches) memory.write_memory(bytes, address);
  for (const { address, offset, replacement } of negotiationSites) {
    memory.write_memory([...replacement], address + offset);
  }
  return true;
}
