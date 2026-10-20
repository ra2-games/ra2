import { installRa2SkirmishStartup } from './startupPage';
import type { GuestMemory } from '../../vm86/win32';
import { installBattleStartup } from '../shared/battleStartup';

/** RA2 1.006: setup-page return point at 0x683c79; native game-start handler at 0x6829f0. */
const RA2_BATTLE = {
  label: 'RA2 战场直达',
  site: 0x0068_3c79,
  handler: 0x0068_29f0,
  navigate: installRa2SkirmishStartup,
} as const;

/** Single-player test entry point; neither sends input events nor bypasses option validation or scenario loading. */
export function installRa2BattleStartup(memory: GuestMemory, reserve: (size: number) => number): number {
  return installBattleStartup(memory, reserve, RA2_BATTLE);
}
