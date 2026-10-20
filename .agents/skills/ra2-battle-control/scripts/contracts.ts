/** Public RA2/YR observation and result data, without VM implementation dependencies. */
export interface BattleResult {
  sessionId: string;
  frame: number;
  player: number;
  outcome: 'victory' | 'defeat' | 'unknown';
  source: 'native-game-loop';
}

export interface BattleEntity {
  id: string;
  kind: 'vehicle' | 'infantry' | 'aircraft' | 'building';
  owner: number;
  /** Private status is available only for owned entities. */
  health?: number;
  cell: { x: number; y: number };
  position: { x: number; y: number; z: number };
  mission?: number;
  screen: { x: number; y: number };
  type: string;
  /** Public building footprint dimensions; not placement legality. */
  foundation?: { width: number; height: number };
}

export interface BattleObservation {
  sessionId: string;
  frame: number;
  /** Native local viewport and player visibility only. */
  perspective: 'viewport';
  viewport: { x: number; y: number; width: number; height: number };
  player: number;
  cash: number;
  /** Currently selected native Q/W/E/R production category (0..3). */
  sidebarTab: number;
  production: { type: string; progress: number; total: number; onHold: boolean; suspended: boolean }[];
  sidebar: {
    type: string;
    tab: number;
    progress: number;
    hasFactory: boolean;
    pending: boolean;
    foundation?: { width: number; height: number };
  }[];
  entities: BattleEntity[];
  /** Own powers with actual native sidebar cameos; no enemy cooldown state. */
  supportPowers?: { type: string; tab: number; ready: boolean; onHold: boolean; requiresTarget: boolean }[];
  /** Native player targeting mode, including a subsequent click of a multi-stage power. */
  targetingPower?: string | null;
}
