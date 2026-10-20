import type { GuestMemory } from '../../vm86/win32';
import { installStartupTrampoline } from '../shared/startupTrampoline';

const SITE = 0x0051_3762;
const SIGNATURE = [
  0xbd, 0x12, 0, 0, 0, 0xeb, 0x0d, 0x33, 0xc9, 0x83, 0xf8, 0x04, 0x0f, 0x94, 0xc1, 0x83, 0xc1, 0x10, 0x8b, 0xe9,
];
/** Native state is held in EBP: mov ebp, 18 is followed by the final mov ebp, eax. */
const MOV_OPERAND = 0x2d;

/**
 * Original 1.006: Main_Game's initial menu state defaults to EBP=18. The SinglePlayer skirmish button returns 11 at 0x513363; dispatch table 0x5146F4 routes it to 0x513D93. Replace only initial state selection, preserving native setup initialization, message pumping, and return paths.
 */
export function installRa2SkirmishStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installStartupTrampoline(memory, reserve, {
    label: 'RA2 遭遇战直达',
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 11,
  });
}

/**
 * The native main-menu LAN button returns state 3; let the original code set the session and network protocol before entering Lobby. Never select state 16 directly, which skips Session=3 and protocol initialization.
 */
export function installRa2LanStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installStartupTrampoline(memory, reserve, {
    label: 'RA2 LAN 直达',
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 3,
  });
}
