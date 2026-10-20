import { RA2_ABI } from '../ra2/abi';

/**
 * Yuri's Revenge uses a separate object so additional gamemd.exe ABI/version policies cannot contaminate RA2. Inherit shared Win32 import conventions, including IMM32, from the common RA2 table; list only actual gamemd.exe additions here. Duplicating identical entries would let the tables silently diverge.
 */
export const YR_ABI: Record<string, number> = {
  ...RA2_ABI,
  'KERNEL32.DLL!GetTempFileNameA': 16,
  'IMM32.DLL!ImmAssociateContext': 8,
};

export function yrWin32ArgBytes(dll: string, name: string): number {
  const key = `${dll.toUpperCase()}!${name}`;
  const bytes = YR_ABI[key];
  if (bytes === undefined) throw new Error(`未登记的 Yuri's Revenge Win32 ABI: ${key}`);
  return bytes;
}
