export interface GameSourceTransformResult {
  executableBytes: Uint8Array;
  /** Read-only overlay files relative to the game root. */
  overlay: ReadonlyMap<string, Uint8Array>;
  label: string;
}

/** Identify installer/patch wrappers and produce directly bootable game files. */
export type GameSourceTransform = (bytes: Uint8Array) => Promise<GameSourceTransformResult | null>;
