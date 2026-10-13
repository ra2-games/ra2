import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import type { SupportedGameId } from './catalog';

export interface GameResolution {
  width: number;
  height: number;
}

export const GAME_RESOLUTIONS: readonly GameResolution[] = [
  { width: 800, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

export function gameResolutionValue(resolution: GameResolution): string {
  return `${resolution.width}x${resolution.height}`;
}

export function parseGameResolution(value: string | null): GameResolution | null {
  if (!value) return null;
  return GAME_RESOLUTIONS.find((resolution) => gameResolutionValue(resolution) === value) ?? null;
}

export function gameResolutionIni(gameId: SupportedGameId): string {
  return gameId === 'yr' ? 'RA2MD.INI' : 'RA2.INI';
}

const bytesToLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return text;
};

const latin1ToBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
};

/** Preserve the original INI byte encoding and other settings; override only resolution keys in [Video]. */
export function patchGameResolutionIni(bytes: Uint8Array, resolution: GameResolution): Uint8Array {
  const text = bytesToLatin1(bytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.trim()) {
    // If no source INI exists in the online package, generate properly formatted configuration. Leading blank lines or
    // missing trailing newlines make the native INI parser skip [Video], observed to fall back to a 640x400 intro
    // and hang because the transition path cannot exit with a zero-byte movies01.mix.
    return latin1ToBytes(
      `[Video]${newline}AllowHiResModes=yes${newline}` +
        `ScreenWidth=${resolution.width}${newline}ScreenHeight=${resolution.height}${newline}`,
    );
  }
  return patchIniSection(bytes, 'Video', [
    ['AllowHiResModes', 'yes'],
    ['ScreenWidth', String(resolution.width)],
    ['ScreenHeight', String(resolution.height)],
  ]);
}

/**
 * Set keys in one INI section while preserving encoding, newline style, unrelated lines and key order. Keys match
 * case-insensitively and are rewritten in the given canonical spelling; a missing section is appended.
 */
export function patchIniSection(
  bytes: Uint8Array,
  section: string,
  entries: readonly (readonly [key: string, value: string])[],
): Uint8Array {
  const text = bytesToLatin1(bytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  if (trailingNewline) lines.pop();

  const name = section.toLowerCase();
  let sectionStart = lines.findIndex(
    (line) =>
      line
        .match(/^\s*\[([^\]]+)\]\s*$/)?.[1]
        ?.trim()
        .toLowerCase() === name,
  );
  if (sectionStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('');
    sectionStart = lines.length;
    lines.push(`[${section}]`);
  }
  let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (sectionEnd < 0) sectionEnd = lines.length;

  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    const lineIndex = lines.findIndex((line, index) => {
      if (index <= sectionStart || index >= sectionEnd) return false;
      const match = line.match(/^\s*([^=;#]+?)\s*=/);
      return match?.[1]?.trim().toLowerCase() === normalizedKey;
    });
    if (lineIndex >= 0) lines[lineIndex] = `${key}=${value}`;
    else {
      lines.splice(sectionEnd, 0, `${key}=${value}`);
      sectionEnd++;
    }
  }
  return latin1ToBytes(lines.join(newline) + (trailingNewline || !text ? newline : ''));
}

/** Default menu resolution when an online package has no INI: the standard RA2 menu setting. */
const FALLBACK_RESOLUTION: GameResolution = { width: 800, height: 600 };

/** Overlay the game's INI for this session, retaining guest writes locally; supply defaults only when the file is missing. */
export async function withGameResolutionOverride(
  source: GameSource,
  resolution: GameResolution | null | undefined,
): Promise<GameSource> {
  const iniPath = gameResolutionIni(source.game.id);
  const original = await source.files.read(iniPath);
  // Use an existing INI unchanged if no modification was requested, preserving the player's settings and resolution.
  if (!resolution && original !== null) return source;
  // Without an INI in the online package, supply a properly formatted default even without a resolution request; missing,
  // empty, or leading-blank-line INIs cause an observed 640x400 intro fallback and hang.
  const applied = resolution ?? FALLBACK_RESOLUTION;
  const patched = patchGameResolutionIni(original ?? new Uint8Array(), applied);
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[iniPath, patched]]),
      resolution ? `（内存分辨率 ${applied.width}×${applied.height}）` : '（内存默认配置）',
      true,
    ),
  };
}
