import type { GameShimProfile } from '../../vm86/shim/gameProfile';

/** RA2/XWIS-specific compatibility capabilities; unlisted behavior never enters the shared shim. */
export const RA2_SHIM_PROFILE: GameShimProfile = Object.freeze({
  shell: Object.freeze({
    // RA2 1.006 score dialog sends UTF-16 labels through SendMessageA at 0x5AAF64 and 0x5AB154.
    controlTextMessage: Object.freeze({ message: 0x4b2, classNames: Object.freeze(['static']) }),
    compositeRgb565Layers: true,
    defaultSourceColorKey: Object.freeze([0, 0] as const),
    titleControlId: 1684,
    initializeComboDropWindow: true,
    topLevelCreateClassNames: Object.freeze(['red alert 2'] as const),
    siblingScrollbarOwner: true,
    globalModifierKeys: true,
    retargetDialogChrome: true,
    mouseViaMessageQueue: true,
    // The title comes from RA2 shell resource scripts (GUI:CampaignMenu); 1109 is the mission template's save ListBox,
    // created with WS_VISIBLE then hidden after initialization; 1770-1772 are the three
    // logo buttons. These are fixed template values registered here alongside the resources.
    campaignMenu: Object.freeze({
      titleKeys: Object.freeze(['campaignmenu'] as const),
      hiddenListControlId: 1109,
      badgeControlIdRange: Object.freeze([1770, 1772] as const),
    }),
  }),
  directDraw: Object.freeze({ guestSurfaceFastPath: true }),
  directPlay: Object.freeze({
    // Native instructions at 0x447790: the enumeration callback immediately returns FALSE when flags bit0 is set. The SDK defines
    // bit0 as enumeration timeout with opposite semantics; follow actual guest behavior and always pass 0.
    enumSessionsCallbackFlags: 0x0000_0000,
    // Early rejection checks in that callback include 0x4c4358, the global session list (reject if 0),
    // and 0x4c4350, the session count (reject if >=0xa). Used only for DPLAY_VERBOSE_LOG diagnostics.
    enumSessionsProbeAddresses: Object.freeze([0x004c_4358, 0x004c_4350] as const),
  }),
  virtualWinsockLan: true,
  cdromVolumeLabel: 'RA2',
});
