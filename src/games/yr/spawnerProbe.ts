import type { PeImageProbe } from '../../vm86/peProbe';
import type { GuestMemory } from '../../vm86/win32';
import { le32 } from '../shared/bytes';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/**
 * Experimental probe, not a Spawner implementation; absent from default startup.
 * Location evidence: CnCNet/yrpp-spawner d65600eeb77dc9401999d90a29f950d1f63f374d, WinMain_SpawnerInit in src/Spawner/Spawner.Hook.cpp. Its GPL implementation was not copied; this trampoline was independently written from YR instructions running in the VM. It only counts and continues unchanged, without initializing matches or networking.
 */
export const YR_SPAWNER_PROBE_SITE = 0x006b_d7c5;
/** The probe and direct-page installer verify the same YR EXE using YR_STARTUP_PAGE_HASH. */
export const YR_SPAWNER_PROBE_EXE_SHA256 = YR_STARTUP_PAGE_HASH;
const signature = new Uint8Array([
  0x8b,
  0x35,
  0xd0,
  0xc1,
  0x81,
  0x00, // mov esi,[0x81c1d0]: all six bytes, with no relative addressing.
  0xb9,
  0xfe,
  0xff,
  0xff,
  0xff,
  0xe8,
  0xdb,
  0xb8,
  0xdb,
  0xff,
  0x6a,
  0x28,
  0xe8,
  0x3b,
  0xb6,
  0x10,
  0x00,
  0x83,
]);

/**
 * Version evidence for an executable other than the reference build: the complete signature, including its absolute
 * operand and both relative call displacements, must occur exactly once in executable sections and exactly at the probe
 * site. Distributions that only differ elsewhere (for example the Steam 1.006TUC repack) keep this code byte-identical.
 */
function hasUniqueSiteSignature(image: PeImageProbe | null | undefined): boolean {
  return image?.findCode([...signature])?.address === YR_SPAWNER_PROBE_SITE;
}

/**
 * Install only before first execution with an exclusive stub-region allocator. The caller must supply either the
 * reference EXE hash or the executable's PE image, whose unique site signature is verified before memory is touched.
 */
export function installYrSpawnerProbe(
  memory: GuestMemory,
  executableSha256: string,
  reserve: (bytes: number) => number,
  image?: PeImageProbe | null,
): { address: number; countAddress: number; stackAddress: number } {
  if (executableSha256 !== YR_SPAWNER_PROBE_EXE_SHA256 && !hasUniqueSiteSignature(image)) {
    throw new Error('YR Spawner 探针：EXE 哈希不匹配，且映像中没有唯一的入口签名');
  }
  const current = memory.read_memory(YR_SPAWNER_PROBE_SITE, signature.length);
  if (current.length !== signature.length || !current.every((byte, index) => byte === signature[index])) {
    throw new Error('YR Spawner 探针：入口字节签名不匹配（或已安装）');
  }
  const address = reserve(96);
  // Accept only this project's startup-stub region; an apparently zero-filled game address is not an available code cave.
  if (!Number.isInteger(address) || address < 0x80000 || address + 96 > 0xc0000 || address % 16) {
    throw new Error('YR Spawner 探针：分配地址不在对齐的启动桩区');
  }
  const scratch = memory.read_memory(address, 96);
  if (scratch.length !== 96 || scratch.some((byte) => byte !== 0)) throw new Error('YR Spawner 探针：桩区已占用');
  const countAddress = address + 64,
    stackAddress = address + 68;
  const code = [
    0x9c,
    0x60, // pushfd / pushad: preserve original context.
    0xff,
    0x05,
    ...le32(countAddress), // inc dword [count]
    0x8b,
    0x44,
    0x24,
    0x0c, // mov eax,[esp+12]: ESP saved by pushad.
    0x83,
    0xc0,
    0x04, // Add back pushfd's four bytes to recover entry ESP.
    0xa3,
    ...le32(stackAddress),
    0x61,
    0x9d, // popad / popfd: preserve registers and arithmetic flags.
    ...signature.subarray(0, 6), // Replay the complete original instruction; relative CALL/JMP instructions cannot be copied generically.
  ];
  code.push(0xe9, ...le32(YR_SPAWNER_PROBE_SITE + 6 - (address + code.length + 5)));
  const storage = new Uint8Array(96);
  storage.set(code);
  memory.write_memory(storage, address);
  // Publish the entry jump last; preserve original file and continuation bytes.
  memory.write_memory(
    new Uint8Array([0xe9, ...le32(address - (YR_SPAWNER_PROBE_SITE + 5)), 0x90]),
    YR_SPAWNER_PROBE_SITE,
  );
  return { address, countAddress, stackAddress };
}
