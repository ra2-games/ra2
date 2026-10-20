/**
 * Game compatibility policies describe only differences between guest behavior and Win32 semantics.
 *
 * The shared shim must not identify game IDs, EXE names, or resource directories; it consumes declared capabilities only. New games start from EMPTY_GAME_SHIM_PROFILE and explicitly select compatibility behavior, preventing fixed addresses, registry patches, or fast stubs from leaking between games.
 */

/**
 * Campaign shell compensation: identify page titles and register that page's fixed control IDs. Values come from each game's resource scripts/dialog templates; the generic layer consumes registrations without literal title comparisons or hardcoded IDs.
 */
export interface CampaignMenuCompatibility {
  /** Treat a page as Campaign if its lowercase title contains any registered item. */
  readonly titleKeys: readonly string[];
  /** Save ListBox control ID created with WS_VISIBLE and hidden after initialization. */
  readonly hiddenListControlId: number;
  /** Inclusive logo-button control-ID range for hover-dispatch diagnostics. */
  readonly badgeControlIdRange: readonly [number, number];
}

export interface ShellCompatibility {
  /** Custom control protocol carrying a NUL-terminated UTF-16 label in lParam. Observation only. */
  readonly controlTextMessage?: { readonly message: number; readonly classNames: readonly string[] };
  readonly compositeRgb565Layers?: boolean;
  readonly defaultSourceColorKey?: readonly [number, number];
  readonly titleControlId?: number;
  readonly initializeComboDropWindow?: boolean;
  /** Registered top-level classes that require synchronous WM_CREATE before CreateWindowExA returns. */
  readonly topLevelCreateClassNames?: readonly string[];
  /** Shell pages create independent scrollbars beside their lists as sibling windows; route notifications to the adjacent list. */
  readonly siblingScrollbarOwner?: boolean;
  readonly globalModifierKeys?: boolean;
  readonly retargetDialogChrome?: boolean;
  readonly mouseViaMessageQueue?: boolean;
  /** Without registration, the generic layer applies no Campaign-specific compensation. */
  readonly campaignMenu?: CampaignMenuCompatibility;
}

export interface DirectDrawCompatibility {
  /**
   * Cache DDSURFACEDESC in guest memory and use dedicated Lock/Unlock fast stubs.
   * This enlarges guest COM surface objects and must never apply to games without explicit opt-in.
   */
  readonly guestSurfaceFastPath?: boolean;
}

export interface DirectPlayCompatibility {
  /**
   * dwFlags passed to EnumSessions callbacks. The SDK defines bit0 as enumeration timeout, but this layer replays cached online sessions without timing out, so default to 0. Game modules register actual expectations when guests interpret the bit differently.
   */
  readonly enumSessionsCallbackFlags?: number;
  /**
   * Absolute guest addresses read for enumeration diagnostics: [session-list global, session count].
   * Affects verbose logs only; without registration the generic layer reads no game-global layout.
   */
  readonly enumSessionsProbeAddresses?: readonly [number, number];
}

export interface GuestDllPatch {
  readonly rva: number;
  readonly expected: readonly number[];
  readonly replacement: readonly number[];
}

export interface GameShimProfile {
  readonly shell?: ShellCompatibility;
  readonly directDraw?: DirectDrawCompatibility;
  readonly directPlay?: DirectPlayCompatibility;
  /** Signature-guarded patches for bundled game DLLs, keyed by normalized DLL path; reject loading on mismatch. */
  readonly guestDllPatches?: Readonly<Record<string, readonly GuestDllPatch[]>>;
  /** Permit this project's virtual Winsock LAN; disabled by default. */
  readonly virtualWinsockLan?: boolean;
  /** CD volume label; the shared layer reports neutral CDROM when unregistered. */
  readonly cdromVolumeLabel?: string;
}

export const EMPTY_GAME_SHIM_PROFILE: GameShimProfile = Object.freeze({});
