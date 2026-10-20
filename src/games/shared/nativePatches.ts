import type { ByteSignature, PeImageProbe, PeProbeBytes } from '../../vm86/peProbe';
import type { GuestMemory } from '../../vm86/win32';
import { matchesLoaded } from './nativeLayout';

export const signature = (hex: string): ByteSignature =>
  hex
    .trim()
    .split(/\s+/)
    .map((b) => (b === '??' ? null : Number.parseInt(b, 16)));
export interface NativePatch {
  address: number;
  bytes: readonly number[];
}
export interface NativePatchPlan {
  evidence: readonly PeProbeBytes[];
  patches: readonly NativePatch[];
}

/** Validate the complete plan before the first write. Never accept a partially installed plan. */
export function applyNativePatches(memory: GuestMemory, plan: NativePatchPlan | null): boolean {
  if (!plan || !matchesLoaded(memory, plan.evidence)) return false;
  for (const patch of plan.patches) memory.write_memory([...patch.bytes], patch.address);
  return true;
}

export function asciiEvidence(image: PeImageProbe, address: number, text: string): PeProbeBytes | null {
  const bytes = image.read(address, text.length + 1, 'readonly') ?? image.read(address, text.length + 1, 'data');
  return bytes && [...text, '\0'].every((c, i) => bytes.bytes[i] === c.charCodeAt(0)) ? bytes : null;
}
