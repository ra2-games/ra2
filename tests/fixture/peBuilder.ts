/**
 * Minimal PE32 builder for tests to generate loadable EXEs without original game assets.
 *
 * Implements only the subset loadPe needs (DOS/PE headers, section table, import directory), but fills every emitted field according to the PE specification. The same artifact works with loadPe in src/vm86/pe.ts and read-only parsers such as peImportKeys.
 */

export interface PeBuilderSection {
  /** Section name of at most 8 bytes, such as .text. */
  name: string;
  /** Section contents (raw file data); VirtualSize equals the content length. */
  data: Uint8Array;
  characteristics: number;
}

export interface PeBuilderImport {
  dll: string;
  names: string[];
}

export interface BuiltPe {
  exe: Uint8Array;
  imageBase: number;
  /** Absolute entry address (imageBase + entryRva). */
  entry: number;
  /** Section name -> RVA. */
  sectionRva: Readonly<Record<string, number>>;
  /** Uppercase DLL!NAME -> absolute IAT slot address (where loadPe installs the stub). */
  iat: ReadonlyMap<string, number>;
}

const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;
const IMAGE_NT_SIGNATURE = 0x0000_4550; // 'PE\0\0'
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_32BIT_MACHINE = 0x0100;
const PE32_MAGIC = 0x10b;
const OPTIONAL_HEADER_SIZE = 0xe0;
const NUMBER_OF_RVA_AND_SIZES = 16;

const align = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

class ByteWriter {
  private bytes: number[] = [];
  get length(): number {
    return this.bytes.length;
  }
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }
  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }
  raw(data: Uint8Array | number[]): this {
    for (const byte of data) this.u8(byte);
    return this;
  }
  ascii(value: string): this {
    for (let i = 0; i < value.length; i++) this.u8(value.charCodeAt(i));
    return this;
  }
  pad(target: number): this {
    while (this.bytes.length < target) this.u8(0);
    if (this.bytes.length > target) throw new Error(`内容越过对齐点: ${this.bytes.length} > ${target}`);
    return this;
  }
  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/**
 * Build a PE32 EXE. Lay out sections in the given order, aligned from RVA 0x1000; the import directory occupies the final section (.idata).
 */
export function buildPe32(options: {
  entryRva: number;
  sections: PeBuilderSection[];
  imports: PeBuilderImport[];
  imageBase?: number;
}): BuiltPe {
  const imageBase = options.imageBase ?? 0x0040_0000;
  const sections = [...options.sections];

  // -- Lay out caller sections, then generate .idata --
  const sectionRva: Record<string, number> = {};
  let nextRva = SECTION_ALIGNMENT;
  for (const section of sections) {
    if (sectionRva[section.name]) throw new Error(`重复 section: ${section.name}`);
    sectionRva[section.name] = nextRva;
    nextRva += align(Math.max(1, section.data.length), SECTION_ALIGNMENT);
  }
  const idataRva = nextRva;
  const idata = buildImportSection(options.imports, idataRva);
  sections.push({
    name: '.idata',
    data: idata.bytes,
    characteristics: 0xc000_0040, // INITIALIZED_DATA | READ | WRITE (the IAT is modified at runtime)
  });
  sectionRva['.idata'] = idataRva;

  const sizeOfImage = idataRva + align(Math.max(1, idata.bytes.length), SECTION_ALIGNMENT);

  // -- Headers: DOS(0x80) + PE signature + COFF + optional header + section table --
  const header = new ByteWriter();
  header.ascii('MZ').pad(0x3c).u32(0x80).pad(0x80);
  header.u32(IMAGE_NT_SIGNATURE);
  header.u16(IMAGE_FILE_MACHINE_I386);
  header.u16(sections.length);
  header.u32(0).u32(0).u32(0); // Timestamp / symbol table
  header.u16(OPTIONAL_HEADER_SIZE);
  header.u16(IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_32BIT_MACHINE);

  const optional = new ByteWriter();
  optional.u16(PE32_MAGIC);
  optional.u8(6).u8(0); // Linker version
  optional.u32(0).u32(0).u32(0); // SizeOfCode/InitializedData/UninitializedData
  optional.u32(options.entryRva); // AddressOfEntryPoint
  optional.u32(sectionRva[sections[0]!.name] ?? 0); // BaseOfCode
  optional.u32(0); // BaseOfData
  optional.u32(imageBase);
  optional.u32(SECTION_ALIGNMENT);
  optional.u32(FILE_ALIGNMENT);
  optional.u16(4).u16(0).u16(0).u16(0).u16(4).u16(0); // OS/image/subsystem versions
  optional.u32(0); // Win32VersionValue
  optional.u32(sizeOfImage);
  const sizeOfHeaders = align(header.length + OPTIONAL_HEADER_SIZE + sections.length * 40, FILE_ALIGNMENT);
  optional.u32(sizeOfHeaders);
  optional.u32(0); // CheckSum
  optional.u16(3); // Subsystem: console (not read by the compatibility layer)
  optional.u16(0); // DllCharacteristics
  optional.u32(0x10_0000).u32(0x1000).u32(0x10_0000).u32(0x1000); // Stack/heap reservation and commitment
  optional.u32(0); // LoaderFlags
  optional.u32(NUMBER_OF_RVA_AND_SIZES);
  optional.u32(0).u32(0); // [0] export
  optional.u32(idataRva).u32(idata.bytes.length); // [1] import
  optional.pad(OPTIONAL_HEADER_SIZE);
  header.raw(optional.toBytes());

  // -- Section table and raw data --
  let nextRaw = sizeOfHeaders;
  const rawOffsets: number[] = [];
  for (const section of sections) {
    rawOffsets.push(nextRaw);
    nextRaw += align(Math.max(1, section.data.length), FILE_ALIGNMENT);
  }
  sections.forEach((section, index) => {
    const name = new ByteWriter();
    name.ascii(section.name.slice(0, 8)).pad(8);
    header.raw(name.toBytes());
    header.u32(section.data.length); // VirtualSize
    header.u32(sectionRva[section.name]!);
    header.u32(section.data.length ? align(section.data.length, FILE_ALIGNMENT) : 0);
    header.u32(section.data.length ? rawOffsets[index]! : 0);
    header.u32(0).u32(0).u16(0).u16(0); // Relocations / line numbers
    header.u32(section.characteristics);
  });
  header.pad(sizeOfHeaders);
  sections.forEach((section, index) => {
    header.pad(rawOffsets[index]!);
    header.raw(section.data);
    // Real PE disk data is padded to FileAlignment; loadPe copies the full SizeOfRawData.
    if (section.data.length) header.pad(rawOffsets[index]! + align(section.data.length, FILE_ALIGNMENT));
  });

  const iat = new Map<string, number>();
  for (const layout of idata.iatLayouts) {
    layout.names.forEach((name, index) => {
      iat.set(`${layout.dll.toUpperCase()}!${name}`, imageBase + layout.iatRva + index * 4);
    });
  }

  return {
    exe: header.toBytes(),
    imageBase,
    entry: imageBase + options.entryRva,
    sectionRva,
    iat,
  };
}

interface IatLayout {
  dll: string;
  names: string[];
  iatRva: number;
}

/** Generate the import-directory section: descriptor table plus per-DLL ILT/IAT/name strings. */
function buildImportSection(
  imports: PeBuilderImport[],
  sectionRvaBase: number,
): {
  bytes: Uint8Array;
  iatLayouts: IatLayout[];
} {
  const out = new ByteWriter();
  const descriptorBytes = (imports.length + 1) * 20;
  let cursor = descriptorBytes;

  const iatLayouts: IatLayout[] = [];
  const bodies: Array<{ rva: number; write: (writer: ByteWriter) => void }> = [];
  for (const { dll, names } of imports) {
    const iltRva = sectionRvaBase + cursor;
    cursor += (names.length + 1) * 4;
    const iatRva = sectionRvaBase + cursor;
    cursor += (names.length + 1) * 4;
    const nameRvas: number[] = [];
    for (const name of names) {
      nameRvas.push(sectionRvaBase + cursor);
      // IMAGE_IMPORT_BY_NAME: 2-byte hint + NUL-terminated name, aligned to 2 bytes.
      cursor += 2 + name.length + 1;
      cursor = align(cursor, 2);
    }
    const dllNameRva = sectionRvaBase + cursor;
    cursor += dll.length + 1;
    iatLayouts.push({ dll, names, iatRva });
    bodies.push({
      rva: iltRva,
      write: (writer) => {
        for (const nameRva of nameRvas) writer.u32(nameRva);
        writer.u32(0);
      },
    });
    bodies.push({
      rva: iatRva,
      write: (writer) => {
        for (const nameRva of nameRvas) writer.u32(nameRva);
        writer.u32(0);
      },
    });
    names.forEach((name, index) => {
      bodies.push({
        rva: nameRvas[index]!,
        write: (writer) => writer.u16(0).ascii(name).u8(0),
      });
    });
    bodies.push({ rva: dllNameRva, write: (writer) => writer.ascii(dll).u8(0) });

    // Descriptors are at the beginning and will be backfilled together later.
    out.u32(iltRva).u32(0).u32(0).u32(dllNameRva).u32(iatRva);
  }
  out.u32(0).u32(0).u32(0).u32(0).u32(0); // Terminating descriptor

  for (const body of bodies) {
    out.pad(body.rva - sectionRvaBase);
    body.write(out);
  }
  return { bytes: out.toBytes(), iatLayouts };
}
