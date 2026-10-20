import { YR_ABI } from './abi';

/** Signatures required by the MO 3.3.6 Ares/CnCNet runtime imports.
 * Registration is not a claim of implemented APIs: unknown dispatches still
 * fail. Syringe loads cncnet5mo.dll through its native initializer; its CRT imports use the same cdecl contract.
 * The normal YR profile is unchanged.
 */
export const YR_EXTENSION_ABI: Readonly<Record<string, number>> = {
  ...YR_ABI,
  'WSOCK32.DLL!inet_addr': 4,
  ...Object.fromEntries(
    [
      '__dllonexit',
      '_amsg_exit',
      '_initterm',
      '_iob',
      '_lock',
      '_onexit',
      '_unlock',
      'abort',
      'free',
      'fwrite',
      'malloc',
      'calloc',
      'memcpy',
      'memset',
      'strcmp',
      'strlen',
      'strncmp',
      'strtok',
      'vfprintf',
    ].map((name) => [`MSVCRT.DLL!${name}`, 0]),
  ),
  'KERNEL32.DLL!IsProcessorFeaturePresent': 4,
  'KERNEL32.DLL!SetProcessAffinityMask': 8,
  'KERNEL32.DLL!CreateDirectoryW': 8,
  'KERNEL32.DLL!CopyFileW': 12,
  'KERNEL32.DLL!WriteConsoleW': 20,
  'KERNEL32.DLL!ReadConsoleW': 20,
  'KERNEL32.DLL!GetModuleHandleW': 4,
  'KERNEL32.DLL!InitializeSListHead': 4,
  'KERNEL32.DLL!InterlockedFlushSList': 4,
  'KERNEL32.DLL!EncodePointer': 4,
  'KERNEL32.DLL!DecodePointer': 4,
  'KERNEL32.DLL!LoadLibraryExW': 12,
  'KERNEL32.DLL!GetModuleHandleExW': 12,
  'KERNEL32.DLL!GetModuleFileNameW': 12,
  'KERNEL32.DLL!GetConsoleCP': 0,
  'KERNEL32.DLL!FindFirstFileExW': 24,
  'KERNEL32.DLL!FindNextFileW': 8,
  'USER32.DLL!SetClassLongA': 12,
  'USER32.DLL!OffsetRect': 12,
  'USER32.DLL!SetWindowTextW': 8,
  'USER32.DLL!MessageBoxW': 16,
  'DBGHELP.DLL!MiniDumpWriteDump': 28,
};

export function yrExtensionArgBytes(dll: string, name: string): number {
  const key = `${dll.toUpperCase()}!${name}`;
  const bytes = YR_EXTENSION_ABI[key];
  if (bytes === undefined) throw new Error(`Unknown extension ABI: ${key}`);
  return bytes;
}
