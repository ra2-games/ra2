import type { GameShimProfile } from '../../vm86/shim/gameProfile';
import { RA2_SHIM_PROFILE } from '../ra2/profile';

/**
 * YR shares ordinary Win32 policies with RA2, but must not inherit launcher substitutes
 * or installation credentials. Supplied installation files select direct entry or their native launcher; selection is not verification of ownership or compatibility.
 */
export const YR_SHIM_PROFILE: GameShimProfile = Object.freeze({
  ...RA2_SHIM_PROFILE,
  shell: Object.freeze({
    ...RA2_SHIM_PROFILE.shell,
    // YR 1.001 independently uses the same UTF-16 label protocol at 0x5C9C34 and in its score rows.
    controlTextMessage: Object.freeze({ message: 0x4b2, classNames: Object.freeze(['static']) }),
    topLevelCreateClassNames: Object.freeze(["yuri's revenge"] as const),
  }),
});
