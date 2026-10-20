import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import { gameResolutionIni } from './resolution';
import { gbkBytesOf } from '../utils/encoding/gbk';

/**
 * Generate afresh for each VM instead of reusing shared caches/storage, preventing duplicate default names across tabs.
 * The prefix identifies site players; total length matches the original 15-byte limit: a 10-byte prefix plus 5 base36 digits.
 */
export function randomMultiplayerName(): string {
  let suffix = '';
  while (suffix.length < 5) {
    // 252 = 36 x 7; rejection sampling removes modulo bias.
    const value = crypto.getRandomValues(new Uint8Array(1))[0]!;
    if (value < 252) suffix += (value % 36).toString(36);
  }
  return `ra2.games-${suffix}`;
}

/**
 * The native Handle buffer holds 15 bytes, or 16 including NUL; measure length after GBK encoding.
 * Each Chinese character takes 2 bytes, allowing about 7 characters. Without GBK support, reject Chinese names while retaining English support.
 */
export function validateMultiplayerName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('联机用户名不能为空');
  const bytes: number[] = [];
  for (const ch of name) {
    const encoded = gbkBytesOf(ch);
    if (!encoded) throw new Error('联机用户名含不支持的字符（支持英文、数字、英文符号与中文）');
    bytes.push(...encoded);
  }
  if (bytes.length > 15) throw new Error('联机用户名过长：英文最多 15 个字符，中文最多 7 个');
  return name;
}

export function patchMultiplayerNameIni(bytes: Uint8Array, value: string): Uint8Array {
  const name = validateMultiplayerName(value);
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // Handle uses comma-separated hexadecimal GBK bytes; encode Chinese characters in 2 bytes, never UTF-8.
  const encoded =
    [...name]
      .map((c) => gbkBytesOf(c)!)
      .flat()
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(',') + ',';
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  let inSection = false,
    sectionFound = false,
    written = false;
  const result: string[] = [];
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      if (inSection && !written) {
        result.push(`Handle=${encoded}`);
        written = true;
      }
      inSection = /^\s*\[multiplayer\]\s*$/i.test(line);
      sectionFound ||= inSection;
    }
    if (inSection && /^\s*Handle\s*=/i.test(line)) {
      // Remove duplicate Handle entries to avoid old values; preserve all other fields and bytes.
      if (!written) {
        result.push(`Handle=${encoded}`);
        written = true;
      }
    } else result.push(line);
  }
  if (!sectionFound) result.push('[MultiPlayer]');
  if (!written) result.push(`Handle=${encoded}`);
  if (result.at(-1) !== '') result.push('');
  return Uint8Array.from(result.join(newline), (c) => c.charCodeAt(0));
}

/** Apply after the resolution overlay; write neither to disk nor this tab's name into shared resource caches. */
export async function withMultiplayerNameOverride(source: GameSource, name?: string): Promise<GameSource> {
  if (name === undefined) return source;
  const path = gameResolutionIni(source.game.id);
  const bytes = (await source.files.read(path)) ?? new Uint8Array();
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[path, patchMultiplayerNameIni(bytes, name)]]),
      '（内存联机用户名）',
      true,
    ),
  };
}
