import type { BattleResult } from '@ra2vm/control/contracts';

/** Serializable game control contract shared by main-thread and Worker execution. */
export interface GameControl {
  request(method: string, params: unknown): unknown;
  /** Retained native local-player result, readable after battlefield teardown. */
  battleResult?(): BattleResult | null;
  dispose(): void;
}
