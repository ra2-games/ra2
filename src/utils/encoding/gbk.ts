/**
 * GBK (cp936) encoding: the narrow-string code page in Chinese Win9x environments.
 * Browsers have no GBK TextEncoder, so reverse-map the built-in TextDecoder('gbk') into a character-to-byte-pair table, about 24,000 entries in a one-time ~1ms initialization, without external dependencies. Printable ASCII maps to its single byte; unencodable characters such as emoji return null.
 */
let reverseMap: Map<string, number[]> | null = null;
let reverseMapUnsupported = false;

function buildGbkReverseMap(): Map<string, number[]> {
  const bytes: number[] = [];
  // GBK double-byte ranges: lead 0x81-0xFE, trail 0x40-0x7E / 0x80-0xFE.
  // Insert ASCII 0x00 between pairs to reset the decoder state; decode once and split at separators,
  // avoiding over 20,000 separate decode calls. Each double-byte sequence in these ranges corresponds to exactly one character.
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      bytes.push(lead, trail, 0);
    }
  }
  const text = new TextDecoder('gbk').decode(Uint8Array.from(bytes));
  const map = new Map<string, number[]>();
  let pair = 0;
  for (const ch of text) {
    if (ch === '\x00') {
      pair++;
      continue;
    }
    if (ch === '�') continue; // Do not map replacement characters for byte pairs the browser cannot decode.
    const lead = 0x81 + Math.floor(pair / 190);
    const offset = pair % 190;
    const trail = offset + 0x40 + (offset >= 63 ? 1 : 0); // Skip trail byte 0x7F.
    if (!map.has(ch)) map.set(ch, [lead, trail]);
  }
  return map;
}

/** Return a character's GBK bytes, or null if unencodable. */
export function gbkBytesOf(char: string): number[] | null {
  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return [code];
  if (reverseMapUnsupported) return null;
  if (!reverseMap) {
    try {
      reverseMap = buildGbkReverseMap();
    } catch {
      // If the environment lacks a GBK decoder, as in very old browsers, Chinese names are unavailable but English names still work.
      reverseMapUnsupported = true;
      return null;
    }
  }
  return reverseMap.get(char) ?? null;
}
