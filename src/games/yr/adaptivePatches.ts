import type { PeImageProbe } from '../../vm86/peProbe';
import { operand, relativeTarget } from '../shared/nativeLayout';
import { asciiEvidence, signature, type NativePatchPlan } from '../shared/nativePatches';

export function resolveYrMovies(image: PeImageProbe): NativePatchPlan | null {
  const match = image.findCode(
    signature('8b d5 b9 ?? ?? ?? ?? 53 6a 01 6a 01 6a 01 e8 ?? ?? ?? ?? e8 ?? ?? ?? ??'),
    (m) =>
      !!asciiEvidence(image, operand(m, 3), 'EA_WWLOGO') &&
      [14, 19].every((at) => image.contains(relativeTarget(m, at), 1, 'code')),
  );
  return match
    ? {
        evidence: [match, asciiEvidence(image, operand(match, 3), 'EA_WWLOGO')!],
        patches: [{ address: match.address, bytes: [0xe9, 14, 0, 0, 0] }],
      }
    : null;
}
