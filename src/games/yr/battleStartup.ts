import { installYrSkirmishStartup } from './startupPage';
import type { GuestMemory } from '../../vm86/win32';
import { installBattleStartup } from '../shared/battleStartup';

/** YR 1.001: setup-page return point at 0x6ae34e; native game-start handler at 0x6acee0. */
const YR_BATTLE = {
  label: 'YR 战场直达',
  site: 0x006a_e34e,
  handler: 0x006a_cee0,
  navigate: installYrSkirmishStartup,
} as const;

/** Single-player test entry point; neither sends input events nor bypasses option validation or scenario loading. */
export function installYrBattleStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installBattleStartup(memory, reserve, YR_BATTLE);
}
