import type { GuestMemory } from '../../vm86/win32';
import { installStartupTrampoline } from '../shared/startupTrampoline';

const SITE = 0x0052_db12;
const SIGNATURE = [
  0xbe, 0x12, 0, 0, 0, 0xeb, 0x0d, 0x33, 0xc9, 0x83, 0xf8, 0x04, 0x0f, 0x94, 0xc1, 0x83, 0xc1, 0x10, 0x8b, 0xf1,
];
/** Native state uses ESI, unlike RA2's EBP: mov esi, 18 is followed by the final mov esi, ecx. */
const MOV_OPERAND = 0x35;

/**
 * Independent YR 1.001 entry: the skirmish button at 0x52D713 returns 11; dispatch table 0x52EB58 indexes by state+1 to 0x52E10F, sets Session=5, and runs native initialization.
 */
export function installYrSkirmishStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installStartupTrampoline(memory, reserve, {
    label: 'YR 遭遇战直达',
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 11,
  });
}

/** YR's independent main-menu state-3 branch is at 0x52DD75 and stores subsequent state in ESI. */
export function installYrLanStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installStartupTrampoline(memory, reserve, {
    label: 'YR LAN 直达',
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 3,
  });
}
