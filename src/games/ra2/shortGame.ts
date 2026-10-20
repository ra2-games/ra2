import type { PeImageProbe, ByteSignature } from '../../vm86/peProbe';
import { operand, relativeTarget } from '../shared/nativeLayout';
import type { NativePatchPlan } from '../shared/nativePatches';
import type { GuestMemory } from '../../vm86/win32';

const ADDRESS = 0x004e_4a9c;
const ORIGINAL = new Uint8Array([
  0x8b, 0x0d, 0x48, 0x98, 0x83, 0x00, 0x8d, 0xae, 0x30, 0x54, 0x00, 0x00, 0x8b, 0x99, 0xd4, 0x09, 0x00, 0x00, 0x8b,
  0xcd, 0x8b, 0x13, 0x8b, 0x82, 0x90, 0x0b, 0x00, 0x00, 0x50, 0xe8, 0x52, 0xd2, 0xfa, 0xff, 0x8b, 0x4b, 0x04, 0x8b,
  0xf8, 0x8b, 0x91, 0x90, 0x0b, 0x00, 0x00, 0x8b, 0xcd, 0x52, 0xe8, 0x3f, 0xd2, 0xfa, 0xff, 0x03, 0xf8,
]);

/**
 * RA2 1.006 Short Game counts only BaseUnit[0..1], so Gonghui's third CMCV is created but not counted as a base, causing immediate defeat with zero buildings. Replace 55 bytes in place without changing the EXE or rearranging MOD files. ESI is House; Rules+9D4/9E0 holds BaseUnit data/count; Type+B90 is the unit-type index. House+5430 is the per-type count vector (+4 data, +8 length). Original accessor 491D10 grows and zero-fills out-of-range indexes; treat them as zero directly to avoid allocation, rejecting negative indexes with unsigned comparison. Preserve EBP as the vector, EDI as the total, and the stack; retain building-count/defeat logic from 4E4AD3 onward.
 */
const PATCH = new Uint8Array([
  0xa1,
  0x48,
  0x98,
  0x83,
  0x00, // mov eax,[Rules]
  0x8d,
  0xae,
  0x30,
  0x54,
  0x00,
  0x00, // lea ebp,[esi+5430]
  0x8b,
  0x88,
  0xe0,
  0x09,
  0x00,
  0x00, // mov ecx,[eax+9E0]
  0x8b,
  0x98,
  0xd4,
  0x09,
  0x00,
  0x00, // mov ebx,[eax+9D4]
  0x31,
  0xff, // xor edi,edi
  0x85,
  0xc9,
  0x7e,
  0x17, // Loop: test ecx,ecx / jle done.
  0x49,
  0x8b,
  0x14,
  0x8b, // dec ecx / mov edx,[ebx+ecx*4]
  0x8b,
  0x92,
  0x90,
  0x0b,
  0x00,
  0x00, // mov edx,[edx+B90]
  0x3b,
  0x55,
  0x08,
  0x73,
  0xed, // cmp edx,[ebp+8] / jae loop.
  0x8b,
  0x45,
  0x04, // mov eax,[ebp+4]
  0x03,
  0x3c,
  0x90,
  0xeb,
  0xe5, // add edi,[eax+edx*4] / jmp loop.
  0x90,
  0x90,
  0x90,
]);

/** Write only after checking the entire signature; allow repeated calls and leave mismatching versions or YR bytes untouched. */
export function patchRa2ShortGame(memory: GuestMemory): boolean {
  const current = memory.read_memory(ADDRESS, ORIGINAL.length);
  const matches = (expected: Uint8Array) =>
    current.length === expected.length && current.every((byte, index) => byte === expected[index]);
  if (matches(PATCH)) return true;
  if (!matches(ORIGINAL)) return false;
  memory.write_memory(PATCH, ADDRESS);
  return true;
}

/** Resolve the same two-entry bug only where the complete accessor/layout evidence is present. */
export function resolveRa2ShortGame(image: PeImageProbe, rulesPointer: number): NativePatchPlan | null {
  const pattern: (number | null)[] = [...ORIGINAL];
  for (const offset of [2, 30, 49]) pattern.fill(null, offset, offset + 4);
  const match = image.findCode(
    pattern as ByteSignature,
    (m) =>
      operand(m, 2) === rulesPointer &&
      relativeTarget(m, 29) === relativeTarget(m, 48) &&
      image.contains(relativeTarget(m, 29), 1, 'code'),
  );
  if (!match) return null;
  const bytes = [...PATCH];
  bytes.splice(1, 4, ...[0, 8, 16, 24].map((shift) => (rulesPointer >>> shift) & 255));
  return { evidence: [match], patches: [{ address: match.address, bytes }] };
}
