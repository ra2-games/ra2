import type { SupportedGameId } from '../../../games/catalog';
import type { VmPhase } from '../../../app/session/runtimeEvents';

export type CheatEntry =
  | { kind: 'text'; text: string; effect: string; hint: string }
  | { kind: 'key'; label: string; keyCode: string; effect: string; hint: string };
export interface CheatGuide {
  title: string;
  steps: string;
  entries: readonly CheatEntry[];
  notes: readonly string[];
}
export type CheatGuideGameId = SupportedGameId;
export const CHEAT_GUIDES: Partial<Record<SupportedGameId, CheatGuide>> = {};

/** No verified cheat guides are registered for RA2/YR yet. */
export function activeCheatGameForPhase(_game: SupportedGameId | null, _phase: VmPhase): CheatGuideGameId | null {
  return null;
}
