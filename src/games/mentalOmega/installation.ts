import type { GameFileProvider } from '../../resources/contracts';

export const MENTAL_OMEGA_DOWNLOADS = {
  language: 'https://mentalomega.com/game/lang/MentalOmega336ChineseSimplified.rar',
  languageTraditional: 'https://mentalomega.com/game/lang/MentalOmega336ChineseTraditional.rar',
  base: 'https://www.moddb.com/mods/mental-omega/downloads/mental-omega-330',
  patch: 'https://www.moddb.com/mods/mental-omega/downloads/mental-omega-336-patch-manual-update',
};
export const MENTAL_OMEGA_ORIGINAL_FILES = [
  'gamemd.exe',
  'binkw32.dll',
  'blowfish.dll',
  'ra2.mix',
  'ra2md.mix',
  'language.mix',
  'langmd.mix',
] as const;
export type MentalOmegaPackageKind = 'base' | 'patch' | 'language';

/** Identify distribution roles by contents, never by archive filename or selection order. */
export function mentalOmegaPackageKind(names: ReadonlySet<string>): MentalOmegaPackageKind | null {
  if (names.has('expandmo95.mix') && names.has('expandmo96.mix')) return 'base';
  if (names.has('expandmo99.mix') && names.has('ares.dll')) return 'patch';
  if (names.has('expandmo98.mix')) return 'language';
  return null;
}

/** Build a separate installation; never write MOD overrides back into the original YR source. */
export async function assembleMentalOmega(
  original: GameFileProvider,
  base: ReadonlyMap<string, Uint8Array>,
  patch: ReadonlyMap<string, Uint8Array>,
  language: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const name of MENTAL_OMEGA_ORIGINAL_FILES) {
    const bytes = await original.read(name);
    if (bytes === null) throw new Error(`Missing original Yuri's Revenge file: ${name}`);
    files.set(name, bytes);
  }
  for (const layer of [base, patch]) {
    for (const [name, bytes] of layer) {
      // User-supplied original binaries/resources remain authoritative even if an add-on bundles copies.
      if (!(MENTAL_OMEGA_ORIGINAL_FILES as readonly string[]).includes(name)) files.set(name, bytes);
    }
  }
  // Mental Omega 3.3.6 official language archives contain this single optional MIX.
  const translated = language.get('expandmo98.mix');
  if (translated !== undefined) files.set('expandmo98.mix', translated);
  return files;
}
