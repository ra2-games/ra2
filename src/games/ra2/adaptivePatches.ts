import type { PeImageProbe } from '../../vm86/peProbe';
import { operand, relativeTarget } from '../shared/nativeLayout';
import { asciiEvidence, signature, type NativePatchPlan } from '../shared/nativePatches';
import { le32 } from '../shared/bytes';

/** Timer wait, intro/logo selection and shared cleanup; addresses vary but the full control flow must match. */
export function resolveRa2Movies(image: PeImageProbe): NativePatchPlan | null {
  const m = image.findCode(
    signature(`
    e8 ?? ?? ?? ?? 3b 15 ?? ?? ?? ?? 77 21 72 08 3b 05 ?? ?? ?? ?? 73 17
    e8 ?? ?? ?? ?? 3b 15 ?? ?? ?? ?? 72 f3 77 08 3b 05 ?? ?? ?? ?? 72 e9
    a1 ?? ?? ?? ?? 83 e0 04 3c 04 75 5d 68 ?? ?? ?? ?? e8 ?? ?? ?? ??
    a0 ?? ?? ?? ?? 83 c4 04 a8 08 74 22 57 6a 01 6a 01 6a 01 8b d3 b9 ?? ?? ?? ??
    e8 ?? ?? ?? ?? 8b d3 b9 ?? ?? ?? ?? 57 6a 01 6a 01 57 eb 40
    6a 01 6a 01 6a 01 8b d3 b9 ?? ?? ?? ?? e8 ?? ?? ?? ?? 8b d3 b9 ?? ?? ?? ??
    6a 01 6a 01 57 e8 ?? ?? ?? ?? eb 20 68 ?? ?? ?? ?? e8 ?? ?? ?? ?? 83 c4 04
    8b d3 b9 ?? ?? ?? ?? 57 6a 01 6a 01 6a 01 e8 ?? ?? ?? ?? b2 01 33 c9 e8 ?? ?? ?? ??
  `),
  );
  const label = m && asciiEvidence(image, operand(m, 90), 'WESTLOGO');
  if (
    !m ||
    !label ||
    ![0, 23, 63, 94, 127, 144, 156, 178, 187].every((at) => image.contains(relativeTarget(m, at), 1, 'code'))
  )
    return null;
  return { evidence: [m, label], patches: [{ address: m.address, bytes: [0xe9, ...le32(0xb7 - 5)] }] };
}

/** Verify the sample loop and its round-limit back edge in the same calibration function. */
export function resolveRa2Calibration(image: PeImageProbe): NativePatchPlan | null {
  const m = image.findCode(
    signature(`
    55 8b ec 83 ec 34 53 56 8d 45 cc 33 f6 50 33 db 89 75 fc 89 75 f4 89 75 f0
    ff 15 ?? ?? ?? ?? 85 c0 75 06 5e 5b 8b e5 5d c3 57 eb 03 8b 75 f8
    8b 7d fc 8d 4d d4 47 89 75 ec 8b 35 ?? ?? ?? ?? 51 89 7d fc 89 5d f8 ff d6
    8b 55 d4 8b 45 d8 32 c9 89 55 dc 80 f9 32 89 45 e0 73 13 8d 55 dc 52 ff d6
    8b 45 dc 8b 55 d4 2b c2 83 f8 32 72 ed 0f 31 89 45 e4 8b 4d dc 8b 55 e0
    33 c0 89 4d d4 3d e8 03 00 00 89 55 d8 73 16 8d 4d dc 51 ff d6
    8b 55 dc 8b 4d d4 2b d1 81 fa e8 03 00 00 72 ea 0f 31
  `),
  );
  if (!m) return null;
  const limit = image.findCode(
    signature('8b 45 fc 03 cb 83 f8 03 0f 8c ?? ?? ?? ?? 83 f8 14 7d 3f'),
    (r) =>
      r.address > m.address &&
      r.address < m.address + 0x200 &&
      r.address + 14 + (operand(r, 10) | 0) === m.address + 44,
  );
  if (!limit) return null;
  return {
    evidence: [m, limit],
    patches: [
      { address: m.address + 0x7e, bytes: [0x3d, ...le32(100)] },
      { address: m.address + 0x96, bytes: [0x81, 0xfa, ...le32(100)] },
      { address: limit.address + 14, bytes: [0x83, 0xf8, 3] },
    ],
  };
}
