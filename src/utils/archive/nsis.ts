/**
 * Minimal NSIS solid-LZMA installer parser.
 *
 * Reference: 7-Zip CPP/7zip/Archive/Nsis/{NsisIn.cpp,NsisDecode.cpp}, which interprets the full installer-script VM. This module handles only the file-enumeration subset EW_EXTRACTFILE and EW_CREATEDIR(SetOutPath). Format details verified against NSIS-2 observations and 7-Zip source:
 * - Scan the 16-byte signature {EF BE AD DE, NullsoftInst} inside firstheader.
 * - A LZMA-Alone stream immediately follows firstheader, with a 5-byte props+dict header and no length field. Solid output is [u32 header length][header bytes][per-file u32 length + data].
 * - Header: after a leading 4-byte u32, eight {offset:u32, num:u32} entries. Block 2 is the instruction stream, each instruction 28 bytes (which + 6 params); blocks 3/4 bound the string table.
 * - EW_EXTRACTFILE(20): params[1] is the filename-string offset; params[2] is the solid-data offset.
 * - A leading string-table u16 of 0 denotes UTF-16LE; otherwise use ANSI (latin1).
 */
import { normalizeWindowsPath } from '../windowsPath';
import { decodeLzmaStream, decodeLzmaStreamWithConsumed } from './lzmaDecode';

/** 16-byte NSIS signature: little-endian DE AD BE EF plus NullsoftInst. */
const NSIS_SIGNATURE = new Uint8Array([
  0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74,
]);

/** Minimal EW_* subset for 28-byte NSIS instructions: which plus 6 params. */
const EW_CREATEDIR = 11;
const EW_EXTRACTFILE = 20;

/** Byte length of each instruction-stream command. */
const NSIS_COMMAND_BYTES = 4 + 6 * 4;

export interface NsisArchiveInfo {
  /** Header-block byte count declared in firstheader. */
  headerSize: number;
  /** Starting offset of the LZMA stream within the container. */
  streamStart: number;
}

export interface NsisFileEntry {
  /** Normalized guest path. */
  path: string;
  /** Offset of this file's u32 length prefix within decoded solid output. */
  offset: number;
  /** File-content byte count recorded by the u32 length prefix. */
  size: number;
}

/** Locate the NSIS signature in container bytes; null if not an NSIS installer. */
export function findNsisArchive(bytes: Uint8Array): NsisArchiveInfo | null {
  const magic = NSIS_SIGNATURE.subarray(4);
  let search = bytes.indexOf(magic[0]!);
  while (search >= 0) {
    // 16-byte signature: EF BE AD DE plus NullsoftInst; search points at its N,
    // four bytes after signature start. Next are u32 header length at search+12, u32 archive length at search+16,
    // and the LZMA stream at search+20.
    if (matchesAt(bytes, NSIS_SIGNATURE, search - 4) && search + 24 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const headerSize = view.getUint32(search + 12, true);
      // Require plausible header size: at least eight block headers and a minimal string table; cap it to avoid false positives.
      if (headerSize >= 64 && headerSize < 1 << 24) {
        return { headerSize, streamStart: search + 20 };
      }
      return null;
    }
    search = bytes.indexOf(magic[0]!, search + 1);
  }
  return null;
}

function matchesAt(bytes: Uint8Array, pattern: Uint8Array, at: number): boolean {
  if (at < 0 || at + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[at + i] !== pattern[i]) return false;
  }
  return true;
}

/**
 * Header layout: eight {offset,num} block headers begin at header[4]. Standard [u32 header length][header] and flags-first [u32 flags][header] layouts share this start offset.
 */
interface NsisHeaderLayout {
  header: Uint8Array;
  entriesOffset: number;
  entriesNum: number;
  stringsOffset: number;
  langTablesOffset: number;
}

function readNsisHeaderLayout(decoded: Uint8Array): NsisHeaderLayout {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const build = (header: Uint8Array): NsisHeaderLayout | null => {
    if (header.length < 68) return null;
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const blocks: { offset: number; num: number }[] = [];
    for (let i = 0; i < 8; i++) {
      blocks.push({
        offset: headerView.getUint32(4 + i * 8, true),
        num: headerView.getUint32(8 + i * 8, true),
      });
    }
    const entriesBlock = blocks[2]!;
    const stringsOffset = blocks[3]!.offset;
    const langTablesOffset = blocks[4]!.offset;
    if (entriesBlock.num === 0 || entriesBlock.num > 1 << 24) return null;
    if (entriesBlock.offset + entriesBlock.num * NSIS_COMMAND_BYTES > header.length) return null;
    if (langTablesOffset < stringsOffset || langTablesOffset > header.length) return null;
    return {
      header,
      entriesOffset: entriesBlock.offset,
      entriesNum: entriesBlock.num,
      stringsOffset,
      langTablesOffset,
    };
  };
  // Standard layout: u32@0 is header length, followed by the header block.
  const standardSize = view.getUint32(0, true);
  if (standardSize >= 64 && standardSize < 1 << 24 && standardSize + 4 <= decoded.length) {
    const standard = build(decoded.subarray(4, 4 + standardSize));
    if (standard) return standard;
  }
  // Flags-first layout: the entire output is the header block; its leading u32 contains flags in repacked installer variants.
  const flagsFirst = build(decoded);
  if (!flagsFirst) throw new Error('NSIS 头结构无法识别（既非标准也非 flags-first 布局）');
  return flagsFirst;
}

function readNsisString(stringTable: Uint8Array, unicode: boolean, offset: number): string {
  if (offset <= 0 || offset >= stringTable.length) return '';
  const bytes = stringTable.subarray(offset);
  if (unicode) {
    let end = 0;
    while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2;
    return new TextDecoder('utf-16le').decode(bytes.subarray(0, end));
  }
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

/**
 * Parse file listings from decoded solid output. offset points to each file's u32 length prefix; content spans offset+4..offset+4+size. Throw if the NSIS header structure is unrecognized.
 */
export function parseNsisFiles(decoded: Uint8Array): NsisFileEntry[] {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  if (decoded.length < 12) throw new Error('NSIS 解码输出过短');
  const headerSize = view.getUint32(0, true);
  if (headerSize + 4 > decoded.length) throw new Error('NSIS 头长越界');
  const layout = readNsisHeaderLayout(decoded);
  const { header, entriesOffset, entriesNum, stringsOffset, langTablesOffset } = layout;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const stringTable = header.subarray(stringsOffset, langTablesOffset);
  const unicode = stringTable.length >= 2 && stringTable[0] === 0 && stringTable[1] === 0;

  const dataBase = 4 + headerSize;
  const files: NsisFileEntry[] = [];
  let outPath = '';
  const commands = header.subarray(entriesOffset, entriesOffset + entriesNum * NSIS_COMMAND_BYTES);
  for (let i = 0; i < entriesNum; i++) {
    const which = headerView.getUint32(entriesOffset + i * NSIS_COMMAND_BYTES, true);
    const params = new Int32Array(commands.buffer, commands.byteOffset + i * NSIS_COMMAND_BYTES + 4, 6);
    if (which === EW_CREATEDIR && params[0] === 1) {
      // SetOutPath supplies the directory prefix for subsequent ExtractFile instructions.
      const prefix = readNsisString(stringTable, unicode, params[1]);
      outPath = prefix ? normalizeWindowsPath(prefix) : '';
      continue;
    }
    if (which !== EW_EXTRACTFILE) continue;
    const offset = params[2];
    if (offset < 0 || offset + 4 > decoded.length - dataBase) continue;
    const size = view.getUint32(dataBase + offset, true);
    if (size > decoded.length - dataBase - offset - 4) {
      throw new Error(`NSIS 文件长度越界（${readNsisString(stringTable, unicode, params[1])}）`);
    }
    const name = readNsisString(stringTable, unicode, params[1]);
    const path = normalizeWindowsPath(outPath ? `${outPath}/${name}` : name);
    if (!path) continue;
    files.push({ path, offset: dataBase + offset, size });
  }
  return files;
}

/**
 * NSIS string-variable markers such as $INSTDIR/$TEMP: FD prefix plus 1-2 non-ASCII bytes.
 * After latin1 decoding, these occupy arbitrary code points above U+0080, including euro/inverted-exclamation characters.
 */
const NSIS_VARIABLE_MARKER = /[\u00fd][^\u0000-\u007f\\/]{1,2}/g;

/** Two-stage stream file entry: each file has an independent LZMA stream instead of one solid stream. */
export interface NsisSplitFile {
  /** Normalized guest path with variable prefixes removed. */
  path: string;
  /** Offset of this file stream's props relative to the payload start, measured in container bytes. */
  streamOffset: number;
}

/**
 * Enumerate files from a flags-first two-stage header. EW_EXTRACTFILE params[2] now identifies the independent compressed-file stream offset relative to the first data stream, rather than a solid-data offset.
 */
export function parseNsisSplitHeader(headerDecoded: Uint8Array): NsisSplitFile[] {
  const layout = readNsisHeaderLayout(headerDecoded);
  const { header, entriesOffset, entriesNum, stringsOffset, langTablesOffset } = layout;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const stringTable = header.subarray(stringsOffset, langTablesOffset);
  const unicode = stringTable.length >= 2 && stringTable[0] === 0 && stringTable[1] === 0;

  const files: NsisSplitFile[] = [];
  let outPath = '';
  const commands = header.subarray(entriesOffset, entriesOffset + entriesNum * NSIS_COMMAND_BYTES);
  for (let i = 0; i < entriesNum; i++) {
    const which = headerView.getUint32(entriesOffset + i * NSIS_COMMAND_BYTES, true);
    const params = new Int32Array(commands.buffer, commands.byteOffset + i * NSIS_COMMAND_BYTES + 4, 6);
    if (which === EW_CREATEDIR && params[0] === 1) {
      const prefix = readNsisString(stringTable, unicode, params[1]).replace(NSIS_VARIABLE_MARKER, '');
      outPath = prefix ? normalizeWindowsPath(prefix) : '';
      continue;
    }
    if (which !== EW_EXTRACTFILE) continue;
    const name = readNsisString(stringTable, unicode, params[1]).replace(NSIS_VARIABLE_MARKER, '');
    if (!name) continue;
    const path = normalizeWindowsPath(outPath ? `${outPath}/${name}` : name);
    if (!path) continue;
    files.push({ path, streamOffset: params[2] });
  }
  return files;
}

export type NsisDecodedArchive =
  | { kind: 'solid'; output: Uint8Array; files: NsisFileEntry[] }
  | { kind: 'split'; payloadStart: number; files: NsisSplitFile[] };

export interface NsisSplitCollectOptions {
  /** Container bytes: header stream followed by independent per-file streams. */
  bytes: Uint8Array;
  /** Container offset of the first payload stream's props, returned by decodeAndParseNsis. */
  payloadStart: number;
  files: NsisSplitFile[];
  /** Whether to decode an entry: required files or nested-archive candidates; decode duplicate offsets once. */
  isTarget: (path: string) => boolean;
  /** Decoder for one stream, already bounded by the next stream; the caller owns transfer semantics. */
  decode: (stream: Uint8Array) => Promise<Uint8Array>;
  /** Collect decoded output; propagate contract errors, while this function catches and skips corrupt streams. */
  collect: (path: string, bytes: Uint8Array) => Promise<void>;
  onStatus?: (message: string) => void;
}

/**
 * Decode two-stage variants per file, selecting independent LZMA streams by offset. Skip only an individually corrupt file; unlike solid streams, do not abort the whole package and lose later required assets. Observed example: a corrupt movies01.mix stub stream in the YR jb51 installer previously prevented later required ra2md.mix extraction entirely. Resource validation explicitly reports missing required files. Return skipped-entry descriptions as basename plus reason.
 */
export async function decodeNsisSplitFiles(options: NsisSplitCollectOptions): Promise<string[]> {
  const { bytes, payloadStart, files, isTarget, decode, collect, onStatus } = options;
  const seenOffsets = new Set<number>();
  const targets = files
    .filter(
      (file) => file.streamOffset >= 0 && !seenOffsets.has(file.streamOffset) && seenOffsets.add(file.streamOffset),
    )
    .filter((file) => isTarget(file.path))
    .sort((a, b) => a.streamOffset - b.streamOffset);
  const skipped: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const file = targets[i]!;
    const next = targets[i + 1];
    // Bound the view at the next stream's props plus EOS margin; transferInput=false prevents
    // detaching the whole bytes buffer needed for subsequent files.
    const end = next ? Math.min(bytes.length, payloadStart + next.streamOffset + 16) : bytes.length;
    const base = file.path.split(/[\\/]/).pop() ?? file.path;
    onStatus?.(`正在解码 NSIS：${base}…`);
    let out: Uint8Array;
    try {
      out = await decode(bytes.subarray(payloadStart + file.streamOffset, end));
    } catch (error) {
      skipped.push(`${base}（${error instanceof Error ? error.message : String(error)}）`);
      onStatus?.(`NSIS 流损坏，跳过：${base}`);
      continue;
    }
    await collect(file.path, out);
  }
  return skipped;
}

/**
 * Locate the first payload stream's props after the header EOS separator, 1-8 bytes long. Payload and header share compression settings, so props must match. Compare all five props bytes, then prefix-decode and validate the following stream to reject accidentally decodable random data.
 */
async function findPayloadStart(
  stream: Uint8Array,
  from: number,
  headerProps: Uint8Array,
  secondOffset: number | undefined,
): Promise<number> {
  const sameProps = (at: number): boolean => {
    for (let i = 0; i < 5; i++) {
      if (stream[at + i] !== headerProps[i]) return false;
    }
    return true;
  };
  for (let k = 0; k < 16; k++) {
    if (!sameProps(from + k)) continue;
    if (secondOffset !== undefined && !sameProps(from + k + secondOffset)) continue;
    try {
      // Decode a short prefix to confirm a valid stream, including small files.
      await decodeLzmaStream({ stream: stream.subarray(from + k), outputSize: 16 });
      if (secondOffset !== undefined) {
        await decodeLzmaStream({ stream: stream.subarray(from + k + secondOffset), outputSize: 16 });
      }
      return from + k;
    } catch {
      /* Candidate failed; try the next offset. */
    }
  }
  throw new Error('NSIS 载荷起点定位失败（头流后 16 字节内无有效 LZMA 流）');
}

/**
 * Decode NSIS and parse its file table. Standard solid layout returns complete output and per-file offsets; repacked two-stage variants with an EOS-terminated header and independent file streams return payload start and stream offsets. Detect the latter when whole-stream output equals header length exactly while substantial input remains.
 */
export async function decodeAndParseNsis(
  bytes: Uint8Array,
  nsis: NsisArchiveInfo,
  onProgress?: (percent: number) => void,
): Promise<NsisDecodedArchive> {
  for (const delta of [0, 4]) {
    const stream = bytes.subarray(nsis.streamStart + delta);
    const prefixOk = await decodeLzmaStream({
      stream,
      outputSize: nsis.headerSize,
      onProgress,
    }).catch(() => null);
    if (!prefixOk) continue;
    const { output, consumed } = await decodeLzmaStreamWithConsumed({ stream, onProgress });
    if (output.length === nsis.headerSize && consumed + 8 < stream.length) {
      // Two-stage streams: the header stops at EOS; data is in subsequent per-file streams.
      const exact = await decodeLzmaStreamWithConsumed({ stream, outputSize: nsis.headerSize });
      const files = parseNsisSplitHeader(output);
      const sortedOffsets = [...new Set(files.map((file) => file.streamOffset))]
        .filter((offset) => offset >= 0)
        .sort((a, b) => a - b);
      // consumed includes the SDK-added 13-byte LZMA-Alone header; convert to the original stream offset before scanning.
      const payloadStart =
        nsis.streamStart +
        delta +
        (await findPayloadStart(stream, exact.consumed - 13, stream.subarray(0, 5), sortedOffsets[1]));
      return { kind: 'split', payloadStart, files };
    }
    return { kind: 'solid', output, files: parseNsisFiles(output) };
  }
  throw new Error('NSIS solid 流解码失败（LZMA 数据损坏）');
}
