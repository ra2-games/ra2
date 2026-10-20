/** An opcode signature may wildcard operands, but must have one unique match in executable sections. */
export type ByteSignature = readonly (number | null)[];

export interface PeProbeBytes {
  address: number;
  bytes: Uint8Array;
}

interface ProbeSection extends PeProbeBytes {
  mappedSize: number;
  characteristics: number;
}

type SectionKind = 'code' | 'data' | 'readonly';

function hasKind(section: ProbeSection, kind: SectionKind): boolean {
  const read = (section.characteristics & 0x40000000) !== 0;
  const write = (section.characteristics & 0x80000000) !== 0;
  const execute = (section.characteristics & 0x20000000) !== 0;
  return read && (kind === 'code' ? execute && !write : !execute && write === (kind === 'data'));
}

/** Inspects the preferred-base image used by loadPe; it does not relocate, unpack, or modify an image. */
export class PeImageProbe {
  constructor(private readonly sections: readonly ProbeSection[]) {}

  contains(address: number, length: number, kind: SectionKind): boolean {
    return (
      length > 0 &&
      this.sections.some(
        (section) =>
          hasKind(section, kind) &&
          address >= section.address &&
          address + length <= section.address + section.mappedSize,
      )
    );
  }

  read(address: number, length: number, kind: SectionKind): PeProbeBytes | null {
    const section = this.sections.find(
      (section) =>
        hasKind(section, kind) &&
        address >= section.address &&
        address + length <= section.address + section.bytes.length,
    );
    if (!section || length <= 0) return null;
    const offset = address - section.address;
    return { address, bytes: section.bytes.subarray(offset, offset + length) };
  }

  findCode(signature: ByteSignature, accepts: (match: PeProbeBytes) => boolean = () => true): PeProbeBytes | null {
    if (!signature.length) return null;
    let found: PeProbeBytes | null = null;
    for (const section of this.sections) {
      if (!hasKind(section, 'code')) continue;
      const bytes = section.bytes;
      for (let offset = 0; offset <= bytes.length - signature.length; offset++) {
        if (signature[0] !== null && bytes[offset] !== signature[0]) continue;
        if (!signature.every((byte, i) => byte === null || byte === bytes[offset + i])) continue;
        const match = { address: section.address + offset, bytes: bytes.subarray(offset, offset + signature.length) };
        if (!accepts(match)) continue;
        if (found) return null;
        found = match;
      }
    }
    return found;
  }
}

/** Reject truncated/overlapping sections and unsupported PE formats before scanning any code. */
export function inspectPe32(exe: Uint8Array): PeImageProbe | null {
  const fits = (offset: number, size: number) => offset >= 0 && size >= 0 && offset + size <= exe.length;
  try {
    const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
    if (!fits(0, 0x40) || view.getUint16(0, true) !== 0x5a4d) return null;
    const pe = view.getUint32(0x3c, true);
    if (!fits(pe, 24) || view.getUint32(pe, true) !== 0x4550 || view.getUint16(pe + 4, true) !== 0x14c) return null;
    const count = view.getUint16(pe + 6, true);
    const optionalSize = view.getUint16(pe + 20, true);
    const optional = pe + 24;
    if (count === 0 || count > 96 || optionalSize < 96 || !fits(optional, optionalSize)) return null;
    if (view.getUint16(optional, true) !== 0x10b) return null;
    const base = view.getUint32(optional + 28, true);
    const size = view.getUint32(optional + 56, true);
    const headers = view.getUint32(optional + 60, true);
    const table = optional + optionalSize;
    if (!base || !size || base + size > 0x100000000 || headers > size || !fits(0, headers)) return null;
    if (!fits(table, count * 40) || table + count * 40 > headers) return null;
    const sections: ProbeSection[] = [];
    const rawRanges: { start: number; end: number }[] = [];
    for (let i = 0; i < count; i++) {
      const entry = table + i * 40;
      const rva = view.getUint32(entry + 12, true);
      const rawSize = view.getUint32(entry + 16, true);
      const rawOffset = view.getUint32(entry + 20, true);
      const mappedSize = Math.max(view.getUint32(entry + 8, true), rawSize);
      if (!mappedSize) continue;
      if (rva < headers || rva + mappedSize > size) return null;
      const address = base + rva;
      if (sections.some((s) => address < s.address + s.mappedSize && s.address < address + mappedSize)) return null;
      if (rawSize) {
        if (rawOffset < headers || !fits(rawOffset, rawSize)) return null;
        if (rawRanges.some((r) => rawOffset < r.end && r.start < rawOffset + rawSize)) return null;
        rawRanges.push({ start: rawOffset, end: rawOffset + rawSize });
      }
      sections.push({
        address,
        mappedSize,
        bytes: exe.subarray(rawOffset, rawOffset + rawSize),
        characteristics: view.getUint32(entry + 36, true),
      });
    }
    return new PeImageProbe(sections);
  } catch {
    return null;
  }
}
